// ---------------------------------------------------------------------------
// 自定义主页脚本的本地仓管与联网校验。
//
// 脚本一律是「单文件 HTML」，存放在 <userData>/homepages/ 下：
//   - 安装：从本地文件导入 / 从主页市场下载 / 投稿后落地服务端回传的已编号脚本。
//   - 读取：返回正文、SHA256、元信息与静态安全检测结果（渲染层据此决定能否运行）。
//   - 外链脚本：静态检测只标记不拒绝，读取时把 .js/.mjs 正文取回，用同一套规则判断。
//   - 校验：有编号的脚本联网核对「编号 + SHA256」，一致才放行；无编号或服务端不可达
//           时回落「本地检测 + 首次确认」。
//   - 确认：按脚本 SHA256 记录用户确认（脚本被改动后确认自动失效）。
//
// 本地不做任何脚本执行，执行由渲染层的 sandbox iframe 承担。
// ---------------------------------------------------------------------------

import { app, dialog, shell } from 'electron'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import type {
  HomepageEntry,
  HomepageExternal,
  HomepageRisk,
  HomepageSource,
  HomepageSubmitPayload,
  HomepageSubmitResult,
  HomepageVerify,
  HomepageVerifyResult,
  MarketScript
} from '@shared/types'
import { analyzeScript, parseHomepageMeta } from './homepage-analyzer'
import { settings } from './store'
import { netRequest } from './broker'
import { streamDownload } from './stream-download'

/** 本地导入的体积上限（服务端投稿上限为 512KB，本地留出余量）。 */
const MAX_LOCAL_SIZE = 2 * 1024 * 1024
/** 从主页市场下载的体积上限。 */
const MAX_MARKET_SIZE = 512 * 1024
/** 本地文件标识白名单：只允许安全字符，杜绝路径穿越。 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 每个脚本的持久状态（按脚本内容哈希绑定，内容一变即失效）。 */
interface StoredState {
  /** 用户已确认运行过的脚本哈希。 */
  confirmedSha: string
  /** 用户已授权联网的脚本哈希。 */
  networkSha: string
  /** 最近一次联网校验结果。 */
  verify: HomepageVerify
}

function homepageDir(): string {
  return join(app.getPath('userData'), 'homepages')
}

function stateFile(): string {
  return join(app.getPath('userData'), 'homepages.json')
}

async function ensureDir(): Promise<string> {
  const dir = homepageDir()
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

async function loadState(): Promise<Record<string, StoredState>> {
  try {
    const raw = await fsp.readFile(stateFile(), 'utf-8')
    const data = JSON.parse(raw) as { state?: Record<string, StoredState> }
    return data.state ?? {}
  } catch {
    return {}
  }
}

async function saveState(state: Record<string, StoredState>): Promise<void> {
  await ensureDir()
  await fsp.writeFile(stateFile(), JSON.stringify({ state }, null, 2), 'utf-8')
}

/** 校验并解析本地文件标识为绝对路径（只允许 homepages 目录内的 .html）。 */
function resolveEntry(id: string): string {
  if (!ID_RE.test(id)) throw new Error('脚本标识非法')
  return join(homepageDir(), `${id}.html`)
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 把任意文件名规整成安全的本地标识。 */
function toLocalId(name: string): string {
  const base = name
    .replace(/\.html?$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[-._]+/, '')
    .slice(0, 48)
  return base || `homepage-${Date.now()}`
}

/** 在同一目录内找一个不冲突的标识。 */
async function uniqueId(preferred: string, excludeId?: string): Promise<string> {
  const dir = await ensureDir()
  const existing = new Set((await fsp.readdir(dir)).map((f) => f.replace(/\.html$/i, '')))
  if (excludeId) existing.delete(excludeId)
  if (!existing.has(preferred)) return preferred
  for (let i = 2; i < 999; i++) {
    const candidate = `${preferred}-${i}`
    if (!existing.has(candidate)) return candidate
  }
  return `${preferred}-${Date.now()}`
}

/** 粗略校验是不是 HTML（避免把任意文件当脚本装进来）。 */
function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 4096).toString('utf-8')
  return /<[a-z!]/i.test(head) || head.includes('@hcpage')
}

/* ------------------------------------------------------------------ */
/* 外链脚本取回核对                                                     */
/* ------------------------------------------------------------------ */

/** 单个外链脚本的核对结论。 */
interface JsVerdict {
  at: number
  /** 命中危险规则的原因（空 = 通过）。 */
  blocks: string[]
  /** 该脚本自身引用的其它外部地址。 */
  externals: HomepageExternal[]
  /** 取回失败的原因；非空表示无法核对。 */
  error: string
}

/** 核对结论缓存时长（同一父脚本内容 + 同一地址才命中）。 */
const JS_CHECK_TTL = 10 * 60 * 1000
/** 单次核对最多取回的外链脚本数量（含嵌套）。 */
const MAX_JS_FETCH = 8
/** 嵌套核对的层数上限。 */
const MAX_JS_DEPTH = 2

const jsVerdicts = new Map<string, JsVerdict>()

/** 取回一个外链脚本并做静态判断；只在取回成功时缓存，失败留给下次重试。 */
async function checkExternalScript(url: string, parentSha: string): Promise<JsVerdict> {
  const key = `${parentSha}\n${url}`
  const hit = jsVerdicts.get(key)
  if (hit && Date.now() - hit.at < JS_CHECK_TTL) return hit
  try {
    if (settings.get().mode === 'local') throw new Error('本地模式已关闭联网功能')
    const text = await netRequest<string>('net:fetchText', { url, maxBytes: MAX_MARKET_SIZE })
    const risk = analyzeScript(text, { library: true })
    const verdict: JsVerdict = {
      at: Date.now(),
      blocks: risk.blocks,
      externals: risk.externals.filter((e) => e.code),
      error: ''
    }
    jsVerdicts.set(key, verdict)
    return verdict
  } catch (err) {
    return {
      at: Date.now(),
      blocks: [],
      externals: [],
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * 外链脚本取回核对：把静态检测中标记为 code 的外链地址取回正文，再用同一套规则判断。
 * 正文命中危险规则 → 拒绝；取不回正文或嵌套过深无法核对 → 同样拒绝（无法核对即不放行）。
 */
async function deepAnalyzeRisk(risk: HomepageRisk, parentSha: string): Promise<HomepageRisk> {
  if (!risk.externals.some((e) => e.code)) return risk

  const blocks = [...risk.blocks]
  const externals: HomepageExternal[] = risk.externals.filter((e) => !e.code)
  const seen = new Set<string>()
  let layer = [...new Set(risk.externals.filter((e) => e.code).map((e) => e.url))]
  let fetched = 0

  for (let depth = 0; depth < MAX_JS_DEPTH && layer.length > 0; depth++) {
    const batch = layer.filter((u) => !seen.has(u))
    for (const u of batch) seen.add(u)
    if (batch.length === 0) break
    if (fetched + batch.length > MAX_JS_FETCH) {
      blocks.push(`外链脚本数量超过核对上限（${MAX_JS_FETCH} 个），无法逐一取回核对：${batch.join('、')}`)
      layer = []
      break
    }
    fetched += batch.length
    const results = await Promise.all(batch.map((u) => checkExternalScript(u, parentSha)))
    const next: string[] = []
    batch.forEach((url, i) => {
      const v = results[i]
      if (v.error) {
        blocks.push(`无法取回外链脚本内容，无法核对安全性：${url}（${v.error}）`)
        return
      }
      if (v.blocks.length > 0) {
        blocks.push(`外链脚本 ${url} 命中危险规则：${v.blocks.join('；')}`)
        return
      }
      externals.push({ url, kind: '外链脚本（内容已核对）' })
      for (const inner of v.externals) {
        if (inner.code) next.push(inner.url)
        else externals.push({ url: inner.url, kind: `外链脚本内的${inner.kind}` })
      }
    })
    layer = next
  }

  if (layer.length > 0) {
    blocks.push(`外链脚本嵌套层级超过核对上限，未取回核对：${[...new Set(layer)].join('、')}`)
  }

  externals.sort((a, b) => a.url.localeCompare(b.url))
  const level: HomepageRisk['level'] = blocks.length > 0 ? 'reject' : externals.length > 0 ? 'warn' : 'safe'
  return { level, blocks, externals: externals.slice(0, 30) }
}

/** 组装一条脚本条目（读取正文 → 元信息 → 静态检测 → 结合持久状态）。 */
async function buildEntry(
  id: string,
  state: Record<string, StoredState>,
  deep = false
): Promise<HomepageSource> {
  const file = resolveEntry(id)
  const buf = await fsp.readFile(file)
  const content = buf.toString('utf-8')
  const hash = sha256(buf)
  const stat = await fsp.stat(file)
  const meta = parseHomepageMeta(content, id)
  let risk = analyzeScript(content)
  // 静态已判拒绝时结论不会再变，不必再去取回外链脚本正文。
  if (deep && risk.level !== 'reject') risk = await deepAnalyzeRisk(risk, hash)
  const st = state[id] ?? { confirmedSha: '', networkSha: '', verify: 'unchecked' as HomepageVerify }
  return {
    id,
    meta,
    sha256: hash,
    size: buf.byteLength,
    installedAt: Math.round(stat.mtimeMs),
    risk,
    // 无编号脚本天然走本地流程，不必显示「未校验」。
    verify: meta.id === '' ? 'local' : st.verify,
    confirmed: st.confirmedSha === hash,
    networkApproved: st.networkSha === hash,
    active: settings.get().homepageId === id,
    content
  }
}

function stripContent(entry: HomepageSource): HomepageEntry {
  const { content: _content, ...rest } = entry
  return rest
}

/** 列出本地全部主页脚本（按修改时间倒序）。 */
export async function listHomepages(): Promise<HomepageEntry[]> {
  const dir = await ensureDir()
  const state = await loadState()
  const files = (await fsp.readdir(dir)).filter((f) => /\.html$/i.test(f))
  const entries: HomepageEntry[] = []
  for (const f of files) {
    try {
      entries.push(stripContent(await buildEntry(f.replace(/\.html$/i, ''), state)))
    } catch {
      /* 单个脚本读取失败（被外部删除 / 损坏）不影响其余列表 */
    }
  }
  return entries.sort((a, b) => b.installedAt - a.installedAt)
}

/**
 * 读取单个脚本（含正文与检测结果）。
 * 深检（取回外链脚本正文核对）只在真正要运行时做；列表页用浅检，避免翻页时发起网络请求。
 */
export async function readHomepage(id: string): Promise<HomepageSource> {
  return buildEntry(id, await loadState(), true)
}

/** 把一段脚本字节落到本地仓（供导入 / 下载 / 投稿回传复用）。 */
async function writeHomepage(
  suggestedName: string,
  buf: Buffer,
  limit: number,
  replaceId?: string
): Promise<HomepageEntry> {
  if (buf.byteLength === 0) throw new Error('脚本内容为空')
  if (buf.byteLength > limit) {
    throw new Error(`脚本体积超出上限（${Math.round(limit / 1024)}KB）`)
  }
  if (!looksLikeHtml(buf)) throw new Error('该文件不是有效的 HTML 主页脚本')
  const dir = await ensureDir()
  const id = replaceId ?? (await uniqueId(toLocalId(suggestedName)))
  await fsp.writeFile(join(dir, `${id}.html`), buf)
  const { content: _content, ...entry } = await buildEntry(id, await loadState())
  return entry
}

/** 打开文件选择器导入本地脚本；用户取消返回 null。 */
export async function importHomepage(): Promise<HomepageEntry | null> {
  const picked = await dialog.showOpenDialog({
    title: '选择主页脚本',
    properties: ['openFile'],
    filters: [
      { name: '主页脚本', extensions: ['html', 'htm'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  })
  if (picked.canceled || picked.filePaths.length === 0) return null
  const file = picked.filePaths[0]
  const buf = await fsp.readFile(file)
  return writeHomepage(file.split(/[\\/]/).pop() ?? 'homepage.html', buf, MAX_LOCAL_SIZE)
}

/** 从主页市场下载脚本并安装。 */
export async function downloadHomepage(url: string, filename: string): Promise<HomepageEntry> {
  if (!/^https:\/\//i.test(url)) throw new Error('仅支持从 https 地址下载主页脚本')
  const id = `${toLocalId(filename || 'homepage.html')}-${Date.now().toString(36)}`
  const dest = resolveEntry(id)
  await ensureDir()
  await streamDownload(url, dest, {})
  try {
    const buf = await fsp.readFile(dest)
    if (buf.byteLength > MAX_MARKET_SIZE) throw new Error('市场脚本体积超出上限（512KB）')
    if (!looksLikeHtml(buf)) throw new Error('下载到的文件不是有效的 HTML 主页脚本')
    const { content: _content, ...entry } = await buildEntry(id, await loadState())
    return entry
  } catch (err) {
    await fsp.rm(dest, { force: true })
    throw err
  }
}

/** 删除脚本（同时清掉它的确认记录；若是当前启用的主页则退回内置界面）。 */
export async function removeHomepage(id: string): Promise<void> {
  const file = resolveEntry(id)
  await fsp.rm(file, { force: true })
  const state = await loadState()
  if (state[id]) {
    delete state[id]
    await saveState(state)
  }
  if (settings.get().homepageId === id) settings.set({ homepageId: '' })
}

/**
 * 联网核对「编号 + SHA256」。
 * 一致 → verified；不一致（含编号不存在）→ mismatch（渲染层拒绝运行）；
 * 无编号 → local；服务端不可达 → 视为未校验，回落本地流程。
 */
export async function verifyHomepage(id: string): Promise<HomepageVerifyResult> {
  const source = await readHomepage(id)
  const state = await loadState()
  const st = state[id] ?? { confirmedSha: '', networkSha: '', verify: 'unchecked' as HomepageVerify }

  if (source.risk.level === 'reject') {
    return { entry: stripContent(source), reachable: true, message: '静态检测未通过，已拒绝运行' }
  }
  if (source.meta.id === '') {
    st.verify = 'local'
    state[id] = st
    await saveState(state)
    const entry = await readHomepage(id)
    return { entry: stripContent(entry), reachable: true, message: '无编号脚本：仅做本地检测，首次运行需你确认' }
  }

  try {
    const res = await netRequest<{ ok?: boolean; verified?: boolean }>('server:api', {
      path: `script_verify&id=${encodeURIComponent(source.meta.id)}&sha256=${source.sha256}`
    })
    const verified = res?.verified === true
    st.verify = verified ? 'verified' : 'mismatch'
    state[id] = st
    await saveState(state)
    return {
      entry: stripContent(await readHomepage(id)),
      reachable: true,
      message: verified
        ? `联网校验通过：编号 ${source.meta.id} 与脚本哈希一致`
        : `联网校验未通过：编号 ${source.meta.id} 与脚本哈希不一致，脚本可能已被改动`
    }
  } catch (err) {
    // 服务端不可达：按无编号脚本流程处理（本地检测 + 首次确认），不阻断使用。
    return {
      entry: stripContent(source),
      reachable: false,
      message: `无法连接验证服务（${err instanceof Error ? err.message : String(err)}），将按无编号脚本流程处理`
    }
  }
}

/** 记录用户对当前脚本内容的确认；network=true 时同时授权联网能力。 */
export async function confirmHomepage(id: string, network: boolean): Promise<HomepageEntry> {
  const source = await readHomepage(id)
  if (source.risk.level === 'reject') throw new Error('该脚本未通过静态安全检测，不允许运行')
  const state = await loadState()
  const st = state[id] ?? { confirmedSha: '', networkSha: '', verify: source.verify }
  st.confirmedSha = source.sha256
  if (network) st.networkSha = source.sha256
  state[id] = st
  await saveState(state)
  return stripContent(await readHomepage(id))
}

/** 设置当前启用的主页（空串 = 回到内置界面）。 */
export async function setActiveHomepage(id: string): Promise<void> {
  if (id === '') {
    settings.set({ homepageId: '' })
    return
  }
  const source = await readHomepage(id)
  if (source.risk.level === 'reject') throw new Error('该脚本未通过静态安全检测，不能设为默认主页')
  settings.set({ homepageId: id })
}

/** 拉取主页市场列表。 */
export async function fetchMarket(): Promise<MarketScript[]> {
  const res = await netRequest<{ scripts?: MarketScript[] }>('server:api', { path: 'market_list' })
  return Array.isArray(res?.scripts) ? res.scripts : []
}

/** 自助投稿：把脚本原文交给服务端分配编号并回传已编号脚本。 */
export async function submitHomepage(payload: HomepageSubmitPayload): Promise<HomepageSubmitResult> {
  const raw = Buffer.from(payload.contentBase64, 'base64')
  if (raw.byteLength === 0) throw new Error('脚本内容为空')
  if (raw.byteLength > MAX_MARKET_SIZE) throw new Error('投稿脚本体积超出上限（512KB）')
  const res = await netRequest<
    Partial<HomepageSubmitResult> & { content_base64?: string; error?: string }
  >('server:post', {
    path: 'market_submit',
    body: {
      filename: payload.filename,
      content_base64: payload.contentBase64,
      name: payload.name,
      author: payload.author,
      description: payload.description,
      version: payload.version,
      visibility: payload.visibility
    }
  })
  // 服务端以 snake_case 回传脚本正文，这里统一成 camelCase 供渲染层使用。
  const contentBase64 = res?.contentBase64 ?? res?.content_base64
  if (!res?.id || !contentBase64) throw new Error(res?.error || '服务端未返回编号，投稿失败')
  return {
    id: res.id,
    sha256: res.sha256 ?? '',
    visibility: res.visibility ?? payload.visibility,
    contentBase64
  }
}

/** 把服务端回传的已编号脚本安装到本地（保持编号与哈希可校验）。 */
export async function installNumbered(input: {
  filename: string
  contentBase64: string
  replaceId?: string
}): Promise<HomepageEntry> {
  const buf = Buffer.from(input.contentBase64, 'base64')
  return writeHomepage(input.filename, buf, MAX_MARKET_SIZE, input.replaceId)
}

/** 打开主页脚本目录。 */
export async function openHomepageDir(): Promise<string> {
  const dir = await ensureDir()
  await shell.openPath(dir)
  return dir
}

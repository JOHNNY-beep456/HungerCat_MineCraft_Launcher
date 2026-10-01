// ---------------------------------------------------------------------------
// 自定义主页脚本的「危险代码」规则表与扫描器。
//
// 只在主进程用（安装时 / 每次读取时）不够：脚本可以在运行时用字符串拼接绕过静态
// 匹配（例如把 "eval" 拆成两半、动态 createElement('script')、document.write 注入），
// 所以规则表必须同时被渲染层复用，用于「每个元素加载 / 每条指令运行」前的运行时检查。
//
// 因此把规则表放在 @shared 下，由两处共用同一份定义：
//   - src/main/homepage-analyzer.ts：静态检测（安装与读取时）→ 决定能否运行；
//   - src/renderer/src/pages/CustomHomePage.tsx：运行时检测（元素/指令）→ 命中即封锁。
//
// 拦截范围即需求里的四类：删除文件、修改文件、格式化、伪装代码。
// ---------------------------------------------------------------------------

export interface HomepageBlockRule {
  /** 命中即判定为危险的正则（不得带 g 标志，否则 lastIndex 会串味）。 */
  re: RegExp
  /** 面向用户的中文原因。 */
  reason: string
  /** 分析第三方脚本库正文时跳过：UMD 包装普遍含 require / module.exports / process.env。 */
  skipInLibrary?: boolean
  /**
   * 扫描「任意数据载荷」（指令参数、日志正文等）时跳过。
   * 这类规则属于启发式的「疑似编码块」判断，对正常数据容易误判，
   * 只适合扫代码；对载荷误判会直接把正常主页封掉，代价太高。
   */
  skipInPayload?: boolean
}

/** 命中即「拒绝运行 / 立即封锁」的规则。 */
export const HOMEPAGE_BLOCK_RULES: HomepageBlockRule[] = [
  // --- 删除文件 / 格式化 ---
  { re: /\brm\s+-[a-z]*[rf][a-z]*\s/i, reason: '包含删除文件的 shell 命令（rm -rf）' },
  // 先用 alias 把删除命令改名，再以别名调用：`alias aa="rm"` + `aa -rf /`。
  // 上面的字面规则只看得到 rm 本身，别名形态必须单独拦截（B02 / B06 / B08）。
  {
    re: /\balias\s+[A-Za-z0-9_.-]+\s*=\s*["']?\s*(?:rm|del|erase|rmdir|rd|Remove-Item)\b/i,
    reason: '定义指向删除命令的 shell 别名（疑似规避检测的伪装代码）'
  },
  // 递归强制删除根目录的参数（-rf / -fr / -Rf …），无论命令名是否被别名替换。
  {
    re: /(?:^|\s)-[a-z]*[rf][a-z]*[rf][a-z]*\s+\/(?:\s|$|["'`])/i,
    reason: '包含递归强制删除根目录的命令参数'
  },
  { re: /\b(?:rmdir|rd\s+\/s)\s|\bdel\s+\/[a-z]|\berase\s+[a-z]:/i, reason: '包含删除文件或目录的命令' },
  {
    re: /\bformat\s+[a-z]:|diskpart|\bmkfs(?:\.\w+)?\b|diskutil\s+erase|Clear-Disk|Format-Volume|shutdown\s+\/|\bwipefs\b/i,
    reason: '包含格式化磁盘或破坏系统的命令'
  },
  {
    re: /Remove-Item|shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir|subprocess|child_process|execSync|spawnSync|execFileSync/i,
    reason: '包含删除文件或执行系统命令的代码'
  },
  {
    re: /fs\.(?:unlink|rm|rmdir|truncate)(?:Sync)?\s*\(|(?:unlink|rmdir|rm)Sync\s*\(|deleteFile\s*\(/,
    reason: '包含删除文件的文件系统调用'
  },
  // --- 修改 / 写入文件 ---
  {
    re: /(?:\b(?:fs|fsp|fsPromises|gracefulFs|nodeFs)\s*\.\s*)(?:writeFile|appendFile|rename|copyFile|cp|chmod|chown|mkdir|truncate|createWriteStream)(?:Sync)?\s*\(/i,
    reason: '包含写入 / 修改本地文件的文件系统调用'
  },
  {
    re: /\b(?:writeFile|appendFile|rename|copyFile|chmod|chown|mkdir|truncate|open|close|write)Sync\s*\(/,
    reason: '包含写入 / 修改本地文件的同步调用'
  },
  { re: /\bcreateWriteStream\s*\(/, reason: '包含写入本地文件的流式调用' },
  {
    re: /\b(?:Set-Content|Add-Content|Out-File|New-Item|Move-Item|Copy-Item|Rename-Item|Set-ItemProperty|Clear-Content)\b/i,
    reason: '包含修改本地文件的 PowerShell 命令'
  },
  // 命令名前不得是 `-` 或单词字符：否则会把 JVM 的 `-cp "C:\…"`（classpath 参数）
  // 误认成 Unix 的 cp 命令——启动命令 / 调试日志里普遍带 `-cp`，会造成大量误报（F-16）。
  {
    re: /(?<![-\w])(?:mv|cp|move|copy|xcopy|robocopy)\s+["']?[a-z]:[\\/]/i,
    reason: '包含移动 / 复制本地文件的命令'
  },
  {
    re: /FileSystemFileHandle|createWritable\s*\(|showDirectoryPicker|requestFileSystem|\bFileWriter\b/,
    reason: '尝试直接读写本地文件'
  },
  // --- Node / 进程能力 ---
  {
    re: /\brequire\s*\(\s*['"]|\bmodule\.exports\b|process\.binding|globalThis\.process|process\.env\b|process\.mainModule/,
    reason: '尝试访问 Node 运行时能力',
    skipInLibrary: true
  },
  // --- 动态执行 / 混淆伪装 ---
  { re: /\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(\s*['"`]/i, reason: '包含动态执行代码（eval / new Function），属疑似伪装代码' },
  // 以字符串下标访问敏感 API：window['eval'] / d['write'] / window['atob'] 等写法，
  // 专门用来躲开上面的字面规则（F-09 / F-10 / F-11 的共同手法）。
  {
    re: /\[\s*["'`]\s*(?:eval|atob|btoa|write|writeln|Function|constructor|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|execScript)\s*["'`]\s*\]/i,
    reason: '以字符串下标访问敏感 API（疑似规避检测的伪装代码）'
  },
  // 构造器链访问：constructor.constructor、__proto__[、Object.getPrototypeOf(function)、
  // (function(){}).constructor(...) —— 都能拿回被 CSP 限制的动态执行能力（F-09）。
  {
    re: /constructor\s*\.\s*constructor|__proto__\s*\[|Object\.getPrototypeOf\s*\(\s*function|\}\s*\)\s*\.\s*constructor|\)\s*\.\s*constructor\s*\(\s*["'`]/i,
    reason: '包含绕过沙箱的构造器链访问（疑似伪装代码）'
  },
  // document.write / writeln 会重写整个页面并按字符串注入内容，是典型的伪装手法。
  // 不再用「调用后 400 字符内出现 <script」这种带窗口的判定——垫长参数即可绕过（F-10），
  // 因此任何形式的调用（含 document['write']）一律拒绝。
  {
    re: /document\s*(?:\.\s*write(?:ln)?\s*\(|\[\s*["'`]\s*write(?:ln)?\s*["'`]\s*\]\s*\()/i,
    reason: '使用 document.write / writeln 重写页面并注入内容（疑似伪装代码）'
  },
  { re: /(?:atob|unescape|decodeURIComponent)\s*\([\s\S]{0,120}?(?:eval|Function|document\.write|innerHTML|outerHTML)/i, reason: '对编码字符串做动态执行（疑似混淆代码）' },
  { re: /setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/, reason: '以字符串形式延迟执行代码（疑似混淆代码）' },
  { re: /[A-Za-z0-9+/]{400,}={0,2}/, reason: '包含超长的疑似混淆编码块（Base64）', skipInPayload: true },
  { re: /(?:\\x[0-9a-f]{2}){6,}/i, reason: '包含大量十六进制转义（疑似混淆代码）', skipInPayload: true },
  { re: /(?:\\u[0-9a-f]{4}){6,}/i, reason: '包含大量 Unicode 转义（疑似混淆代码）', skipInPayload: true },
  { re: /String\.fromCharCode\s*\((?:\s*\d+\s*,){4,}/, reason: '拼接字符编码还原字符串（疑似混淆代码）' },
  { re: /CreateTextFile|OpenTextFile|ActiveXObject|WScript\.|FileSystemObject/i, reason: '包含脚本宿主（WScript / ActiveX）的文件操作（疑似伪装代码）' },
  // --- 伪装界面 / 隐藏真实行为 ---
  { re: /<iframe\b/i, reason: '包含页面嵌套（iframe），常用于伪装界面' },
  { re: /<script[^>]*\bsrc\s*=\s*["']?\s*data:/i, reason: '以内联 data: 形式加载脚本（疑似伪装代码）' },
  { re: /new\s+Image\s*\(\s*\)\s*\.\s*src\s*=\s*['"`]?https?:/i, reason: '通过图片对象隐蔽发起外部请求（疑似伪装行为）' },
  // --- 触发文件下载 ---
  {
    re: /URL\.createObjectURL|\.download\s*=\s*['"`]|createElement\s*\(\s*['"`]a['"`]\s*\)[\s\S]{0,120}?\.click\s*\(/i,
    reason: '包含触发文件下载的代码'
  },
  { re: /showSaveFilePicker|webkitRequestFileSystem|\bIndexedDB\b[\s\S]{0,60}?open\s*\(/i, reason: '尝试直接读写本地文件' }
]

/** 扫描范围：code=脚本/元素标记；library=取回的第三方脚本库正文；payload=指令参数等任意数据。 */
export type HomepageScanScope = 'code' | 'library' | 'payload'

/** 运行时最多扫描的字符数：防止超长文本拖垮渲染层。 */
const MAX_SCAN_LENGTH = 32_000

/**
 * 折叠内联的 base64 data URI（脚本里嵌的图片等），否则会被「超长编码块」规则误判。
 * 真正的内联脚本仍由 `<script src="data:…">` 规则拦截。
 */
function collapseInlineBase64(source: string): string {
  return source.replace(/data:[^"'`)\s]*base64,[A-Za-z0-9+/=\s]*/gi, 'data:…')
}

/**
 * 把相邻的字符串字面量拼接合并成一个（`'r' + 'm'` → `'rm'`）。
 *
 * 拆字面量是最常用的静态绕过手法：把 `rm -rf /`、`<script>`、被禁 API 名拆成多段再用 + 拼起来，
 * 静态正则就看不到完整的关键字。合并后再扫一遍即可还原（F-01）。
 */
export function mergeAdjacentLiterals(source: string): string {
  let out = source
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/["'`]\s*\+\s*["'`]/g, '')
    if (next === out) break
    out = next
  }
  return out
}

/** 扫描参数。 */
export interface HomepageScanOptions {
  /**
   * 最多扫描的字符数；0 表示不截断。
   * 静态检测传 0：脚本落地时已有体积上限（2MB），截断反而给了「把载荷放在上限之后」的绕过空间（F-01）。
   */
  maxLength?: number
}

/**
 * 按 maxLength 截断源文本（0 = 不截断）。
 * 静态检测传 0：脚本落地时已有体积上限（2MB），截断反而给了「把载荷放在上限之后」的绕过空间（F-01）。
 */
function boundSource(source: string, options?: HomepageScanOptions): string {
  const limit = options?.maxLength ?? MAX_SCAN_LENGTH
  return limit > 0 && source.length > limit ? source.slice(0, limit) : source
}

/**
 * 生成要扫描的文本变体。
 *
 * code / library 会额外扫一份「合并相邻字面量」后的文本，用于还原 `'r' + 'm'` 这类拆字绕过；
 * payload（指令参数等任意数据）只扫原文，避免启发式规则误判正常数据。
 */
function scanVariants(bounded: string, scope: HomepageScanScope): string[] {
  return scope === 'payload'
    ? [bounded]
    : [collapseInlineBase64(bounded), collapseInlineBase64(mergeAdjacentLiterals(bounded))]
}

/**
 * 按 scope 过滤出真正要跑的规则。
 * 同步 / 异步两个扫描器共用，保证「该跳过的规则」两边完全一致、不会漂移出漏检。
 */
function* activeRules(scope: HomepageScanScope): Generator<HomepageBlockRule> {
  for (const rule of HOMEPAGE_BLOCK_RULES) {
    if (scope === 'library' && rule.skipInLibrary) continue
    if (scope === 'payload' && rule.skipInPayload) continue
    yield rule
  }
}

/**
 * 用统一规则表同步扫描一段文本，返回命中的中文原因（去重）。
 *
 * 纯函数：主进程的静态检测与渲染层的运行时检测共用，保证两处判定一致。
 * code 范围会扫「原文」与「合并相邻字面量后的文本」两份，用于还原拆字躲避。
 *
 * 同步版适合短文本（指令参数、单条日志等）。长文本请用 scanHomepageCodeAsync，
 * 否则会在扫描期间占满主线程 / 渲染线程。
 */
export function scanHomepageCode(
  source: string,
  scope: HomepageScanScope = 'code',
  options?: HomepageScanOptions
): string[] {
  if (!source) return []
  const variants = scanVariants(boundSource(source, options), scope)
  const blocks: string[] = []
  for (const rule of activeRules(scope)) {
    if (variants.some((v) => rule.re.test(v)) && !blocks.includes(rule.reason)) blocks.push(rule.reason)
  }
  return blocks
}

/** 单调时钟：用于控制每片扫描占用主线程的时长。 */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/**
 * 让出一次事件循环，让界面 / IPC 有机会处理其它任务。
 * 优先用原生调度器 scheduler.yield（Chromium 新版本），否则退化到 setImmediate（主进程）/ setTimeout。
 */
function yieldToEventLoop(): Promise<void> {
  const g = globalThis as unknown as {
    scheduler?: { yield?: () => Promise<void> }
    setImmediate?: (cb: () => void) => void
  }
  if (typeof g.scheduler?.yield === 'function') return g.scheduler.yield()
  return new Promise<void>((resolve) => {
    if (typeof g.setImmediate === 'function') g.setImmediate(resolve)
    else setTimeout(resolve, 0)
  })
}

/** 每片扫描最多占用主线程的毫秒数：超过即让出事件循环，避免长任务造成界面卡顿。 */
const SCAN_SLICE_MS = 8

/**
 * scanHomepageCode 的异步版：**判定完全一致**（同一份规则表、同一份变体生成、同一套去重），
 * 只是把「连续扫完所有规则」拆成若干片，每片最多占用 SCAN_SLICE_MS 毫秒就 `await` 让出事件循环。
 *
 * 因此异步化只改变「何时给出结论」，不改变「给出什么结论」——不会因为让出事件循环而漏检：
 *   - 规则、变体、截断策略与同步版逐字一致（共用 activeRules / scanVariants）；
 *   - 每个变体都是完整字符串，`rule.re.test()` 是整串匹配，不存在被切片切断而漏掉的关键字；
 *   - 让出点只在「两条规则之间」，任何时候被中断都只是暂停，恢复后从下一条继续。
 *
 * 用于两处重活：主进程的静态检测（安装 / 读取时扫整份脚本）与渲染层的运行时探针
 * （逐元素扫描动态写入的源码）。
 */
export async function scanHomepageCodeAsync(
  source: string,
  scope: HomepageScanScope = 'code',
  options?: HomepageScanOptions
): Promise<string[]> {
  if (!source) return []
  const variants = scanVariants(boundSource(source, options), scope)
  const blocks: string[] = []
  let sliceStart = now()
  for (const rule of activeRules(scope)) {
    if (variants.some((v) => rule.re.test(v)) && !blocks.includes(rule.reason)) blocks.push(rule.reason)
    if (now() - sliceStart >= SCAN_SLICE_MS) {
      sliceStart = now()
      await yieldToEventLoop()
    }
  }
  return blocks
}

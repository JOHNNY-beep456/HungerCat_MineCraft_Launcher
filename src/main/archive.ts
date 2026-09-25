// 内嵌压缩包读写：zip（列出 / 读取 / 解压 / 打包）与 tar、tar.gz（列出 / 读取 / 解压）。
//
// 此前依赖系统 bsdtar 子进程，其 Windows 版通过 ANSI 入口读取命令行参数，路径里的非 ASCII
// 字符（Emoji 等星平面字符）会被替换成 `?`，随即报「Failed to open」，使整合包探测 / 解压
// 失败。内置实现直接用 Node 的文件 API，不受命令行编码限制，也不再依赖外部命令。
//
// 性能约束：所有压缩 / 解压一律走异步 API（zlib 异步接口与流式管道跑在 libuv 线程池）或分片
// 让出事件循环，绝不在主进程事件循环里做整块 inflate / deflate / CRC，否则点一下安装就会
// 让窗口卡住（主进程被占满时 Electron 的窗口消息无人处理，表现为「未响应」）。
import { createReadStream, createWriteStream, promises as fsp } from 'fs'
import { once } from 'events'
import { dirname, join } from 'path'
import type { FileHandle } from 'fs/promises'
import type { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { createGunzip, createInflateRaw, deflateRaw, inflateRaw } from 'zlib'

/* ------------------------------------------------------------------ */
/* 公共 API                                                            */
/* ------------------------------------------------------------------ */

/** 列出压缩包内所有条目（目录条目也在内），名字统一 `\` → `/` 并去掉开头的 `./`。 */
export async function listArchive(file: string): Promise<string[]> {
  const zip = await openZip(file)
  if (zip) {
    try {
      // 归档根的 `./` 条目归一化后为空名，与旧 tar -tf 的输出一样丢弃
      return zip.entries.map((e) => e.name).filter((name) => name !== '')
    } finally {
      await zip.fh.close()
    }
  }
  const names: string[] = []
  await walkTar(file, async (entry) => {
    if (entry.name) names.push(entry.name)
  })
  return names
}

/** 读取压缩包内单个条目的文本内容（按 UTF-8 解码）。 */
export async function readArchiveText(file: string, entry: string): Promise<string> {
  const zip = await openZip(file)
  if (zip) {
    try {
      const found = zip.entries.find((e) => e.name === entry)
      if (!found) throw new Error(`压缩包内未找到条目：${entry}`)
      return (await readZipEntryData(zip.fh, found)).toString('utf8')
    } finally {
      await zip.fh.close()
    }
  }

  let text: string | null = null
  await walkTar(file, async (e) => {
    if (text !== null || e.isDir || e.name !== entry) return
    const chunks: Buffer[] = []
    for (;;) {
      const chunk = await e.readChunk(1 << 20)
      if (chunk.length === 0) break
      chunks.push(chunk)
    }
    text = Buffer.concat(chunks).toString('utf8')
  })
  if (text === null) throw new Error(`压缩包内未找到条目：${entry}`)
  return text
}

/** 解压压缩包全部内容到 dest 目录（自动识别 zip / tar / tar.gz）。 */
export async function extractArchive(file: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  const zip = await openZip(file)
  if (zip) {
    try {
      for (const e of zip.entries) {
        const target = safeJoin(dest, e.name)
        if (!target) continue
        if (e.isDir) {
          await fsp.mkdir(target, { recursive: true })
          continue
        }
        await fsp.mkdir(dirname(target), { recursive: true })
        await writeZipEntry(file, zip.fh, e, target)
      }
    } finally {
      await zip.fh.close()
    }
    return
  }

  await walkTar(file, async (entry) => {
    const target = safeJoin(dest, entry.name)
    if (!target) return
    if (entry.linkName) {
      await fsp.mkdir(dirname(target), { recursive: true })
      await fsp.rm(target, { force: true }).catch(() => {})
      await fsp.symlink(entry.linkName, target).catch(() => {})
      return
    }
    if (entry.isDir) {
      await fsp.mkdir(target, { recursive: true })
      return
    }
    await fsp.mkdir(dirname(target), { recursive: true })
    const ws = createWriteStream(target)
    try {
      for (;;) {
        const chunk = await entry.readChunk(1 << 20)
        if (chunk.length === 0) break
        if (!ws.write(chunk)) await once(ws, 'drain')
      }
    } finally {
      ws.end()
    }
    await once(ws, 'close').catch(() => {})
    // 保留可执行位（Linux / macOS 的 JDK 包依赖它）
    if (process.platform !== 'win32' && entry.mode & 0o111) await fsp.chmod(target, 0o755).catch(() => {})
  })
}

/** 把 srcDir 目录打包成 zip 写到 outPath（导出整合包用）。 */
export async function zipDirectory(srcDir: string, outPath: string): Promise<void> {
  const files = await listFiles(srcDir)
  const ws = createWriteStream(outPath)
  const central: Buffer[] = []
  let offset = 0
  const write = async (buf: Buffer): Promise<void> => {
    if (!ws.write(buf)) await once(ws, 'drain')
  }
  try {
    for (const f of files) {
      const data = await fsp.readFile(f.abs)
      // deflate 走 libuv 线程池，CRC 分片计算并周期让出事件循环：两者并行且都不阻塞主进程。
      const [comp, crc] = await Promise.all([deflateRawAsync(data), crc32Async(data)])
      const nameBuf = Buffer.from(f.rel, 'utf8')
      const { time, date } = dosDateTime(f.mtime)

      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4) // version needed
      local.writeUInt16LE(0x800, 6) // 文件名按 UTF-8
      local.writeUInt16LE(8, 8) // deflate
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(comp.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      local.writeUInt16LE(0, 28)
      await write(local)
      await write(nameBuf)
      await write(comp)

      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(0x02014b50, 0)
      cd.writeUInt16LE(20, 4) // version made by
      cd.writeUInt16LE(20, 6) // version needed
      cd.writeUInt16LE(0x800, 8)
      cd.writeUInt16LE(8, 10)
      cd.writeUInt16LE(time, 12)
      cd.writeUInt16LE(date, 14)
      cd.writeUInt32LE(crc, 16)
      cd.writeUInt32LE(comp.length, 20)
      cd.writeUInt32LE(data.length, 24)
      cd.writeUInt16LE(nameBuf.length, 28)
      cd.writeUInt32LE(offset, 42)
      central.push(cd, nameBuf)

      offset += 30 + nameBuf.length + comp.length
    }

    const cdBuf = Buffer.concat(central)
    await write(cdBuf)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(files.length, 8)
    eocd.writeUInt16LE(files.length, 10)
    eocd.writeUInt32LE(cdBuf.length, 12)
    eocd.writeUInt32LE(offset, 16)
    await write(eocd)
  } finally {
    ws.end()
    await once(ws, 'close').catch(() => {})
  }
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

/** 文件名统一为 `/` 分隔并去掉开头的 `./`。 */
function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\/+/, '')
}

/** 拼接解压目标路径；条目名越出 dest（`..`、绝对路径、盘符）时返回 null 表示跳过。 */
function safeJoin(dest: string, name: string): string | null {
  const rel = name.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel || /^[a-zA-Z]:/.test(rel)) return null
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.length === 0 || parts.some((p) => p === '..')) return null
  return join(dest, ...parts)
}

async function readAt(fh: FileHandle, buf: Buffer, position: number): Promise<void> {
  let done = 0
  while (done < buf.length) {
    const { bytesRead } = await fh.read(buf, done, buf.length - done, position + done)
    if (bytesRead === 0) break
    done += bytesRead
  }
}

function isZipFile(head: Buffer): boolean {
  return head[0] === 0x50 && head[1] === 0x4b
}

/* ------------------------------------------------------------------ */
/* zip：中央目录解析与读取                                              */
/* ------------------------------------------------------------------ */

interface ZipEntry {
  name: string
  method: number
  compSize: number
  uncompSize: number
  localOffset: number
  isDir: boolean
}

interface ZipCentral {
  count: number
  cdSize: number
  cdOffset: number
}

/** 定位并解析 EOCD（必要时读 ZIP64 记录）。 */
async function readZipEocd(fh: FileHandle, size: number): Promise<ZipCentral> {
  const tailLen = Math.min(size, 66_000)
  const tail = Buffer.alloc(tailLen)
  await readAt(fh, tail, size - tailLen)
  let eocd = -1
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 压缩包')

  let count = tail.readUInt16LE(eocd + 10)
  let cdSize = tail.readUInt32LE(eocd + 12)
  let cdOffset = tail.readUInt32LE(eocd + 16)

  // 任一字段顶到上限即说明真实值在 ZIP64 记录里
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locOff = size - tailLen + eocd - 20
    if (locOff >= 0) {
      const loc = Buffer.alloc(20)
      await readAt(fh, loc, locOff)
      if (loc.readUInt32LE(0) === 0x07064b50) {
        const z = Buffer.alloc(56)
        await readAt(fh, z, Number(loc.readBigUInt64LE(8)))
        if (z.readUInt32LE(0) === 0x06064b50) {
          count = Number(z.readBigUInt64LE(32))
          cdSize = Number(z.readBigUInt64LE(40))
          cdOffset = Number(z.readBigUInt64LE(48))
        }
      }
    }
  }
  return { count, cdSize, cdOffset }
}

/** 按通用标志位 / 编码探测解出条目名（UTF-8 优先，其次 GBK）。 */
function decodeName(buf: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return buf.toString('utf8')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    /* 非 UTF-8，继续尝试 GBK */
  }
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return buf.toString('latin1')
  }
}

interface ZipArchive {
  fh: FileHandle
  entries: ZipEntry[]
}

/** 打开并解析 zip 中央目录；不是 zip（按魔数判断）时返回 null，句柄由调用方关闭。 */
async function openZip(file: string): Promise<ZipArchive | null> {
  const fh = await fsp.open(file, 'r')
  try {
    const head = Buffer.alloc(4)
    await readAt(fh, head, 0)
    if (!isZipFile(head)) {
      await fh.close()
      return null
    }
    const { size } = await fh.stat()
    const { count, cdSize, cdOffset } = await readZipEocd(fh, size)
    const cd = Buffer.alloc(cdSize)
    await readAt(fh, cd, cdOffset)
    return { fh, entries: parseCentralDirectory(cd, count) }
  } catch (err) {
    await fh.close()
    throw err
  }
}

/** 解析中央目录块。 */
function parseCentralDirectory(cd: Buffer, count: number): ZipEntry[] {
  const entries: ZipEntry[] = []
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) break
    const flags = cd.readUInt16LE(p + 8)
    const method = cd.readUInt16LE(p + 10)
    let compSize = cd.readUInt32LE(p + 20)
    let uncompSize = cd.readUInt32LE(p + 24)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    let localOffset = cd.readUInt32LE(p + 42)
    const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0)

    // ZIP64 扩展字段：仅在对应字段为 0xffffffff 时按序读取实际值
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      let q = p + 46 + nameLen
      const end = q + extraLen
      while (q + 4 <= end) {
        const id = cd.readUInt16LE(q)
        const len = cd.readUInt16LE(q + 2)
        if (id === 0x0001) {
          let r = q + 4
          const take = (): number => {
            const v = Number(cd.readBigUInt64LE(r))
            r += 8
            return v
          }
          if (uncompSize === 0xffffffff) uncompSize = take()
          if (compSize === 0xffffffff) compSize = take()
          if (localOffset === 0xffffffff) localOffset = take()
          break
        }
        q += 4 + len
      }
    }

    entries.push({
      name: normalizeEntryName(name),
      method,
      compSize,
      uncompSize,
      localOffset,
      isDir: name.endsWith('/')
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 条目数据起始偏移（局部头的名称 / 扩展字段长度可能与中央目录不同，须以局部头为准）。 */
async function zipDataOffset(fh: FileHandle, entry: ZipEntry): Promise<number> {
  const local = Buffer.alloc(30)
  await readAt(fh, local, entry.localOffset)
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`zip 局部头损坏：${entry.name}`)
  return entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
}

/** 解压单个条目到 target：数据经流式管道与异步 inflate（libuv 线程池），不阻塞事件循环。 */
async function writeZipEntry(file: string, fh: FileHandle, entry: ZipEntry, target: string): Promise<void> {
  if (entry.compSize === 0) {
    await fsp.writeFile(target, Buffer.alloc(0))
    return
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`不支持的 zip 压缩方式 ${entry.method}：${entry.name}`)
  }
  const start = await zipDataOffset(fh, entry)
  const source = createReadStream(file, { start, end: start + entry.compSize - 1 })
  const sink = createWriteStream(target)
  if (entry.method === 0) await pipeline(source, sink)
  else await pipeline(source, createInflateRaw(), sink)
}

/** 读取单个条目的完整内容（只用于整合包元数据等小文件）。 */
async function readZipEntryData(fh: FileHandle, entry: ZipEntry): Promise<Buffer> {
  if (entry.compSize === 0) return Buffer.alloc(0)
  const start = await zipDataOffset(fh, entry)
  const raw = Buffer.alloc(entry.compSize)
  await readAt(fh, raw, start)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRawAsync(raw)
  throw new Error(`不支持的 zip 压缩方式 ${entry.method}：${entry.name}`)
}

/* ------------------------------------------------------------------ */
/* tar / tar.gz：顺序解析                                               */
/* ------------------------------------------------------------------ */

interface TarEntry {
  name: string
  isDir: boolean
  size: number
  mode: number
  /** 符号链接目标（非链接条目为空）。 */
  linkName: string
  /** 按块读取条目内容，读到末尾返回空缓冲。 */
  readChunk(maxBytes: number): Promise<Buffer>
}

/** 顺序遍历 tar（自动处理 gzip 与 GNU longname / pax 扩展头）。 */
async function walkTar(file: string, onEntry: (entry: TarEntry) => Promise<void>): Promise<void> {
  // 句柄交给 createReadStream（autoClose）接管，省掉一次额外的文件打开
  const fh = await fsp.open(file, 'r')
  let gzip = false
  try {
    const head = Buffer.alloc(2)
    await readAt(fh, head, 0)
    gzip = head[0] === 0x1f && head[1] === 0x8b
  } catch (err) {
    await fh.close()
    throw err
  }
  const raw: Readable = fh.createReadStream()
  const stream: Readable = gzip ? raw.pipe(createGunzip()) : raw
  const reader = new ByteReader(stream)
  let longName: string | null = null
  let paxPath: string | null = null

  try {
    for (;;) {
      const header = await reader.read(512)
      // 长度不足或全零块（归档结束标记）
      if (header.length < 512 || header.every((b) => b === 0)) return

      const type = header[156]
      const size = tarSize(header)

      if (type === 0x4c) {
        // GNU longname：内容即为下一个条目的名字
        longName = (await reader.readExact(size)).toString('utf8').replace(/\0.*$/, '')
        await reader.skip(pad512(size))
        continue
      }
      if (type === 0x78 || type === 0x67) {
        // pax 扩展头（path= 覆盖条目名）
        const text = (await reader.readExact(size)).toString('utf8')
        await reader.skip(pad512(size))
        const m = /(?:^|\n)\d+ path=([^\n]*)/.exec(text)
        if (m) paxPath = m[1]
        continue
      }

      const name = normalizeEntryName(longName ?? paxPath ?? tarName(header))
      longName = null
      paxPath = null

      let remaining = size
      const entry: TarEntry = {
        name,
        isDir: type === 0x35 || name.endsWith('/'),
        size,
        mode: tarMode(header),
        linkName: type === 0x32 ? tarStr(header, 157, 100) : '',
        readChunk: async (maxBytes) => {
          if (remaining <= 0) return Buffer.alloc(0)
          const chunk = await reader.read(Math.min(maxBytes, remaining))
          remaining -= chunk.length
          return chunk
        }
      }

      await onEntry(entry)
      if (remaining > 0) await reader.skip(remaining)
      await reader.skip(pad512(size))
    }
  } finally {
    raw.destroy()
    if (stream !== raw) stream.destroy()
  }
}

/** 逐块读取的字节流封装（支持精确读取、跳过与定长补白）。 */
class ByteReader {
  private readonly it: AsyncIterator<Buffer>
  private pending: Buffer = Buffer.alloc(0)
  private ended = false

  constructor(stream: Readable) {
    this.it = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  }

  /** 读取至多 n 字节；流已结束时返回更短的缓冲（可能为空）。 */
  async read(n: number): Promise<Buffer> {
    if (this.pending.length >= n) {
      const out = this.pending.subarray(0, n)
      this.pending = this.pending.subarray(n)
      return out
    }
    // 需要跨多个 chunk：收集后只拼接一次，避免逐块 concat 造成 O(n²) 复制
    const parts: Buffer[] = this.pending.length > 0 ? [this.pending] : []
    let total = this.pending.length
    this.pending = Buffer.alloc(0)
    while (total < n && !this.ended) {
      const { value, done } = await this.it.next()
      if (done) {
        this.ended = true
        break
      }
      const chunk = value as Buffer
      parts.push(chunk)
      total += chunk.length
    }
    if (parts.length === 0) return Buffer.alloc(0)
    const merged = parts.length === 1 ? parts[0] : Buffer.concat(parts, total)
    if (merged.length <= n) return merged
    this.pending = merged.subarray(n)
    return merged.subarray(0, n)
  }

  /** 读取恰好 n 字节，不足说明归档被截断。 */
  async readExact(n: number): Promise<Buffer> {
    const buf = await this.read(n)
    if (buf.length < n) throw new Error('压缩包已损坏（数据不完整）')
    return buf
  }

  /** 跳过 n 字节：只丢弃缓冲视图，不复制数据（跳过大文件体时也不会拖住事件循环）。 */
  async skip(n: number): Promise<void> {
    let left = n
    while (left > 0) {
      if (this.pending.length > 0) {
        const take = Math.min(left, this.pending.length)
        this.pending = this.pending.subarray(take)
        left -= take
        continue
      }
      if (this.ended) return
      const { value, done } = await this.it.next()
      if (done) {
        this.ended = true
        return
      }
      this.pending = value as Buffer
    }
  }
}

function pad512(size: number): number {
  return (512 - (size % 512)) % 512
}

/** 读取以 NUL 结尾的定长字符串字段。 */
function tarStr(buf: Buffer, off: number, len: number): string {
  const nul = buf.indexOf(0, off)
  const end = nul === -1 || nul > off + len ? off + len : nul
  return buf.toString('utf8', off, end).trim()
}

function tarName(header: Buffer): string {
  const name = tarStr(header, 0, 100)
  const prefix = tarStr(header, 345, 155)
  return prefix ? `${prefix}/${name}` : name
}

function tarMode(header: Buffer): number {
  const n = parseInt(tarStr(header, 100, 8), 8)
  return Number.isFinite(n) ? n : 0o644
}

function tarSize(header: Buffer): number {
  const raw = header.subarray(124, 136)
  // GNU 大文件：首字节置高位表示 base-256 编码
  if ((raw[0] & 0x80) !== 0) {
    let v = 0
    for (let i = 1; i < raw.length; i++) v = v * 256 + raw[i]
    return v
  }
  const n = parseInt(tarStr(header, 124, 12), 8)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/* ------------------------------------------------------------------ */
/* 打包辅助                                                            */
/* ------------------------------------------------------------------ */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/** 每次让出事件循环前最多连续计算的字节数。 */
const CRC_YIELD_CHUNK = 4 << 20

/** 让出一次事件循环（让 IPC / 下载 / 界面渲染有机会被处理）。 */
function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 分片计算 CRC32，每片之间让出事件循环。
 * 表驱动 CRC 是纯 JS 循环，整块算完（大文件可达数百 MB）会占满主进程事件循环，故必须分片。
 */
async function crc32Async(buf: Buffer): Promise<number> {
  let c = 0xffffffff
  for (let off = 0; off < buf.length; off += CRC_YIELD_CHUNK) {
    const end = Math.min(off + CRC_YIELD_CHUNK, buf.length)
    for (let i = off; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    if (end < buf.length) await yieldEventLoop()
  }
  return (c ^ 0xffffffff) >>> 0
}

/** zlib 异步封装（跑在 libuv 线程池，不占用主进程事件循环）。 */
function inflateRawAsync(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    inflateRaw(buf, (err, out) => (err ? reject(err) : resolve(out)))
  })
}

function deflateRawAsync(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    deflateRaw(buf, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
}

/** DOS 时间（zip 头用），精度 2 秒。 */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(d.getFullYear(), 1980)
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

async function listFiles(dir: string, base = ''): Promise<Array<{ abs: string; rel: string; mtime: Date }>> {
  const out: Array<{ abs: string; rel: string; mtime: Date }> = []
  const entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const e of entries) {
    const abs = join(dir, e.name)
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await listFiles(abs, rel)))
    else if (e.isFile()) out.push({ abs, rel, mtime: (await fsp.stat(abs)).mtime })
  }
  return out
}

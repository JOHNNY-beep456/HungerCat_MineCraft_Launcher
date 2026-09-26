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
  {
    re: /\b(?:mv|cp|move|copy|xcopy|robocopy)\s+["']?[a-z]:[\\/]/i,
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
  { re: /constructor\s*\.\s*constructor|__proto__\s*\[|Object\.getPrototypeOf\s*\(\s*function/i, reason: '包含绕过沙箱的构造器链访问（疑似伪装代码）' },
  { re: /document\.write\s*\([\s\S]{0,400}?<script/i, reason: '使用 document.write 动态注入脚本（疑似伪装代码）' },
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
 * 用统一规则表扫描一段文本，返回命中的中文原因（去重）。
 *
 * 纯函数、同步执行：主进程的静态检测与渲染层的运行时检测共用，保证两处判定一致。
 */
export function scanHomepageCode(source: string, scope: HomepageScanScope = 'code'): string[] {
  if (!source) return []
  const raw = source.length > MAX_SCAN_LENGTH ? source.slice(0, MAX_SCAN_LENGTH) : source
  const scan = scope === 'payload' ? raw : collapseInlineBase64(raw)
  const blocks: string[] = []
  for (const rule of HOMEPAGE_BLOCK_RULES) {
    if (scope === 'library' && rule.skipInLibrary) continue
    if (scope === 'payload' && rule.skipInPayload) continue
    if (rule.re.test(scan) && !blocks.includes(rule.reason)) blocks.push(rule.reason)
  }
  return blocks
}

/**
 * 启动异常诊断（纯渲染端逻辑）。
 *
 * 游戏启动失败 / 异常退出时，按关键词从日志中识别常见原因，给出「一句话结论 + 处理建议」，
 * 供界面弹窗展示。「详情」只展示**最关键的那一条错误信息**（命中规则的错误行，或最像报错的
 * 一行），而不是把整段日志铺开；完整原文仍保留在 raw 里备查。
 */

/** 诊断报告。 */
export interface LaunchReport {
  /** 命中的规则名；未命中为 'unknown'。 */
  rule: string
  /** 一句话结论。 */
  summary: string
  /** 处理建议（可为空串）。 */
  advice: string
  /** 最关键的一条错误信息（仅此一条），用于「详情」展示。 */
  detail: string
  /** 原始错误内容（完整保留，供复制 / 排查）。 */
  raw: string
}

/** 单条诊断规则：命中即采用（按数组顺序短路）。 */
const RULES: Array<{ rule: string; test: RegExp; summary: string; advice: string }> = [
  {
    rule: 'memory',
    test: /OutOfMemoryError|Could not reserve enough space|insufficient memory|Failed to allocate|Unable to allocate/i,
    summary: '内存不足，无法为游戏分配足够的运行内存',
    advice: '请在启动页调小「最大内存」，或关闭其它占用内存的程序后重试。'
  },
  {
    rule: 'java-version',
    test: /UnsupportedClassVersionError|class file version|requires Java \d|no suitable Java|Java version.*(?:not|un)supported/i,
    summary: 'Java 版本与游戏 / 模组不匹配',
    advice: '请在「设置 → 游戏」改用对应版本的 Java（1.17+ 用 Java 17，1.20.5+ 用 Java 21）后重试。'
  },
  {
    rule: 'missing-dependency',
    test: /NoClassDefFoundError|ClassNotFoundException|Missing or unsupported mandatory dependencies|requires .* which is missing|Incompatible mod set|Missing required/i,
    summary: '缺少前置模组，或模组依赖不完整',
    advice: '请在「资源下载」中为相关模组补齐前置后重试；安装时若提示缺少前置，可选择一并下载。'
  },
  {
    rule: 'mod-conflict',
    test: /Duplicate mods|Mixin apply failed|mixin\.injection|MixinTransformerError|Incompatible mod|Conflicting/i,
    summary: '模组之间冲突（常见于同功能模组重复安装或 Mixin 注入失败）',
    advice: '请逐个禁用最近新增的模组，定位冲突来源。'
  },
  {
    rule: 'auth',
    test: /Invalid session|Failed to verify username|Invalid token|401 Unauthorized|403 Forbidden|authentication failed/i,
    summary: '账号验证失败',
    advice: '请在「账号」页重新登录该账号后重试。'
  },
  {
    rule: 'graphics',
    test: /OpenGL|GLFW|Pixel format|WGL|Failed to create window|GLX|NoClassDefFoundError: org\/lwjgl/i,
    summary: '显卡 / OpenGL 初始化失败',
    advice: '请更新显卡驱动；笔记本可尝试在显卡控制面板中指定使用独立显卡。'
  },
  {
    rule: 'jvm-option',
    test: /Unrecognized VM option|Could not create the Java Virtual Machine|Unrecognized option/i,
    summary: 'JVM 启动参数不被当前 Java 支持',
    advice: '请检查「设置 → 游戏」中的 JVM 参数，移除当前 Java 不适用的选项。'
  },
  {
    rule: 'file-locked',
    test: /being used by another process|另一个程序|拒绝访问|Access is denied/i,
    summary: '文件被占用或没有访问权限',
    advice: '请关闭可能占用游戏目录的程序（压缩软件、另一个实例等）后重试。'
  },
  {
    rule: 'crash',
    test: /A fatal error has been detected|SIGSEGV|crash-reports|游戏崩溃|Exit Code: -?\d+/i,
    summary: '游戏进程异常退出（崩溃）',
    advice: '请查看游戏目录下 crash-reports 中的日志，其中通常记录了具体崩溃原因。'
  }
]

/** 原始错误内容的展示上限：够看清关键信息，又不至于把弹窗撑爆。 */
const RAW_LIMIT = 4000

/** 关键错误行的展示上限：一条报错通常很短，超长（如超长类名 / 路径）时截断。 */
const DETAIL_LIMIT = 600

/** 「像报错」的一行：无规则命中时，用它从日志里挑出最关键的一条。 */
const ERROR_LINE_RE =
  /(Exception|Error|Caused by|fatal|SEVERE|崩溃|错误|失败|No such file|not found|Unable to|Cannot|Could not|failed|refused|denied|OutOfMemory|exit code)/i

/** 把一条候选错误行裁到合理长度。 */
function clipLine(line: string): string {
  const t = line.trim()
  return t.length > DETAIL_LIMIT ? `${t.slice(0, DETAIL_LIMIT)}…` : t
}

/**
 * 挑选「最关键的一条错误信息」：
 *   1. 命中诊断规则的那一行（最能解释本次失败）；
 *   2. 否则取最后一条「像报错」的行（异常栈里越靠后越接近根因）；
 *   3. 都没有则取最后一条非空日志。
 */
function pickDetail(lines: string[], matchRe?: RegExp): string {
  if (matchRe) {
    const hit = lines.find((l) => matchRe.test(l))
    if (hit) return clipLine(hit)
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ERROR_LINE_RE.test(lines[i])) return clipLine(lines[i])
  }
  return lines.length > 0 ? clipLine(lines[lines.length - 1]) : ''
}

/**
 * 分析启动日志并给出报告。
 * @param log 启动过程的日志行（按时间顺序）。
 * @param error 启动器直接上报的错误信息（若有）。
 * @param exitCode 进程退出码（若有）。
 */
export function diagnoseLaunch(log: string[], error?: string, exitCode?: number): LaunchReport {
  const lines = [error, ...log].filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
  const raw = lines.join('\n').trim()
  const shown = raw.length > RAW_LIMIT ? `${raw.slice(0, RAW_LIMIT)}\n…（内容过长已截断）` : raw

  for (const r of RULES) {
    if (r.test.test(raw)) {
      return {
        rule: r.rule,
        summary: r.summary,
        advice: r.advice,
        detail: pickDetail(lines, r.test),
        raw: shown
      }
    }
  }
  const fallback = `游戏进程异常退出（退出码 ${exitCode === undefined ? '未知' : exitCode}）`
  return {
    rule: 'unknown',
    summary: '未能自动识别异常原因',
    advice: '',
    detail: pickDetail(lines) || fallback,
    raw: shown || fallback
  }
}

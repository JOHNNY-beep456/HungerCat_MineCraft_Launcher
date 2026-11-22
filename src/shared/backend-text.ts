/**
 * 后端三语文案的解析（Rust → 渲染层）。
 *
 * 背景：Rust 侧没有「当前界面语言」上下文，面向用户的文案统一以
 * 「简体 / 繁體 / English」三段并列下发，形如
 *   `主页文件操作失败 / 主頁檔案操作失敗 / Homepage file operation failed`
 * Webview 的错误面板与 toast 只是原样显示，于是界面上出现三语并列的长串
 * （用户看到的「简体中文/繁体中文/英语」形式）。
 *
 * 这里在**桥接边界**解析一次：按当前界面语言取出对应那一段，其余丢弃。
 * 纯函数、无副作用，便于用 Node 直接单测（scripts/test-backend-text.mjs）。
 *
 * 设计取舍：
 * · 不做「键 → 词典」重构（Rust 的 3 个字符串若要按语言取词，需要给每个
 *   命令都传语言上下文，改动面远大于收益）；边界解析是等价且局部化的做法。
 * · 判定必须**严格**：只有「三段、前两段含中日韩文字、第三段不含中文、
 *   简繁顺序可辨识」才替换，否则原样返回 —— 宁可漏译，不可把正常文本
 *   （用户目录名、模组名里含 ` / ` 的字符串）改坏。
 * · 语言切换只影响**此后**的解析结果；已经渲染在界面上的旧消息不会回译，
 *   这类消息本身是瞬时的（toast / 错误横幅），重新操作即刷新。
 */

/** 中日韩统一表意文字（含扩展 A 与兼容区）。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * 简繁专用字表：**从本仓库 zh-CN / zh-TW 词典按同键同长逐字对齐矿出**，
 * 再用「该字是否也出现在另一语种文本里」过滤掉对齐噪声（例如语气词、数字）。
 * 用途只有一个：判断某一段到底像简体还是像繁体 —— 三语串的固定顺序是
 * 「简体 / 繁體 / English」，但这个顺序必须能被校验，而不是盲信位置。
 *
 * 这两张表只用于**计数比较**（不是逐字映射），少量残余噪声不影响判定。
 */
const SIMPLIFIED_CHARS = new Set(
  '与个临为么于云仅从们会传体余关内册写准减几凭击则删别务动区协单占厅厦参双发变号后吗听启员唤团围国图场块处备复头夹好实审宽对导将尝尽层屏希带帮并库应底开张弹当录征径志态悬戏户执扩扫扰护报拟拦择换据掷携数断无旧时显晓暂机权条来极枪标档检欢没浅测浏游溃点热爱牌状独猫环现画盖盘码础确离称筛简类索纤级纯线组细终绍绑结给绝统继绪续编网联肤脚航节范荐虚补装见观规览计认让议记许设访证识诊译试话询该详语误说请读调谢败账贴费资赖轨转轮软载较辑输边过运还这进连适选邮采里鉴钟钥钮链销锁错键镜长门闭问间阅队际陆险随隐静页顶项须预题额风飘饰馈馋验骤鲜' +
  /* 手工补充的常用对照（矿取语料之外的通用词汇，避免新文案漏判） */
  '这们时个来为与档载网络点确认连线开关进错误资讯选择读写样种数据库装还过对说问题应该电话号码软体项图视频声车门长间单双华语词条约级统计报场处备复验证测试变换环节产业务员导传输删复录制类济总负责标准注据属视阶发么几'
)
const TRADITIONAL_CHARS = new Set(
  '並佔併來個們偵備傳僅儘內冊別刪則動務匯區協參員問啟善喚單嗎嘗國圍圖團執報場塊夾寄實審寫寬將專尋對導層帳帶幫庫廈廳張彈律後徑從復徵愛態憑應懸戲戶掃採換擇擊據擬擲擴擾攔攜敗數料斷於時暫曉曳會杖條極槍標機檔檢權歡沒淺減測湊準潰瀏為無熱物狀獨現環畫當發盡盤確碼礎稱節範篩簡純級細紹終組結絕給統綁網緒線編繼續纖耗聯聽腳與舊蓋薦處虛號螢補裝裡複見規覽觀計記訪設許診詢試話該詳誌認語誤說調請謝證識譯議護讀變讓貓貼資賴軌軟較載輪輯輸轉辨這連進遊過遠適選還邊郵鈕銷錄錯鍵鎖鏡鐘鑰長門閉開間閘閱關陸隊際隨險隱雙雜離雲靜頁頂項須預頭題額類顯風飄飾餘饋饞驗驟體鮮麼點' +
  '這們時個來為與檔載網路點確認連線開關進錯誤資訊選擇讀寫樣種數據庫裝還過對說問題應該電話號碼軟體項圖視頻聲車門長間單雙華語詞條約級統計報場處備復驗證測試變換環節產業務員導傳輸刪複錄製類濟總負責標準註據屬視階發麼幾'
)

/** 统计一段文本命中的简 / 繁专用字数。 */
function score(text: string): { simplified: number; traditional: number } {
  let simplified = 0
  let traditional = 0
  for (const char of text) {
    if (SIMPLIFIED_CHARS.has(char)) simplified += 1
    else if (TRADITIONAL_CHARS.has(char)) traditional += 1
  }
  return { simplified, traditional }
}

/** 当前界面语言（由 store 注入；空串表示尚未注入，回落到 <html lang>）。 */
let currentLanguage = ''

/** 由 store 在语言变化时调用；传空串可清除注入值。 */
export function setBackendLanguage(language: string): void {
  currentLanguage = typeof language === 'string' ? language.trim() : ''
}

function activeLanguage(): string {
  if (currentLanguage) return currentLanguage
  if (typeof document !== 'undefined') {
    const declared = document.documentElement?.lang
    if (declared) return declared
  }
  return 'zh-CN'
}

/**
 * 目标语言 → 三语段的序号。
 * `zh-CN` 取第 0 段、`zh-TW` 取第 1 段；其余（en / ja / 未来新增语言）统一取
 * 第 2 段英文 —— 英文段是唯一对所有非中文语言都可读的兜底。
 */
function pickIndex(language: string): 0 | 1 | 2 {
  const normalized = language.toLowerCase().replace('_', '-')
  if (normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk') || normalized === 'zh-hant') return 1
  if (normalized.startsWith('zh')) return 0
  return 2
}

/**
 * 解析单条三语串；不是三语格式时原样返回。
 * `language` 省略时使用当前界面语言。
 */
export function resolveBackendText(text: string, language?: string): string {
  if (typeof text !== 'string' || text.length < 8) return text
  if (!text.includes(' / ')) return text
  const parts = text.split(' / ')
  // 恰好三段才可能是「简体 / 繁體 / English」；段内自带 ` / ` 的说明文字一律不动。
  if (parts.length !== 3) return text
  const simplified = parts[0]!.trim()
  const traditional = parts[1]!.trim()
  const english = parts[2]!.trim()
  if (!simplified || !traditional || !english) return text
  if (!CJK.test(simplified) || !CJK.test(traditional)) return text
  // 第三段必须是纯西文：产品名 / 路径里夹中文的并列串不是本地化文案。
  if (CJK.test(english)) return text
  // 简繁两段必须长度相近（互为译文），避免把「A / B / C」这类枚举当文案切。
  const shorter = Math.min(simplified.length, traditional.length)
  const longer = Math.max(simplified.length, traditional.length)
  if (longer > shorter * 2.2) return text

  const first = score(simplified)
  const second = score(traditional)
  const identical = simplified === traditional
  /*
   * 关键判据：两段必须能分辨出「谁是繁体」。
   * 标准顺序是「简体 / 繁體 / English」，因此默认第二段是繁体：它至少命中
   * 2 个繁体专用字且繁多于简。仅靠「三段 + 含中文」会把用户数据
   * （如实例名 `机械动力 / 附属 / Create`）误当成本地化文案切掉，只剩英文段 ——
   * 那属于改坏用户数据，比漏译更严重，所以这里必须严格。
   * 简繁两段完全相同（港澳台用词与简体一致）时也视为合法三语串。
   * 反向（繁体写在第一段）只在两侧字形特征互斥时才认，避免把用户数据当反序文案。
   */
  const firstLooksTraditional = first.traditional >= 1 && first.traditional > first.simplified
  /*
   * 第二段（标准顺序里的繁体）允许简繁专用字持平：语料里的「制 / 製」这类
   * context 相关字会同时出现在两套表里，严格大于会把合法文案漏掉。
   */
  const secondLooksTraditional = second.traditional >= 1 && second.traditional >= second.simplified
  const secondLooksSimplified = second.simplified >= 1 && second.traditional === 0
  const reversed = firstLooksTraditional && secondLooksSimplified && !secondLooksTraditional
  if (!identical && !secondLooksTraditional && !reversed) return text

  const index = pickIndex(language ?? activeLanguage())
  if (index === 2) return english
  if (index === 0) return reversed ? traditional : simplified
  return reversed ? simplified : traditional
}

/**
 * 深度解析调用结果 / 事件负载里的所有字符串。
 *
 * · 写时复制：没有任何字符串被改写时原样返回同一引用，大列表零拷贝。
 * · 节点预算：超出预算即停止深入（余下部分原样返回）。正常业务负载在
 *   数千节点量级，预算只为防御异常超大结构把主线程拖住。
 * · 只走普通对象与数组：`Uint8Array`、`Date`、类实例一律原样返回。
 */
export function resolveBackendValue<T>(value: T, nodeBudget = 60000): T {
  if (value === null || typeof value !== 'object') {
    return (typeof value === 'string' ? resolveBackendText(value) : value) as T
  }
  const state = { budget: nodeBudget }
  return walk(value, state, 0, new Set<object>()) as T
}

function walk(input: unknown, state: { budget: number }, depth: number, seen: Set<object>): unknown {
  if (state.budget <= 0) return input
  if (typeof input === 'string') {
    state.budget -= 1
    const next = resolveBackendText(input)
    return next === input ? input : next
  }
  if (input === null || typeof input !== 'object') return input
  if (depth >= 32 || seen.has(input)) return input
  seen.add(input)
  try {
    if (Array.isArray(input)) {
      let changed = false
      const output: unknown[] = new Array(input.length)
      for (let i = 0; i < input.length; i += 1) {
        const item = walk(input[i], state, depth + 1, seen)
        if (item !== input[i]) changed = true
        output[i] = item
      }
      return changed ? output : input
    }
    const prototype: unknown = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return input
    const source = input as Record<string, unknown>
    let changed = false
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(source)) {
      const next = walk(item, state, depth + 1, seen)
      if (next !== item) changed = true
      output[key] = next
    }
    return changed ? output : input
  } finally {
    seen.delete(input)
  }
}

/** 把任意抛出值转成已完成语言解析的 Error（保留原始 message 之外的信息不重要）。 */
export function localizeBackendError(cause: unknown): unknown {
  if (cause instanceof Error) {
    const message = resolveBackendText(cause.message)
    if (message !== cause.message) {
      const clone = new Error(message)
      clone.name = cause.name
      if (cause.stack) clone.stack = cause.stack.replace(cause.message, message)
      return clone
    }
    return cause
  }
  if (typeof cause === 'string') return resolveBackendText(cause)
  return cause
}

'use strict'

/** 安装器界面逻辑。 */

const $ = (id) => document.getElementById(id)

/** 基本信息（来自主进程）。 */
let info = null
/** 当前选择的安装范围：'all' | 'user'。 */
let scope = 'user'
/** 当前安装结果 { scope, installDir, exePath }。 */
let result = null
/** 是否正在安装。 */
let installing = false

const PHASE_LABEL = {
  copy: '复制文件',
  shortcut: '创建快捷方式',
  register: '注册卸载信息',
  elevate: '管理员授权',
  done: '完成'
}

/** 切换可见步骤。 */
function showStep(name) {
  for (const el of document.querySelectorAll('.step')) {
    el.classList.toggle('is-active', el.dataset.step === name)
  }
}

/** 指定范围已检测到的安装（或 null）。 */
function detected(s) {
  return info && info.scopes[s] ? info.scopes[s].install : null
}

/**
 * 是否允许在该范围「覆盖安装」。
 * 机器级安装对所有用户生效，可直接覆盖；单用户安装仅当**当前登录用户就是当初的安装者**时
 * 才视为本人安装、显示覆盖（否则属于别的用户，不应覆盖）。
 */
function canOverwrite(s) {
  const d = detected(s)
  if (!d) return false
  if (s === 'all') return true
  const owner = (d.installUser || '').toLowerCase()
  // 未记录安装者时：单用户安装位于当前用户自己的目录 / HKCU，天然属于本人，视为可覆盖。
  if (!owner) return true
  return owner === (info.currentUser || '').toLowerCase()
}

/** 应用范围选择：切换单选、按规则填充安装目录并给出提示。 */
function applyScope(next, keepDir) {
  scope = next === 'all' ? 'all' : 'user'
  for (const r of document.querySelectorAll('input[name="scope"]')) r.checked = r.value === scope

  const d = detected(scope)
  const other = scope === 'all' ? 'user' : 'all'
  const otherD = detected(other)
  const hint = $('welcomeHint')
  hint.classList.remove('warn')

  if (keepDir && $('dirInput').value.trim()) {
    // 保留用户已手动选择的目录，仅更新提示。
  } else if (d && canOverwrite(scope)) {
    $('dirInput').value = d.installDir || info.scopes[scope].defaultDir
  } else {
    $('dirInput').value = info.scopes[scope].defaultDir
  }

  if (d && canOverwrite(scope)) {
    hint.textContent = `检测到已安装的 HungerCat MineCraft Launcher${d.version ? ' ' + d.version : ''}，将覆盖安装到原目录。`
  } else if (d && scope === 'user' && !canOverwrite(scope)) {
    hint.textContent = `检测到该应用由其他用户（${d.installUser || '未知'}）安装，当前用户下不覆盖，将安装到新的目录。`
  } else if (otherD) {
    const otherLabel = other === 'all' ? '所有用户' : '当前用户'
    hint.textContent = `检测到「${otherLabel}」范围的安装${otherD.version ? '（' + otherD.version + '）' : ''}，本次为「${
      scope === 'all' ? '所有用户' : '当前用户'
    }」安装，两者相互独立。`
  } else if (scope === 'all') {
    hint.textContent = '将安装到所有用户，需要管理员权限（安装时会弹出 UAC 提示）。'
  } else {
    hint.textContent = ''
  }
}

async function init() {
  info = await window.installer.info()
  $('tbVersion').textContent = '安装程序 v' + info.appVersion
  $('scopeUserName').textContent = info.currentUser || '当前用户'

  if (!info.payloadReady) {
    $('welcomeHint').textContent = '未检测到安装载荷：请使用正式发布的安装程序，或先执行 npm run dist:installer 生成 installer/payload。'
    $('welcomeHint').classList.add('warn')
  }

  // 默认范围：若检测到机器级安装则选它，否则默认单用户。
  const initial = detected('all') ? 'all' : 'user'
  applyScope(initial)

  $('btnMin').addEventListener('click', () => void window.installer.minimize())
  $('btnClose').addEventListener('click', async () => {
    if (installing) await window.installer.cancel()
    void window.installer.quit()
  })

  for (const r of document.querySelectorAll('input[name="scope"]')) {
    r.addEventListener('change', () => {
      if (r.checked) applyScope(r.value)
    })
  }

  $('btnBrowse').addEventListener('click', async () => {
    const dir = await window.installer.chooseDir(scope)
    if (dir) $('dirInput').value = dir
  })

  $('btnCancelWelcome').addEventListener('click', () => void window.installer.quit())
  $('btnInstall').addEventListener('click', () => void doInstall())
  $('btnCancelInstall').addEventListener('click', () => void window.installer.cancel())
  $('btnOpenFolder').addEventListener('click', () => result && void window.installer.openFolder(result.installDir))
  $('btnFinish').addEventListener('click', () => void finish())
  $('btnBack').addEventListener('click', () => showStep('welcome'))

  window.installer.onProgress((p) => {
    $('progressFill').style.width = Math.max(0, Math.min(100, p.percent)) + '%'
    $('progressPercent').textContent = p.percent + '%'
    $('progressPhase').textContent = PHASE_LABEL[p.phase] || '安装中'
    if (p.detail) $('installDetail').textContent = p.detail
  })
}

async function doInstall() {
  const dir = $('dirInput').value.trim()
  if (!dir) {
    $('welcomeHint').textContent = '请先选择安装目录。'
    $('welcomeHint').classList.add('warn')
    return
  }
  installing = true
  $('progressFill').style.width = '0%'
  $('progressPercent').textContent = '0%'
  $('installDetail').textContent = scope === 'all' ? '正在请求管理员权限…' : '正在准备文件…'
  // 机器级安装由提权子进程完成，父进程无法中止，故禁用取消。
  $('btnCancelInstall').style.display = scope === 'all' ? 'none' : ''
  showStep('installing')

  const res = await window.installer.start({
    scope,
    dir,
    desktopShortcut: $('optDesktop').checked,
    startMenuShortcut: $('optStartMenu').checked
  })
  installing = false

  if (res && res.ok) {
    result = res
    $('donePath').textContent = res.installDir
    $('doneScope').textContent =
      res.scope === 'all' ? '已为所有用户安装 HungerCat MineCraft Launcher。' : '已为当前用户安装 HungerCat MineCraft Launcher。'
    showStep('done')
  } else if (res && res.cancelled) {
    showStep('welcome')
  } else {
    $('errorText').textContent = (res && res.error) || '未知错误'
    showStep('error')
  }
}

/** 完成：按需启动已安装的启动器并退出。 */
async function finish() {
  if (result && $('optLaunch').checked) {
    await window.installer.launch(result.exePath)
  }
  void window.installer.quit()
}

void init()

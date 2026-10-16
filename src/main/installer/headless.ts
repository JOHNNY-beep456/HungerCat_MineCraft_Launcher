import { appendFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { currentUserName, normalizeScope } from './paths'
import {
  buildInfo,
  describeError,
  runInstall,
  type InstallOptions,
  type InstallResult
} from './install'

/**
 * 无界面模式（不建窗口）。
 *
 * 三个开关沿用原独立安装器（installer/main.js）的参数名与行为，不做改动：
 *   --hc-info                    打印安装器信息后退出
 *   --hc-selftest [dir]          静默装一次（只复制 + 注册，不建快捷方式）后退出
 *   --hc-elevated-install <file> 机器级安装的提权子进程入口
 */
export function bootstrapHeadless(src: string): boolean {
  const args = process.argv
  const selftestIdx = args.indexOf('--hc-selftest')
  const infoIdx = args.indexOf('--hc-info')
  const elevIdx = args.indexOf('--hc-elevated-install')

  if (infoIdx >= 0) {
    void buildInfo(src, currentUserName()).then((data) => {
      try {
        appendFileSync(join(tmpdir(), 'HungerCat-Info.log'), `${JSON.stringify(data)}\n`)
      } catch {
        /* 忽略 */
      }
      app.exit(0)
    })
    return true
  }

  if (elevIdx >= 0) {
    const reqPath = args[elevIdx + 1]
    void (async () => {
      let result: InstallResult = { ok: false, error: '提权子进程参数错' }
      try {
        const raw = await readFile(reqPath, 'utf8')
        const req = JSON.parse(raw.replace(/^﻿/, '')) as InstallOptions & { resultPath?: string }
        result = await runInstall(
          src,
          {
            dir: req.dir,
            scope: 'all',
            desktopShortcut: req.desktopShortcut,
            startMenuShortcut: req.startMenuShortcut
          },
          () => {}
        )
        if (req.resultPath) await writeFile(req.resultPath, JSON.stringify(result), 'utf8')
      } catch (err) {
        result = { ok: false, error: describeError(err) }
      }
      app.exit(result.ok ? 0 : 1)
    })()
    return true
  }

  if (selftestIdx >= 0) {
    const target = args[selftestIdx + 1] || join(tmpdir(), 'hc-selftest-target')
    const scopeIdx = args.indexOf('--scope')
    const scope = normalizeScope(scopeIdx >= 0 ? args[scopeIdx + 1] : 'user')
    void runInstall(
      src,
      { dir: target, scope, desktopShortcut: false, startMenuShortcut: false },
      () => {}
    ).then((r) => {
      try {
        appendFileSync(
          join(tmpdir(), 'HungerCat-Selftest.log'),
          `[${new Date().toISOString()}] ${JSON.stringify(r)}\n`
        )
      } catch {
        /* 忽略 */
      }
      app.exit(r.ok ? 0 : 1)
    })
    return true
  }

  return false
}
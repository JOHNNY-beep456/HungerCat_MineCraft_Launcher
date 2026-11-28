/**
 * Microsoft Store 打包链路的回归测试。
 *
 * 这条链路全是「不跑就不知道」的格式约束，出错时表现为商店上传被拒或装完起不来，
 * 而不是编译失败，所以固定成断言：
 *   - AppxManifest 必须同时有 EntryPoint 与 uap10 的 RuntimeBehavior / TrustLevel
 *     （少了后者会被当成 appContainer，写注册表 / 起子进程直接失败）；
 *   - 商店 Identity 必须来自 Partner Center，打包脚本不能放行侧载默认值；
 *   - bundle 的校验要用 makeappx unbundle，unpack 只认单个包；
 *   - CI 的商店产物不能混进 GitHub Release（那是给直接下载用户的，签名与身份都不同）。
 *
 * 另外守一条踩过的坑：`.ps1` 里含中文却没有 BOM 时，Windows PowerShell 5.1 会按 ANSI 解码，
 * 注释里的字节可能被解成引号，整个脚本报「意外的标记」。两个脚本都必须是 UTF-8 BOM。
 *
 * 运行：node scripts/test-msix-store.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')
const readBytes = (p) => readFileSync(resolve(ROOT, p))

let pass = 0
let fail = 0
function ok(label, condition, detail) {
  if (condition) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail === undefined ? '' : `\n       ${detail}`}`)
  }
}

/** `.ps1` 含非 ASCII 时必须是 UTF-8 BOM，否则 PS 5.1 会按 ANSI 解码并解析失败。 */
function checkBom(label, path) {
  const bytes = readBytes(path)
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const hasNonAscii = bytes.some((b) => b > 0x7f)
  ok(label, !hasNonAscii || hasBom, '含非 ASCII 但没有 UTF-8 BOM：Windows PowerShell 5.1 会解析失败')
}

const pkgScript = read('scripts/package-msix.ps1')
const bundleScript = read('scripts/package-msix-bundle.ps1')
const workflow = read('.github/workflows/build-tauri.yml')

console.log('\n清单：完全信任的打包桌面应用')
{
  ok('声明 uap10 命名空间', /xmlns:uap10="http:\/\/schemas\.microsoft\.com\/appx\/manifest\/uap\/windows10\/10"/.test(pkgScript))
  ok('uap10 进 IgnorableNamespaces', /IgnorableNamespaces="[^"]*\buap10\b[^"]*"/.test(pkgScript))
  ok('保留 EntryPoint（1809~1903 只认这个）', /EntryPoint="Windows\.FullTrustApplication"/.test(pkgScript))
  ok('RuntimeBehavior=packagedClassicApp', /uap10:RuntimeBehavior="packagedClassicApp"/.test(pkgScript))
  ok('TrustLevel=mediumIL', /uap10:TrustLevel="mediumIL"/.test(pkgScript))
  ok('声明 runFullTrust 受限能力', /rescap:Capability Name="runFullTrust"/.test(pkgScript))
  ok('目标设备族为 Windows.Desktop', /TargetDeviceFamily Name="Windows\.Desktop"/.test(pkgScript))
  ok('版本段必须是纯数字（MSIX 不接受 -dev）', /if \(\$Version -match '-'\)/.test(pkgScript))
}

console.log('\n商店 Identity：必须来自 Partner Center')
{
  ok('有 -Store 开关', /\[switch\]\$Store/.test(pkgScript))
  ok('拒绝侧载默认 Identity', /-eq 'top\.johnnyblog\.hcmcl' -or \$Publisher -eq 'CN=HungerCat'/.test(pkgScript))
  ok('要求 CN= 前缀', /\$Publisher\.StartsWith\('CN='\)/.test(pkgScript))
  ok('商店模式强制签名（否则无法本机验收）', /\$Sign = \$true/.test(pkgScript))
}

console.log('\nbundle：合成与自检')
{
  ok(
    '校验用 unbundle 而不是 unpack',
    /\$makeappx unbundle/.test(bundleScript) && !/\$makeappx\s+unpack/.test(bundleScript),
    'unpack 只认单个包，对 bundle 会报 0x80080203'
  )
  ok('校验三项 Identity 一致', /Group-Object Name, Publisher, Version/.test(bundleScript))
  ok('校验版本与请求一致', /does not match requested/.test(bundleScript))
  ok('产出 .msixbundle 与 .msixupload', /\.msixbundle/.test(bundleScript) && /\.msixupload/.test(bundleScript))
  ok('保留侧载默认 Publisher 时给告警', /CN=HungerCat/.test(bundleScript) && /Write-Warning/.test(bundleScript))
}

console.log('\nCI：商店通道独立于 Release')
{
  ok('有 store-bundle job', /\n {2}store-bundle:/.test(workflow))
  ok('依赖 Windows 三个架构', /needs: windows/.test(workflow))
  ok('读 STORE_IDENTITY_NAME 变量', /vars\.STORE_IDENTITY_NAME/.test(workflow))
  ok('未配置变量时跳过而不是失败', /if: vars\.STORE_IDENTITY_NAME != ''/.test(workflow))
  ok('上传 hcmcl-store-upload', /name: hcmcl-store-upload/.test(workflow))
  ok(
    'Release 仍只汇编常规产物',
    /needs: \[windows, linux, linux-armv7, macos\]/.test(workflow),
    '商店包不应进入 GitHub Release'
  )
}

console.log('\n运行时：包形态下不得自更新')
{
  const packaged = read('src-tauri/src/packaged.rs')
  ok('用 GetCurrentPackageFullName 判定', /GetCurrentPackageFullName/.test(packaged))
  ok('只把 122/0 当作已打包', /code == 0 \|\| code == ERROR_INSUFFICIENT_BUFFER/.test(packaged))
  ok('非 Windows 恒为 false', /#\[cfg\(not\(windows\)\)\][\s\S]{0,60}false/.test(packaged))

  const lib = read('src-tauri/src/lib.rs')
  ok('注册 packaged 模块', /^mod packaged;$/m.test(lib))

  const services = read('src-tauri/src/services.rs')
  const body = services.slice(services.indexOf('async fn update_call'))
  const gate = body.indexOf('crate::packaged::is_packaged()')
  const network = body.indexOf('update_metadata')
  ok('update_call 里有包形态判定', gate >= 0)
  ok('判定发生在联网之前', gate >= 0 && network > gate, '漏了就仍会去自建更新源查版本')
  ok('包形态下 update:check 不报新版本', /Ok\(update_check_value\(&current, None\)\)/.test(body))
  ok('包形态下拒绝下载安装器', /Microsoft Store/.test(body) && /Err\(/.test(body))
}

console.log('\n脚本编码')
{
  checkBom('package-msix.ps1 带 BOM', 'scripts/package-msix.ps1')
  checkBom('package-msix-bundle.ps1 带 BOM', 'scripts/package-msix-bundle.ps1')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

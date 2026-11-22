import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`通过：${name}`);
  } else {
    failed += 1;
    console.error(`失败：${name}`);
  }
}

const windows = JSON.parse(read('src-tauri/tauri.windows.conf.json'));
const hooks = read('src-tauri/installer-hooks.nsh');
const template = fs.existsSync(path.join(root, 'src-tauri/installer.nsi'))
  ? read('src-tauri/installer.nsi') : '';

check('Windows NSIS 使用受版本控制的安装器模板', windows.bundle?.windows?.nsis?.template === 'installer.nsi');
check('安装器内卸载显式传递保留数据与更新标记',
  /StrCpy \$R1 "\$R1 \/KEEP_APP_DATA \/UPDATE"\r?\n\s*\$\{IfThen\} \$PassiveMode = 1/.test(template));
check('卸载入口识别保护参数并忽略删除数据勾选',
  /GetOptions\} \$CMDLINE "\/KEEP_APP_DATA" \$HcKeepAppData[\s\S]*?StrCpy \$DeleteAppDataCheckboxState 0/.test(hooks));
check('安装器内卸载不会删除快捷方式和启动项',
  /StrCpy \$DeleteAppDataCheckboxState 0\r?\n\s*StrCpy \$UpdateMode 1/.test(hooks));
check('其它 Tauri 安装目录的清理同样保留数据',
  /HcCleanupOtherTauriInstall[\s\S]*?StrCpy \$HcCleanupArgs "\/KEEP_APP_DATA \/UPDATE"/.test(hooks));
check('独立卸载仍保留用户明确删除数据的原始能力',
  /\$\{If\} \$DeleteAppDataCheckboxState = 1\r?\n\s*\$\{AndIf\} \$UpdateMode <> 1[\s\S]*?RmDir \/r "\$APPDATA\\\$\{BUNDLEID\}"/.test(template));

console.log(`结果：${passed} 通过 / ${failed} 失败`);
process.exitCode = failed ? 1 : 0;

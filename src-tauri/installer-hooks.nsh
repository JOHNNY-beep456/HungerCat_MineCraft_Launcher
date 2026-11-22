; 覆盖安装兼容钩子：复用旧 Electron 安装目录，并在保留用户数据的前提下移除旧程序。
; Electron 的注册键由 appId 经 UUID v5 生成，不是 appId 本身：
;   卸载：Software\Microsoft\Windows\CurrentVersion\Uninstall\92545c4c-67bc-5d37-9e32-fd7da970a258
;   路径：Software\92545c4c-67bc-5d37-9e32-fd7da970a258 的 InstallLocation

!define HC_ELECTRON_GUID "92545c4c-67bc-5d37-9e32-fd7da970a258"
!define HC_ELECTRON_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${HC_ELECTRON_GUID}"
!define HC_ELECTRON_INSTALLKEY "Software\${HC_ELECTRON_GUID}"

Var /GLOBAL HcOldInstallDir
Var /GLOBAL HcOldMode
Var /GLOBAL HcCleanupUninstall
Var /GLOBAL HcCleanupDir
Var /GLOBAL HcCleanupArgs
Var /GLOBAL HcCleanupUninstallName
Var /GLOBAL HcCleanupRunningExe
Var /GLOBAL HcCleanupExePath
Var /GLOBAL HcCleanupTemp
Var /GLOBAL HcKeepAppData

Function HcRunExistingUninstaller
  ; 从带引号的 UninstallString 中取出卸载器路径；缺省时使用对应产品的固定文件名。
  StrCpy $HcCleanupExePath ""
  ${If} $HcCleanupUninstall != ""
    StrCpy $HcCleanupExePath $HcCleanupUninstall "" 1
    StrCpy $2 '"'
    ${StrLoc} $1 $HcCleanupExePath $2 ">"
    ${If} $1 > 0
      StrCpy $HcCleanupExePath $HcCleanupExePath $1
    ${Else}
      StrCpy $HcCleanupExePath ""
    ${EndIf}
  ${EndIf}
  ${If} $HcCleanupExePath == ""
    StrCpy $HcCleanupExePath "$HcCleanupDir\$HcCleanupUninstallName"
  ${EndIf}
  ${If} $HcCleanupDir == ""
    ${GetParent} $HcCleanupExePath $HcCleanupDir
  ${EndIf}
  ${If} $HcCleanupDir == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法确认旧版安装目录，已停止安装；用户数据未被修改。" /SD IDOK
    Abort
  ${EndIf}
  IfFileExists "$HcCleanupExePath" hc_cleanup_uninstaller_present 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "找不到旧版卸载器，已停止安装；用户数据未被修改。" /SD IDOK
    Abort
  hc_cleanup_uninstaller_present:

  StrCpy $HcCleanupTemp "$PLUGINSDIR\hcmcl-old-uninstaller.exe"
  ClearErrors
  CopyFiles /SILENT "$HcCleanupExePath" "$HcCleanupTemp"
  ${If} ${Errors}
    ExecWait '"$HcCleanupExePath" /S $HcCleanupArgs _?=$HcCleanupDir' $0
  ${Else}
    ExecWait '"$HcCleanupTemp" /S $HcCleanupArgs _?=$HcCleanupDir' $0
  ${EndIf}
  ${If} $0 <> 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "旧版卸载失败（代码 $0），已停止安装；用户数据未被修改。" /SD IDOK
    Abort
  ${EndIf}

  ; 有界等待文件删除完成，不能让旧进程或杀软锁定造成两版并存。
  StrCpy $1 0
  hc_cleanup_wait:
    IfFileExists "$HcCleanupDir\$HcCleanupRunningExe" 0 hc_cleanup_done
    Sleep 500
    IntOp $1 $1 + 1
    IntCmp $1 60 hc_cleanup_failed hc_cleanup_wait hc_cleanup_wait
  hc_cleanup_failed:
    MessageBox MB_OK|MB_ICONEXCLAMATION "旧版程序仍未移除，已停止安装。请关闭旧版后重试；用户数据未被修改。" /SD IDOK
    Abort
  hc_cleanup_done:
FunctionEnd

!macro HcCleanupOtherTauriInstall ROOT_KEY
  ReadRegStr $HcCleanupUninstall ${ROOT_KEY} "${UNINSTKEY}" "UninstallString"
  ReadRegStr $HcCleanupDir ${ROOT_KEY} "${MANUPRODUCTKEY}" ""
  ${If} $HcCleanupUninstall != ""
    ${If} $HcCleanupDir == ""
      StrCpy $2 1
    ${ElseIf} $HcCleanupDir != $INSTDIR
      StrCpy $2 1
    ${Else}
      StrCpy $2 0
    ${EndIf}
    ${If} $2 = 1
      StrCpy $HcCleanupArgs "/KEEP_APP_DATA /UPDATE"
      StrCpy $HcCleanupUninstallName "uninstall.exe"
      StrCpy $HcCleanupRunningExe "${MAINBINARYNAME}.exe"
      !insertmacro CheckIfAppIsRunning "$HcCleanupDir\$HcCleanupRunningExe" "${PRODUCTNAME}"
      Call HcRunExistingUninstaller
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $HcOldInstallDir ""
  StrCpy $HcOldMode ""
  StrCpy $HcCleanupUninstall ""
  StrCpy $HcCleanupDir ""

  ; 先查当前用户安装，再查全机器安装；路径与卸载器必须来自 Electron 各自的注册键。
  ReadRegStr $HcCleanupUninstall HKCU "${HC_ELECTRON_UNINSTKEY}" "UninstallString"
  ReadRegStr $HcOldInstallDir HKCU "${HC_ELECTRON_INSTALLKEY}" "InstallLocation"
  ${If} $HcCleanupUninstall != ""
    StrCpy $HcOldMode "/currentuser"
    Call MultiUser.InstallMode.CurrentUser
  ${Else}
    ReadRegStr $HcCleanupUninstall HKLM "${HC_ELECTRON_UNINSTKEY}" "UninstallString"
    ReadRegStr $HcOldInstallDir HKLM "${HC_ELECTRON_INSTALLKEY}" "InstallLocation"
    ${If} $HcCleanupUninstall != ""
      StrCpy $HcOldMode "/allusers"
      Call MultiUser.InstallMode.AllUsers
    ${EndIf}
  ${EndIf}

  ${If} $HcCleanupUninstall != ""
    ${If} $HcOldInstallDir != ""
      StrCpy $INSTDIR $HcOldInstallDir
    ${EndIf}
    DetailPrint "检测到旧版（Electron），正在覆盖安装并保留用户数据…"
    StrCpy $HcCleanupArgs "/KEEP_APP_DATA --updated $HcOldMode"
    StrCpy $HcCleanupUninstallName "Uninstall HungerCat MineCraft Launcher.exe"
    StrCpy $HcCleanupRunningExe "HungerCat MineCraft Launcher.exe"
    !insertmacro CheckIfAppIsRunning "$HcOldInstallDir\$HcCleanupRunningExe" "${PRODUCTNAME}"
    Call HcRunExistingUninstaller
    StrCpy $INSTDIR $HcCleanupDir
  ${EndIf}

  ; 出错版本可能已经另装了一份 Tauri。目标目录之外的旧 Tauri 也一并移除，数据目录不动。
  !insertmacro HcCleanupOtherTauriInstall HKCU
  !insertmacro HcCleanupOtherTauriInstall HKLM
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 只有安装器传入保护参数时强制保留；独立卸载仍尊重用户的数据删除勾选。
  ${GetOptions} $CMDLINE "/KEEP_APP_DATA" $HcKeepAppData
  ${IfNot} ${Errors}
    StrCpy $DeleteAppDataCheckboxState 0
    StrCpy $UpdateMode 1
  ${EndIf}
!macroend

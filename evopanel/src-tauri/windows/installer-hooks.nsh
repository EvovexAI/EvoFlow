; EvoFlow: 安装后写入 ~/.evoflow/evopanel.json（默认用户目录）；卸载前不再弹窗、不自动删除用户数据。
; 许可协议由 Tauri `bundle.licenseFile` 的标准 MUI 许可页提供。
;
; 以下宏在 `!insertmacro MUI_PAGE_LICENSE` 之前生效（本文件在 Tauri 的 installer.nsi 里先于各 Page 插入）。
; 使用「单勾选」代替默认双 radio，避免接受/拒绝选项被挤到可视区外。
;
; 安装/卸载进程策略（轻量）：
;   一轮 taskkill（桌面父进程树 /T → gateway / 旧名）+ 短等 ~1.5s，
;   再探测关键文件是否可写；仍占用则弹 Retry，由用户退出后重试。
; 不再全机 Get-CimInstance Win32_Process，也不再多轮最长 ~15s 的写锁轮询。
;
; v0.3.9+: 进程清理改用 nsExec + taskkill 替代隐藏 PowerShell（-WindowStyle Hidden），
; 避免触发安全软件「隐藏执行 PowerShell」告警；install-data.ps1 与 PATH 清理
; 改用 nsExec::Exec 隐藏控制台窗口（不再依赖 -WindowStyle Hidden）。

!define MUI_LICENSEPAGE_CHECKBOX
!define MUI_LICENSEPAGE_CHECKBOX_TEXT "我已阅读并同意上述许可条款与免责声明"

; Desktop owns one gateway child (stdio). Kill parent tree first so the
; sidecar exits with it; then sweep leftover gateway / legacy names.
!macro EvpKillRunningAppProcesses
  DetailPrint "Stopping EvoFlow (desktop parent tree + gateway sidecar)..."
  ; Parent first (/T): takes stdio Gateway child with the desktop process tree.
  nsExec::Exec 'taskkill /IM "${MAINBINARYNAME}.exe" /F /T'
  Pop $0
  nsExec::Exec 'taskkill /IM "evoflow.exe" /F /T'
  Pop $0
  nsExec::Exec 'taskkill /IM "evopanel.exe" /F /T'
  Pop $0
  nsExec::Exec 'taskkill /IM "EvoPanel.exe" /F /T'
  Pop $0
  ; Leftover / orphaned sidecar (DLL locks under binaries\evoflow-gateway\_internal).
  nsExec::Exec 'taskkill /IM "evoflow-gateway.exe" /F /T'
  Pop $0
  ; Upgrade from older packages that still used the legacy binary name.
  nsExec::Exec 'taskkill /IM "backend-gateway.exe" /F /T'
  Pop $0
!macroend

; Brief settle after taskkill so handles can drop before overwrite/delete.
!macro EvpBriefSettle
  Sleep 1500
!macroend

; Returns: stack top = 1 if writable or missing; 0 if locked.
; Uses $R8/$R9 temporarily. Capture __COUNTER__ once so all labels match.
!macro EvpProbeFileWritable path
  !define EVP_PROBE_UID ${__COUNTER__}
  StrCpy $R8 1
  IfFileExists "${path}" 0 evp_probe_done_${EVP_PROBE_UID}
    ClearErrors
    FileOpen $R9 "${path}" a
    IfErrors 0 evp_probe_close_${EVP_PROBE_UID}
      StrCpy $R8 0
      Goto evp_probe_done_${EVP_PROBE_UID}
    evp_probe_close_${EVP_PROBE_UID}:
      FileClose $R9
  evp_probe_done_${EVP_PROBE_UID}:
  Push $R8
  !undef EVP_PROBE_UID
!macroend

!macro EvpProbeFailIfLocked path unlock_uid
  !insertmacro EvpProbeFileWritable "${path}"
  Pop $R7
  ${If} $R7 = 0
    Goto evp_unlock_fail_${unlock_uid}
  ${EndIf}
!macroend

!macro EvpEnsureInstallDirUnlocked
  !define EVP_UNLOCK_UID ${__COUNTER__}

  !insertmacro EvpKillRunningAppProcesses
  !insertmacro EvpBriefSettle

evp_unlock_retry_${EVP_UNLOCK_UID}:
  ; VC runtimes under gateway _internal (locked while gateway / knowledge MCP runs).
  ; PyInstaller onedir ships both msvcp140.dll and MSVCP140_1.dll (C++ STL + ABI).
  !insertmacro EvpProbeFailIfLocked "$INSTDIR\binaries\evoflow-gateway\_internal\msvcp140.dll" ${EVP_UNLOCK_UID}
  !insertmacro EvpProbeFailIfLocked "$INSTDIR\binaries\evoflow-gateway\_internal\msvcp140_1.dll" ${EVP_UNLOCK_UID}
  !insertmacro EvpProbeFailIfLocked "$INSTDIR\binaries\evoflow-gateway\_internal\vcruntime140.dll" ${EVP_UNLOCK_UID}
  !insertmacro EvpProbeFailIfLocked "$INSTDIR\binaries\evoflow-gateway\_internal\vcruntime140_1.dll" ${EVP_UNLOCK_UID}
  ; Builtin knowledge assets (copied into install tree; held open during vault warm/reindex).
  !insertmacro EvpProbeFailIfLocked "$INSTDIR\binaries\evoflow-gateway\_internal\evoflow\assets\builtin_knowledge_vaults\README.md" ${EVP_UNLOCK_UID}
  !insertmacro EvpProbeFailIfLocked "$INSTDIR\binaries\evoflow-gateway\evoflow-gateway.exe" ${EVP_UNLOCK_UID}
  !insertmacro EvpProbeFailIfLocked "$INSTDIR\${MAINBINARYNAME}.exe" ${EVP_UNLOCK_UID}
  Goto evp_unlock_ok_${EVP_UNLOCK_UID}

evp_unlock_fail_${EVP_UNLOCK_UID}:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
    "无法写入安装目录中的文件（仍被占用）。$\r$\n$\r$\n请完全退出 EvoFlow（含托盘），并在任务管理器确认已结束：$\r$\n  · evoflow.exe$\r$\n  · evoflow-gateway.exe（若仍残留）$\r$\n然后点击「重试」。$\r$\n$\r$\n若反复失败，请重启电脑后再安装。$\r$\n$\r$\n安装目录：$INSTDIR" \
    IDRETRY evp_unlock_retry_kill_${EVP_UNLOCK_UID}
  Abort
evp_unlock_retry_kill_${EVP_UNLOCK_UID}:
  !insertmacro EvpKillRunningAppProcesses
  !insertmacro EvpBriefSettle
  Goto evp_unlock_retry_${EVP_UNLOCK_UID}

evp_unlock_ok_${EVP_UNLOCK_UID}:
  !undef EVP_UNLOCK_UID
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Overwrite / upgrade: light stop + probe before copying binaries.
  !insertmacro EvpEnsureInstallDirUnlocked
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Migrate WebView2 data from old identifier (com.yintai.evopanel) to new (com.evovex.evoflow)
  IfFileExists "$APPDATA\com.yintai.evopanel" 0 evp_migrate_old_id_done
    IfFileExists "$APPDATA\com.evovex.evoflow" 0 evp_do_migrate
      ; New dir already exists - skip to avoid overwriting
      Goto evp_migrate_old_id_done
    evp_do_migrate:
      Rename "$APPDATA\com.yintai.evopanel" "$APPDATA\com.evovex.evoflow"
    evp_migrate_old_id_done:
  IfFileExists "$LOCALAPPDATA\com.yintai.evopanel" 0 evp_migrate_local_done
    IfFileExists "$LOCALAPPDATA\com.evovex.evoflow" 0 evp_do_migrate_local
      Goto evp_migrate_local_done
    evp_do_migrate_local:
      Rename "$LOCALAPPDATA\com.yintai.evopanel" "$LOCALAPPDATA\com.evovex.evoflow"
    evp_migrate_local_done:

  IfFileExists "$INSTDIR\windows\install-data.ps1" 0 evp_postinstall_skip
  ; 始终写 ~/.evoflow/evopanel.json；仅当用户勾选「将 evoflow CLI 添加到 PATH」时再改 PATH
  ; 使用 nsExec::Exec 代替 ExecWait + -WindowStyle Hidden，避免触发安全软件告警。
  ; nsExec 自身隐藏控制台窗口，无需 PowerShell -WindowStyle Hidden。
  ${If} $AddCliPathState = 1
    nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\windows\install-data.ps1" -InstallDir "$INSTDIR" -AddToPath'
  ${Else}
    nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\windows\install-data.ps1"'
  ${EndIf}
  evp_postinstall_skip:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Uninstall: one light kill so Delete of gateway tree is less likely to hit locked DLLs.
  !insertmacro EvpKillRunningAppProcesses
  !insertmacro EvpBriefSettle

  ; 不再询问是否删除本地数据；亦不自动执行 uninstall-data.ps1。

  ; 从用户 PATH 移除本安装的 CLI 目录（仅匹配本 $INSTDIR 下的 tools\evoflow）
  ; 使用 nsExec::Exec 代替 ExecWait + -WindowStyle Hidden，避免触发安全软件告警。
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$cli=[System.IO.Path]::GetFullPath((Join-Path '$INSTDIR' 'binaries\evoflow-gateway\tools\evoflow')).TrimEnd('\\'); $$userPath=[Environment]::GetEnvironmentVariable('Path','User'); if ($$userPath) { $$parts=@($$userPath -split ';' | Where-Object { $$_ -and $$_.Trim().Length -gt 0 }); $$kept=@(); foreach ($$p in $$parts) { try { if (-not [System.IO.Path]::GetFullPath($$p.TrimEnd('\\')).Equals($$cli, [StringComparison]::OrdinalIgnoreCase)) { $$kept += $$p } } catch { $$kept += $$p } }; [Environment]::SetEnvironmentVariable('Path', ($$kept -join ';'), 'User') }"`
  Pop $0

  ; Clean up old identifier data directories (com.yintai.evopanel)
  IfFileExists "$APPDATA\com.yintai.evopanel" 0 evp_cleanup_old_appdata
    RMDir /r "$APPDATA\com.yintai.evopanel"
  evp_cleanup_old_appdata:
  IfFileExists "$LOCALAPPDATA\com.yintai.evopanel" 0 evp_cleanup_old_local
    RMDir /r "$LOCALAPPDATA\com.yintai.evopanel"
  evp_cleanup_old_local:
!macroend

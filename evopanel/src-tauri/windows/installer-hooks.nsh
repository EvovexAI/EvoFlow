; EvoFlow: 安装后写入 ~/.evoflow/evopanel.json（默认用户目录）；卸载前不再弹窗、不自动删除用户数据。
; 许可协议由 Tauri `bundle.licenseFile` 的标准 MUI 许可页提供。
;
; 以下宏在 `!insertmacro MUI_PAGE_LICENSE` 之前生效（本文件在 Tauri 的 installer.nsi 里先于各 Page 插入）。
; 使用「单勾选」代替默认双 radio，避免接受/拒绝选项被挤到可视区外。
;
; 安装/卸载过程中通过 NSIS_HOOK_PREINSTALL / NSIS_HOOK_PREUNINSTALL
; 按桌面单进程模型清理：桌面主程序（父）→ evoflow-gateway sidecar（同进程 HTTP+stdio）
; → 仍引用安装目录的孤儿（含知识库 kb-mcp 的 node），避免
; _internal\msvcp140*.dll / vcruntime140*.dll / builtin_knowledge_vaults 被占用。
; 安装包路径不再有独立 TCP app-server 进程；升级时仍兼容旧名 backend-gateway.exe。
;
; v0.3.9+: 进程清理改用 nsExec + taskkill 替代隐藏 PowerShell（-WindowStyle Hidden），
; 避免触发安全软件「隐藏执行 PowerShell」告警；install-data.ps1 与 PATH 清理
; 改用 nsExec::Exec 隐藏控制台窗口（不再依赖 -WindowStyle Hidden）。
;
; Overwrite-install hardening: multi-pass taskkill + INSTDIR-scoped process stop +
; write-lock probe on VC runtimes / gateway / knowledge assets; Retry prompt if locked.

!define MUI_LICENSEPAGE_CHECKBOX
!define MUI_LICENSEPAGE_CHECKBOX_TEXT "我已阅读并同意上述许可条款与免责声明"

; Stop any process whose ExecutablePath or CommandLine references $INSTDIR.
; Catches orphaned kb-mcp node.exe that outlive evoflow-gateway (knowledge vault warm).
; Uses nsExec (no -WindowStyle Hidden). Does NOT kill unrelated system/user Node apps.
!macro EvpStopProcessesUnderInstallDir
  DetailPrint "Stopping processes still using the install directory..."
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$root=[System.IO.Path]::GetFullPath('$INSTDIR').TrimEnd('\\'); if (-not $$root) { exit 0 }; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $$ep=[string]$$_.ExecutablePath; $$cl=[string]$$_.CommandLine; $$hit=$$false; if ($$ep -and $$ep.StartsWith($$root,[StringComparison]::OrdinalIgnoreCase)) { $$hit=$$true }; if (-not $$hit -and $$cl -and $$cl.IndexOf($$root,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $$hit=$$true }; if ($$hit) { try { Stop-Process -Id $$.ProcessId -Force -ErrorAction SilentlyContinue } catch {} } }"`
  Pop $0
!macroend

; Desktop owns one gateway child (stdio). Kill parent tree first so the
; sidecar exits with it; then sweep leftover gateway / legacy names / INSTDIR orphans.
!macro EvpKillRunningAppProcesses
  DetailPrint "Stopping EvoFlow (desktop parent tree + gateway sidecar + knowledge orphans)..."
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
  ; Knowledge vault MCP often runs as node under gateway; orphans keep locking _internal.
  !insertmacro EvpStopProcessesUnderInstallDir
!macroend

; Wait for known EvoFlow processes to fully exit (polling, up to ~15s).
; Returns immediately if nothing is running.  Much more reliable than fixed Sleep
; on slow machines where child process teardown (kb-mcp node, PyInstaller _internal)
; can take longer than a hardcoded 2s.
;
; Implementation: probe the most-likely-to-be-locked file (gateway msvcp140.dll).
; If it's writable, the processes are gone.  This is locale-independent and
; more accurate than checking process names (catches orphan child processes too).
!macro EvpWaitForProcessExit
  !define EVP_WAIT_UID ${__COUNTER__}
  StrCpy $R9 0 ; iteration counter
evp_wait_loop_${EVP_WAIT_UID}:
  ; If the gateway VC runtime doesn't exist or is writable, we're done.
  IfFileExists "$INSTDIR\binaries\evoflow-gateway\_internal\msvcp140.dll" evp_wait_probe_${EVP_WAIT_UID}
    Goto evp_wait_end_${EVP_WAIT_UID}
evp_wait_probe_${EVP_WAIT_UID}:
  ClearErrors
  FileOpen $R8 "$INSTDIR\binaries\evoflow-gateway\_internal\msvcp140.dll" a
  IfErrors 0 evp_wait_close_${EVP_WAIT_UID}
    ; Still locked — wait more
    Goto evp_wait_sleep_${EVP_WAIT_UID}
  evp_wait_close_${EVP_WAIT_UID}:
    FileClose $R8
    ; File is writable — processes have exited
    Goto evp_wait_end_${EVP_WAIT_UID}
evp_wait_sleep_${EVP_WAIT_UID}:
  IntOp $R9 $R9 + 1
  ${If} $R9 > 30
    ; ~15s total (500ms * 30) — give up, installer will probe + retry later
    Goto evp_wait_end_${EVP_WAIT_UID}
  ${EndIf}
  Sleep 500
  Goto evp_wait_loop_${EVP_WAIT_UID}
evp_wait_end_${EVP_WAIT_UID}:
  !undef EVP_WAIT_UID
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

  ; Multi-pass kill + wait-for-exit so delayed child exits (kb-mcp node)
  ; release DLL / asset handles.  Polling wait adapts to slow machines.
  !insertmacro EvpKillRunningAppProcesses
  !insertmacro EvpWaitForProcessExit
  !insertmacro EvpKillRunningAppProcesses
  !insertmacro EvpWaitForProcessExit
  !insertmacro EvpKillRunningAppProcesses
  !insertmacro EvpWaitForProcessExit

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
  !insertmacro EvpKillRunningAppProcesses
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
    "无法写入安装目录中的文件（仍被占用）。$\r$\n$\r$\n常见原因：桌面端或其唯一网关子进程（evoflow-gateway，含知识库 kb-mcp / node）仍在运行，会锁定：$\r$\n  · msvcp140.dll / msvcp140_1.dll / vcruntime140*.dll$\r$\n  · builtin_knowledge_vaults$\r$\n$\r$\n请完全退出 EvoFlow（含托盘），并在任务管理器结束：$\r$\n  · evoflow.exe（桌面）$\r$\n  · evoflow-gateway.exe（若仍残留）$\r$\n  · 命令行含本安装目录的 node.exe$\r$\n然后点击「重试」。$\r$\n$\r$\n若反复失败，请重启电脑后再安装。$\r$\n$\r$\n安装目录：$INSTDIR" \
    IDRETRY evp_unlock_retry_kill_${EVP_UNLOCK_UID}
  Abort
evp_unlock_retry_kill_${EVP_UNLOCK_UID}:
  !insertmacro EvpKillRunningAppProcesses
  !insertmacro EvpWaitForProcessExit
  Goto evp_unlock_retry_${EVP_UNLOCK_UID}

evp_unlock_ok_${EVP_UNLOCK_UID}:
  !undef EVP_UNLOCK_UID
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Overwrite / upgrade: stop running app + knowledge runtime before copying binaries.
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
  ; Uninstall: same multi-pass kill so Delete of gateway tree does not leave locked DLLs.
  !insertmacro EvpKillRunningAppProcesses
  !insertmacro EvpWaitForProcessExit
  !insertmacro EvpKillRunningAppProcesses
  !insertmacro EvpWaitForProcessExit

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

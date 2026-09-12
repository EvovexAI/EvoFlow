@echo off
setlocal EnableExtensions
rem =============================================================================
rem EvoFlow isolated desktop stack — SAME process model as the installer:
rem   Tauri owns one Gateway child (HTTP + stdio JSON-RPC). No EVOFLOW_GATEWAY_URL.
rem   Ports stay outside the packaged default scan when possible (prefer 8070).
rem
rem Legacy separate-uvicorn + mouthpiece: pass -ExternalGateway to start-dev-stack.
rem Web-only: start-dev-stack.ps1 -WebOnly
rem
rem Customize:
rem   set "EVOFLOW_GATEWAY_PORT=8070"
rem =============================================================================

set "SCRIPT_DIR=%~dp0"
rem Prefer sidecar bind port (mapped to EVOPANEL_BACKEND_PORT by start-dev-stack).
if not defined EVOFLOW_GATEWAY_PORT set "EVOFLOW_GATEWAY_PORT=8070"
rem Do NOT set EVOFLOW_GATEWAY_URL — that forces external Gateway / mouthpiece.
set "EVOFLOW_GATEWAY_URL="
set "VITE_EVOFLOW_GATEWAY_URL="
set "VITE_EVOFLOW_GATEWAY_PORT="
rem Frontend: avoid clashing with another local `tauri dev` on 1421 (packaged app does not use these).
set "EVOFLOW_VITE_PORT=1521"
set "EVOFLOW_VITE_HOST=0.0.0.0"
set "EVOFLOW_WEB_DEV_PORTS=1521"
set "EVOFLOW_TAURI_DEV_CONFIG=src-tauri/tauri.dev-isolated.conf.json"

echo [EvoFlow] Isolated pack-mode ports: sidecar prefer=%EVOFLOW_GATEWAY_PORT% Vite=%EVOFLOW_VITE_PORT%
echo [EvoFlow] Same as installer: Tauri owns Gateway+stdio (no separate uvicorn / mouthpiece).
echo [EvoFlow] Packaged app can keep defaults 8012 (or its auto-picked ports).
echo [EvoFlow] No evopanel\node_modules yet? Run: dev-stack-isolated.bat -InstallEvoPanel   OR   cd evopanel ^&^& npm run deps:ci
echo [EvoFlow] Need old external uvicorn mode? restart-dev-stack.bat -ExternalGateway
echo [EvoFlow] evoflow CLI: agent uses backend\.venv\Scripts\evoflow.exe after backend updates
echo.

set "RESTART=%SCRIPT_DIR%restart-dev-stack.bat"
if not exist "%RESTART%" (
  echo [EvoFlow] Missing: %RESTART%
  pause
  exit /b 1
)

call "%RESTART%" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo [EvoFlow] Dev stack stopped with exit code %RC%. See messages above.
  echo [EvoFlow] Missing deps? Try: dev-stack-isolated.bat -InstallEvoPanel   OR   cd evopanel ^&^& npm ci
) else (
  echo [EvoFlow] Dev stack exited normally ^(exit code 0^).
)
echo [EvoFlow] Pack mode: Gateway was a child of the desktop app — closing the window stops it.
pause
endlocal & exit /b %RC%

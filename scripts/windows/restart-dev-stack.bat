@echo off
setlocal

set SCRIPT_DIR=%~dp0
set PS_SCRIPT=%SCRIPT_DIR%restart-dev-stack.ps1

if not exist "%PS_SCRIPT%" (
  echo [EvoFlow] restart-dev-stack.ps1 not found:
  echo   %PS_SCRIPT%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*

if errorlevel 1 (
  echo.
  echo [EvoFlow] Restart failed. See output above.
  pause
  exit /b %errorlevel%
)

endlocal


@echo off
setlocal EnableExtensions

rem EvoPanel Windows release installer build (runs scripts\build.ps1: gateway sidecar + Tauri NSIS).
rem Args pass through to scripts\build.ps1:
rem   -Debug   fast debug build, no NSIS installer
rem   -Clean   cargo clean before build
rem Example: install.bat -Clean

set "ROOT=%~dp0"
cd /d "%ROOT%"
if errorlevel 1 exit /b 1

set "PS_SCRIPT=%ROOT%scripts\build.ps1"
if not exist "%PS_SCRIPT%" (
  echo [EvoPanel] build script not found:
  echo   %PS_SCRIPT%
  pause
  exit /b 1
)

if not exist "%ROOT%package.json" (
  echo [EvoPanel] Run this from the evopanel folder ^(need package.json^).
  echo   Current: %ROOT%
  pause
  exit /b 1
)

echo [EvoPanel] Starting release build ^(needs Node, Rust, WebView2, etc.^)
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*

if errorlevel 1 (
  echo.
  echo [EvoPanel] Build failed. See messages above.
  pause
  exit /b %errorlevel%
)

echo.
echo [EvoPanel] Done. If successful, installer is usually under:
echo   src-tauri\target\release\bundle\nsis\
echo.
pause
endlocal

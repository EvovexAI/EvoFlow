@echo off
setlocal EnableExtensions
rem =============================================================================
rem EvoFlow - local Windows NSIS setup.exe (no GitHub upload)
rem Same as: local-publish.ps1 -BuildDesktopInstaller
rem
rem Double-click this file, or:
rem   build-desktop-installer.bat
rem   build-desktop-installer.bat -InstallNpmDeps
rem
rem Output:
rem   evopanel\src-tauri\target\release\bundle\nsis\EvoFlow_*_x64-setup.exe
rem =============================================================================

set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%local-publish.ps1"

if not exist "%PS1%" (
  echo [EvoFlow] Missing: %PS1%
  pause
  exit /b 1
)

pushd "%SCRIPT_DIR%..\..\.."
if errorlevel 1 (
  echo [EvoFlow] Failed to cd to repo root from %SCRIPT_DIR%
  pause
  exit /b 1
)

echo [EvoFlow] Repo: %CD%
echo [EvoFlow] Building desktop installer - NSIS setup.exe - no upload
echo [EvoFlow] Output: evopanel\src-tauri\target\release\bundle\nsis\
echo [EvoFlow] Need clean npm ci? Pass -InstallNpmDeps
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -BuildDesktopInstaller %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo [EvoFlow] Build failed, exit code %RC%.
  echo [EvoFlow] Prerequisites: Node, Rust, uv - see scripts\maintainer\windows\README.md
) else (
  echo [EvoFlow] Done.
  if exist "evopanel\src-tauri\target\release\bundle\nsis\" (
    echo [EvoFlow] Artifacts:
    dir /b "evopanel\src-tauri\target\release\bundle\nsis\*setup.exe" 2>nul
  )
)
popd
echo.
pause
exit /b %RC%

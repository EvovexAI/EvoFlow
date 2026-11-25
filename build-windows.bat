@echo off
setlocal EnableExtensions
rem ============================================================================
rem  EvoFlow - double-click Windows build helper
rem
rem  Menu (default = 1):
rem    1  Gateway sidecar only   -> backend\dist\evoflow-gateway (PyInstaller)
rem                                 Fastest way to rebuild after backend changes.
rem                                 Needs: backend\.venv with pyinstaller.
rem    2  Full desktop installer -> evopanel\src-tauri\target\release\bundle
rem                                 (gateway sidecar + Tauri UI + NSIS setup.exe)
rem                                 Needs: Node.js, Rust/Cargo, WebView2.
rem    3  Lean sidecar           -> same as 1, but skips torch + bge model
rem                                 (much faster, local embedding disabled)
rem
rem  Pass a number as argument to skip the prompt:
rem    build-windows.bat 1
rem
rem  Logs are kept next to the build output; failures stay on screen.
rem ============================================================================

cd /d "%~dp0" || (echo [EvoFlow] Cannot enter repo folder & pause & exit /b 1)

set "GATEWAY_PS1=backend\packaging\windows\build-gateway-exe.ps1"
set "INSTALLER_PS1=evopanel\scripts\build-installer-win.ps1"

if not "%~1"=="" (
  set "CHOICE=%~1"
  goto :dispatch
)

echo.
echo  ==========================================
echo   EvoFlow Windows build
echo  ==========================================
echo.
echo   1  Gateway sidecar only      ^(fast; backend\dist\evoflow-gateway^)
echo   2  Full desktop installer    ^(slow; NSIS setup.exe^)
echo   3  Lean sidecar              ^(fast, no torch / no bge model^)
echo.
set /p "CHOICE=Select [1/2/3] (default 1): "
if "%CHOICE%"=="" set "CHOICE=1"

:dispatch
if not exist "%GATEWAY_PS1%" (
  echo [EvoFlow] Missing: %GATEWAY_PS1%
  pause
  exit /b 1
)

if "%CHOICE%"=="1" goto :gateway
if "%CHOICE%"=="3" goto :gateway_lean
if "%CHOICE%"=="2" goto :installer
echo [EvoFlow] Unknown choice: %CHOICE%
pause
exit /b 1

:gateway
powershell -NoProfile -ExecutionPolicy Bypass -File "%GATEWAY_PS1%"
goto :finish

:gateway_lean
powershell -NoProfile -ExecutionPolicy Bypass -File "%GATEWAY_PS1%" -LeanNoLocalEmbedding
goto :finish

:installer
if not exist "%INSTALLER_PS1%" (
  echo [EvoFlow] Missing: %INSTALLER_PS1%
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER_PS1%"
goto :finish

:finish
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo [EvoFlow] Build FAILED ^(exit code %RC%^). Scroll up for the first error.
  pause
  exit /b %RC%
)
echo [EvoFlow] Build finished.
echo.
echo   Sidecar:  backend\dist\evoflow-gateway\
echo   Installer: evopanel\src-tauri\target\release\bundle\
echo.
pause
endlocal & exit /b 0

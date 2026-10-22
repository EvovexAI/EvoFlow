@echo off
setlocal EnableExtensions
rem Generic entry for local-publish.ps1. Pass switches yourself, e.g.:
rem   local-publish.bat -BuildDesktopInstaller
rem Double-click build-desktop-installer.bat if you only want the NSIS setup.exe.
cd /d "%~dp0..\..\.."
if errorlevel 1 exit /b 1
echo Repo: %CD%
if not exist "%~dp0local-publish.env" (
  echo [EvoFlow] No local-publish.env - copy local-publish.env.example if you need TOS/SSH keys.
)
if "%~1"=="" (
  echo [EvoFlow] No args - for setup.exe only, double-click build-desktop-installer.bat
  echo.
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-publish.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%

@echo off
setlocal
cd /d "%~dp0..\.." || exit /b 1
echo Repo: %CD%
if not exist "%~dp0local-publish.env" (
  echo [EvoFlow] No scripts\maintainer\windows\local-publish.env — copy local-publish.env.example to local-publish.env for TOS/SSH keys.
)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-publish.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%

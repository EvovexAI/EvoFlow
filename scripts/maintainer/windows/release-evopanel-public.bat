@echo off
setlocal
cd /d "%~dp0..\.." || exit /b 1
echo Repo: %CD%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release-evopanel-public.ps1" %*
exit /b %ERRORLEVEL%

@echo off
setlocal EnableExtensions
set "DIR=%~dp0"
set "GW=%DIR%..\..\evoflow-gateway.exe"
if not exist "%GW%" set "GW=%DIR%..\evoflow-gateway.exe"
if exist "%GW%" (
  "%GW%" --mode cli %*
  exit /b %ERRORLEVEL%
)
echo evoflow: evoflow-gateway.exe not found next to bundled CLI (expected under tools\evoflow) 1>&2
exit /b 127

@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ============================================================================
rem  EvoFlow - double-click launcher (Windows, source checkout)
rem
rem  Just double-click this file. It starts the local backend stack:
rem    * LangGraph server  -> http://localhost:2024
rem    * Gateway API       -> http://localhost:8012
rem
rem  Requirements (already satisfied on a dev machine):
rem    * Git for Windows  (Git Bash is used to run scripts/serve.sh)
rem    * uv               (Python env manager used by scripts/serve.sh)
rem    * backend\.venv    (run: make install   once, from Git Bash)
rem
rem  To stop the services: press Ctrl+C in this window (or just close it).
rem
rem  Note: this launcher starts the BACKEND only. The desktop UI is started by
rem        double-clicking the installed EvoFlow shortcut / evoflow.exe.
rem ============================================================================

set "GATEWAY_PORT=8012"
set "LANGGRAPH_PORT=2024"
cd /d "%~dp0" || (
  echo [EvoFlow] Cannot enter repo folder: %~dp0
  pause
  exit /b 1
)

echo.
echo  ==========================================
echo   EvoFlow local stack
echo  ==========================================
echo   Repo:        %CD%
echo   LangGraph:   http://localhost:%LANGGRAPH_PORT%
echo   Gateway:     http://localhost:%GATEWAY_PORT%
echo.

rem --- already running? -------------------------------------------------------
netstat -ano | findstr /R /C:":%GATEWAY_PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [EvoFlow] Gateway port %GATEWAY_PORT% is already in use.
  echo [EvoFlow] EvoFlow may already be running. If it is, just use it.
  echo [EvoFlow] Otherwise stop the other process first ^(see: netstat -ano ^| findstr :%GATEWAY_PORT%^).
  echo.
  pause
  exit /b 0
)

rem --- prerequisites ----------------------------------------------------------
if not exist "scripts\serve.sh" (
  echo [EvoFlow] scripts\serve.sh not found - is this the repo root?
  pause
  exit /b 1
)
if not exist "scripts\run-with-git-bash.cmd" (
  echo [EvoFlow] scripts\run-with-git-bash.cmd not found.
  pause
  exit /b 1
)
if not exist "backend\.venv\Scripts\python.exe" (
  echo [EvoFlow] backend\.venv is missing.
  echo [EvoFlow] Create it once from Git Bash:
  echo            make install
  pause
  exit /b 1
)
if not exist "config.yaml" if not exist "backend\config.yaml" (
  echo [EvoFlow] config.yaml is missing.
  echo [EvoFlow] Generate it once from Git Bash:
  echo            make config
  pause
  exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
  echo [EvoFlow] git.exe not found on PATH. Install Git for Windows first.
  pause
  exit /b 1
)

rem --- run --------------------------------------------------------------------
echo [EvoFlow] Starting services... ^(first start can take a minute^)
echo [EvoFlow] Keep this window open. Press Ctrl+C to stop.
echo.

call "scripts\run-with-git-bash.cmd" ./scripts/serve.sh
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo [EvoFlow] Services stopped with exit code %RC%.
  echo [EvoFlow] Check the logs above, or logs\ under the repo for details.
) else (
  echo [EvoFlow] Services stopped.
)
pause
endlocal & exit /b %RC%

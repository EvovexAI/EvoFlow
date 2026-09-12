@echo off
setlocal EnableExtensions

REM Mirrors GitHub Actions: backend-unit-tests.yml + lint-check.yml + docs.yml (full ci-local.sh).
REM Requires: Git for Windows with bash, uv, Node 22 plus npm, Python 3.12 plus pip for MkDocs. ASCII-only.
REM
REM   scripts\run-github-checks-local.bat
REM       DEFAULT: full CI (tests + backend lint + evopanel npm ci/typecheck/test/build + docs)
REM   scripts\run-github-checks-local.bat no-docs
REM       Faster: skip OpenAPI diff + mkdocs (same as ci-local.sh --no-docs)
REM   scripts\run-github-checks-local.bat quick
REM       Pre-commit style: backend lint + evopanel tsc only (ci-local.sh --quick)
REM   scripts\run-github-checks-local.bat full
REM       Same as default (explicit); remaining args pass through after "full"
REM   Any other first token: pass all args to ci-local.sh (e.g. --no-docs alone)

set "RUNNER=%~dp0run-with-git-bash.cmd"
pushd "%~dp0.." || (
  echo ERROR: pushd to repo root failed. Script dir: %~dp0
  exit /b 1
)

if not exist "scripts\ci-local.sh" (
  echo ERROR: scripts\ci-local.sh not found from "%CD%"
  popd
  exit /b 1
)

echo.
echo [%DATE% %TIME%] Repo root: %CD%
echo.

if "%~1"=="" (
  echo [mode] default: FULL ci-local.sh (includes Docs workflow)
  call "%RUNNER%" ./scripts/ci-local.sh
  goto :finalize
)

if /i "%~1"=="no-docs" (
  echo [mode] no-docs: skip docs / mkdocs / openapi gate
  shift
  call "%RUNNER%" ./scripts/ci-local.sh --no-docs %*
  goto :finalize
)

if /i "%~1"=="full" (
  echo [mode] full: same as default (all workflows)
  shift
  call "%RUNNER%" ./scripts/ci-local.sh %*
  goto :finalize
)

if /i "%~1"=="quick" (
  echo [mode] quick
  shift
  call "%RUNNER%" ./scripts/ci-local.sh --quick %*
  goto :finalize
)

echo [mode] passthrough: %*
call "%RUNNER%" ./scripts/ci-local.sh %*

:finalize
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
  echo.
  echo =============================================================================
  echo   FAILED  exit code %RC%
  echo =============================================================================
  pause
  exit /b %RC%
)

echo.
echo =============================================================================
echo   All requested checks finished successfully.
echo =============================================================================
exit /b 0

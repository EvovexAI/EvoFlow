# Launch installed EvoFlow but prefer editable backend (thinking-off / local fixes).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\maintainer\windows\run-installed-with-dev-gateway.ps1
param(
  [string]$InstallExe = "D:\app\EvoFlow\evoflow.exe",
  [string]$BackendDir = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
if ([string]::IsNullOrWhiteSpace($BackendDir)) {
  $BackendDir = Join-Path $RepoRoot "backend"
}
if (-not (Test-Path -LiteralPath $InstallExe)) {
  throw "Install exe missing: $InstallExe"
}
if (-not (Test-Path -LiteralPath (Join-Path $BackendDir "packages\harness\evoflow"))) {
  throw "Backend dir invalid: $BackendDir"
}

$env:EVOFLOW_BACKEND_DIR = $BackendDir
$env:EVOFLOW_USE_PACKAGED_SIDECAR = "0"
Remove-Item Env:EVOPANEL_BACKEND_EXE_PATH -ErrorAction SilentlyContinue

Write-Host "[run] $InstallExe"
Write-Host "[run] EVOFLOW_BACKEND_DIR=$BackendDir"
Start-Process -FilePath $InstallExe -WorkingDirectory (Split-Path -Parent $InstallExe)

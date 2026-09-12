# Wrapper only (ASCII). Real build: .\scripts\build.ps1
# Same switches: -Debug, -Clean

param(
    [switch]$Debug,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$inner = Join-Path $PSScriptRoot "scripts\build.ps1"
if (-not (Test-Path -LiteralPath $inner)) {
    Write-Host "[fail] Missing: $inner" -ForegroundColor Red
    exit 1
}

& $inner -Debug:$Debug -Clean:$Clean
exit $LASTEXITCODE

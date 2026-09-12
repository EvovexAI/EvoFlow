param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ScriptDir = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$BackendDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir "..\.."))
$KbRoot = Join-Path $BackendDir "packaging\kb-mcp"
$PkgJson = Join-Path $KbRoot "package.json"
$OhsJs = Join-Path $KbRoot "node_modules\obsidian-hybrid-search\dist\src\server.js"
$WriteJs = Join-Path $KbRoot "node_modules\obsidian-mcp-server\dist\index.js"

if (-not (Test-Path -LiteralPath $PkgJson)) {
  Write-Error "[kb-mcp] missing $PkgJson"
  exit 1
}

if ((Test-Path -LiteralPath $OhsJs) -and (Test-Path -LiteralPath $WriteJs) -and -not $Force) {
  Write-Host "[kb-mcp] already installed under $KbRoot (use -Force to refresh)"
  exit 0
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npm) {
  Write-Error "[kb-mcp] npm not found. Install Node.js 18+ and retry."
  exit 1
}

Push-Location $KbRoot
try {
  Write-Host "[kb-mcp] npm install in $KbRoot"
  & $npm.Source install --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit $LASTEXITCODE" }
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $OhsJs)) {
  Write-Error "[kb-mcp] OHS entry missing after install: $OhsJs"
  exit 1
}
if (-not (Test-Path -LiteralPath $WriteJs)) {
  Write-Error "[kb-mcp] write MCP entry missing after install: $WriteJs"
  exit 1
}

Write-Host "[kb-mcp] ready: $KbRoot"

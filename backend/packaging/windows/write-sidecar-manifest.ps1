# Write sidecar-manifest.json next to the PyInstaller gateway tree.
# Desktop startup pins panel_version to CARGO_PKG_VERSION (same-package engine).
param(
  [Parameter(Mandatory = $true)]
  [string]$GatewayDir
)

$ErrorActionPreference = "Stop"

$ScriptDir = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$BackendDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir "..\.."))
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $BackendDir ".."))
$GatewayAbs = [System.IO.Path]::GetFullPath($GatewayDir)

if (-not (Test-Path -LiteralPath $GatewayAbs)) {
  throw "write-sidecar-manifest: gateway dir missing: $GatewayAbs"
}

$verFile = Join-Path $RepoRoot "evopanel\VERSION"
if (-not (Test-Path -LiteralPath $verFile)) {
  throw "write-sidecar-manifest: missing $verFile"
}
$panelVersion = (Get-Content -LiteralPath $verFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($panelVersion)) {
  throw "write-sidecar-manifest: empty evopanel/VERSION"
}

$exeCandidates = @(
  (Join-Path $GatewayAbs "evoflow-gateway.exe"),
  (Join-Path $GatewayAbs "evoflow-gateway")
)
$exePath = $null
foreach ($c in $exeCandidates) {
  if (Test-Path -LiteralPath $c) {
    $exePath = $c
    break
  }
}

function Get-Sha256Hex([string]$Path) {
  # Prefer .NET — GitHub Actions / constrained hosts may lack Get-FileHash cmdlet.
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $fs = [System.IO.File]::OpenRead($Path)
    try {
      $hash = $sha.ComputeHash($fs)
    } finally {
      $fs.Dispose()
    }
    return ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

$exeSha = ""
if ($exePath) {
  $exeSha = Get-Sha256Hex -Path $exePath
}

$builtAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
$manifest = [ordered]@{
  schema         = 1
  product        = "evoflow-gateway"
  panel_version  = $panelVersion
  built_at       = $builtAt
  exe_sha256     = $exeSha
}

$outPath = Join-Path $GatewayAbs "sidecar-manifest.json"
$json = ($manifest | ConvertTo-Json -Compress)
# UTF-8 without BOM (PS 5.1 Set-Content -Encoding utf8 writes BOM)
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($outPath, $json, $utf8)
Write-Host "[sidecar-manifest] wrote $outPath (panel_version=$panelVersion)"

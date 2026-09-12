param(
  [Parameter(Mandatory = $true)]
  [string]$GatewayDir,
  # When set, allow tools/agent-browser/browsers (offline/full fat).
  [switch]$AllowChromium,
  # When set, allow _internal/torch (local embedding fat build).
  [switch]$AllowLocalEmbedding
)

$ErrorActionPreference = "Stop"

function Test-EnvFlag([string]$Name) {
  $v = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($v)) { return $false }
  return $v.Trim().ToLower() -in @("1", "true", "yes", "on")
}

if (-not (Test-Path -LiteralPath $GatewayDir)) {
  throw "[lean-assert] gateway dir missing: $GatewayDir"
}

$allowChromium = $AllowChromium -or (Test-EnvFlag "EVOFLOW_BUNDLE_CHROMIUM")
$allowLocalEmbed = $AllowLocalEmbedding -or (Test-EnvFlag "EVOFLOW_GATEWAY_INCLUDE_LOCAL_EMBEDDING")

$errors = New-Object System.Collections.Generic.List[string]

$browsers = Join-Path $GatewayDir "tools\agent-browser\browsers"
if ((-not $allowChromium) -and (Test-Path -LiteralPath $browsers)) {
  $chromeDirs = @(Get-ChildItem -LiteralPath $browsers -Directory -Filter "chrome-*" -ErrorAction SilentlyContinue)
  $mb = 0.0
  try {
    $sum = (Get-ChildItem -LiteralPath $browsers -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    if ($null -ne $sum) { $mb = [math]::Round($sum / 1MB, 1) }
  } catch {}
  $errors.Add("Chromium prebundled at $browsers ($mb MB, $($chromeDirs.Count) chrome-* dirs). Lean desktop must omit this. Unset EVOFLOW_BUNDLE_CHROMIUM and rebuild; strip packaging/agent-browser-bundle/browsers.")
}

$torch = Join-Path $GatewayDir "_internal\torch"
if ((-not $allowLocalEmbed) -and (Test-Path -LiteralPath $torch)) {
  $mb = 0.0
  try {
    $sum = (Get-ChildItem -LiteralPath $torch -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    if ($null -ne $sum) { $mb = [math]::Round($sum / 1MB, 1) }
  } catch {}
  $errors.Add("torch bundled at $torch ($mb MB). Lean desktop must omit local embedding stack. Unset EVOFLOW_GATEWAY_INCLUDE_LOCAL_EMBEDDING and rebuild with a clean PyInstaller dist.")
}

$st = Join-Path $GatewayDir "_internal\sentence_transformers"
if ((-not $allowLocalEmbed) -and (Test-Path -LiteralPath $st)) {
  $errors.Add("sentence_transformers bundled at $st. Lean desktop must omit it (same as torch).")
}

# Public installer must not ship scrubbed skill packs or OpenClaw compatibility residue.
$skillsPublic = Join-Path $GatewayDir "skills\public"
if (Test-Path -LiteralPath $skillsPublic) {
  foreach ($banned in @(
      "desktop-control",
      "wechat-chat",
      "content-hunter",
      "canvas",
      "gh-issues",
      "newmedia-operations",
      "aihot",
      "wechat-mp-writer-skill-mxx"
    )) {
    $p = Join-Path $skillsPublic $banned
    if (Test-Path -LiteralPath $p) {
      $errors.Add("Scrubbed skill still bundled: skills/public/$banned (must be pruned before ship).")
    }
  }
  $scanExt = @('.md', '.js', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.txt')
  $brandHits = @(
    Get-ChildItem -LiteralPath $skillsPublic -Recurse -File -Force -ErrorAction SilentlyContinue |
      Where-Object { $scanExt -contains $_.Extension.ToLowerInvariant() } |
      ForEach-Object {
        try {
          $text = [System.IO.File]::ReadAllText($_.FullName)
        } catch {
          return
        }
        if ($text -match '(?i)openclaw|\.openclaw\b') {
          $_.FullName.Substring($skillsPublic.Length).TrimStart('\', '/')
        }
      }
  )
  if ($brandHits.Count -gt 0) {
    $sample = ($brandHits | Select-Object -First 5) -join ', '
    $errors.Add("OpenClaw / ~/.openclaw residue in bundled skills ($($brandHits.Count) file(s)), e.g. $sample")
  }
}

# Soft size guard: lean sidecar should stay well under ~800MB uncompressed.
$totalSum = (Get-ChildItem -LiteralPath $GatewayDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
$totalMb = if ($null -ne $totalSum) { [math]::Round($totalSum / 1MB, 1) } else { 0 }
$limitMb = 900
if ((-not $allowChromium) -and (-not $allowLocalEmbed) -and ($totalMb -gt $limitMb)) {
  $errors.Add("Gateway sidecar is $totalMb MB (lean limit ${limitMb}MB). Likely Chromium/torch/other bloat still present.")
}

if ($errors.Count -gt 0) {
  Write-Host "[lean-assert] FAILED for $GatewayDir (total ${totalMb} MB)" -ForegroundColor Red
  foreach ($e in $errors) {
    Write-Host "  - $e" -ForegroundColor Red
  }
  throw "[lean-assert] lean gateway bundle checks failed ($($errors.Count) issue(s))"
}

Write-Host "[lean-assert] OK: $GatewayDir (${totalMb} MB; chromium=$allowChromium localEmbed=$allowLocalEmbed)" -ForegroundColor Green

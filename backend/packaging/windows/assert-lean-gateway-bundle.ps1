param(
  [Parameter(Mandatory = $true)]
  [string]$GatewayDir,
  # When set, allow tools/agent-browser/browsers (offline/full fat).
  [switch]$AllowChromium,
  # When set, allow _internal/torch (local embedding fat build).
  [switch]$AllowLocalEmbedding,
  # When set, allow tools/whisper (offline ASR; pulls torch ~500MB+).
  [switch]$AllowWhisper
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
$allowWhisper = $AllowWhisper -or (Test-EnvFlag "EVOFLOW_BUNDLE_WHISPER")

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

$whisper = Join-Path $GatewayDir "tools\whisper"
if ((-not $allowWhisper) -and (Test-Path -LiteralPath $whisper)) {
  $mb = 0.0
  try {
    $sum = (Get-ChildItem -LiteralPath $whisper -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    if ($null -ne $sum) { $mb = [math]::Round($sum / 1MB, 1) }
  } catch {}
  $errors.Add("Whisper ASR bundled at $whisper ($mb MB). Lean desktop must omit it (openai-whisper pulls torch). Unset EVOFLOW_BUNDLE_WHISPER and rebuild.")
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

# Official product plugins: single in-package copy (PyInstaller datas).
# Sidecar official-plugins-bundle next to the exe is intentionally not shipped.
$officialBundle = Join-Path $GatewayDir "_internal\evoflow\plugins\bundled_official"
$requiredOfficial = @(
  "browser-use", "computer-use", "node-repl-host", "documents", "pdf",
  "presentations", "spreadsheets", "image-search", "plugin-creator", "skill-creator"
)
$sidecarDup = Join-Path $GatewayDir "official-plugins-bundle"
if (Test-Path -LiteralPath $sidecarDup) {
  $errors.Add("duplicate official-plugins-bundle sidecar present (plugins must live only under _internal/evoflow/plugins/bundled_official)")
}
if (-not (Test-Path -LiteralPath $officialBundle)) {
  $errors.Add("bundled_official missing under $GatewayDir (sync official-plugins-bundle before PyInstaller)")
} else {
  foreach ($name in $requiredOfficial) {
    $pluginDir = Join-Path $officialBundle $name
    $versioned = $false
    if (Test-Path -LiteralPath $pluginDir) {
      foreach ($ver in @(Get-ChildItem -LiteralPath $pluginDir -Directory -ErrorAction SilentlyContinue)) {
        if ($ver.Name -eq "0.0.0-stub") { continue }
        foreach ($rel in @(".zcode-plugin\plugin.json", ".evoflow-plugin\plugin.json")) {
          if (Test-Path -LiteralPath (Join-Path $ver.FullName $rel)) { $versioned = $true; break }
        }
        if ($versioned) { break }
      }
    }
    if (-not $versioned) {
      $errors.Add("official plugin missing/stub in bundled_official: $name (need <version>/.zcode-plugin)")
    }
  }
  $helperEntry = Join-Path $officialBundle "cua-helper\runtime\dist\windows-helper.js"
  $helperAddon = Join-Path $officialBundle "cua-helper\runtime\build\Release\ax_native.node"
  if (-not ((Test-Path -LiteralPath $helperEntry) -and (Test-Path -LiteralPath $helperAddon))) {
    $errors.Add("cua-helper runtime incomplete under bundled_official (need windows-helper.js + ax_native.node)")
  } elseif ((Get-Item -LiteralPath $helperAddon).Length -le 1024) {
    $errors.Add("cua-helper ax_native.node looks like a stub under bundled_official")
  }
}

# Asset Hub memory templates (Phase2 consolidate). PyInstaller must ship prompts/.
$consolidation = Join-Path $GatewayDir "_internal\evoflow\assets\prompts\memories\consolidation.md"
if (-not (Test-Path -LiteralPath $consolidation)) {
  $errors.Add("memory prompt missing: _internal/evoflow/assets/prompts/memories/consolidation.md (Phase2 FileNotFoundError on startup)")
}

# Builtin user guide for owned KB seed (小V xiaomi_knowledge_search).
$userGuide = Join-Path $GatewayDir "_internal\evoflow\assets\builtin_knowledge_vaults\user-guide"
if (-not (Test-Path -LiteralPath $userGuide)) {
  $errors.Add("builtin user-guide missing: _internal/evoflow/assets/builtin_knowledge_vaults/user-guide")
} else {
  $mdCount = @(Get-ChildItem -LiteralPath $userGuide -Recurse -Filter "*.md" -File -ErrorAction SilentlyContinue).Count
  if ($mdCount -lt 1) {
    $errors.Add("builtin user-guide has no .md files under $userGuide (seed would be empty)")
  }
}

# Xiaomi Frame voice: Silero VAD ONNX must ship with pipecat package data.
# Windows/Linux/arm64 mac always expect this; missing file →「语音管线启动失败」on packaged installs.
$sileroHits = @(
  Get-ChildItem -LiteralPath $GatewayDir -Recurse -Filter "silero_vad.onnx" -File -ErrorAction SilentlyContinue
)
if ($sileroHits.Count -lt 1) {
  $errors.Add("pipecat Silero ONNX missing (silero_vad.onnx). Rebuild with gateway.spec collect_data_files(pipecat, **/*.onnx) or Xiaomi realtime voice will fail at VAD load.")
}

# pipecat/__init__.py calls importlib.metadata.version("pipecat-ai"). Without
# dist-info the Frame session crashes right after ready → FE sees WS 1006 / no TTS.
$pipecatMeta = @(
  Get-ChildItem -LiteralPath $GatewayDir -Recurse -Directory -Filter "pipecat_ai-*.dist-info" -ErrorAction SilentlyContinue
) + @(
  Get-ChildItem -LiteralPath $GatewayDir -Recurse -Directory -Filter "pipecat-ai-*.dist-info" -ErrorAction SilentlyContinue
) + @(
  Get-ChildItem -LiteralPath $GatewayDir -Recurse -Directory -Filter "pipecat-*.dist-info" -ErrorAction SilentlyContinue
)
if ($pipecatMeta.Count -lt 1) {
  $errors.Add("pipecat-ai package metadata (*.dist-info) missing. Rebuild with copy_metadata('pipecat-ai') in gateway.spec or wake/TTS Frame session fails with PackageNotFoundError.")
}

# Soft size guard: lean sidecar should stay well under ~800MB uncompressed.
$totalSum = (Get-ChildItem -LiteralPath $GatewayDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
$totalMb = if ($null -ne $totalSum) { [math]::Round($totalSum / 1MB, 1) } else { 0 }
$limitMb = 900
if ((-not $allowChromium) -and (-not $allowLocalEmbed) -and (-not $allowWhisper) -and ($totalMb -gt $limitMb)) {
  $errors.Add("Gateway sidecar is $totalMb MB (lean limit ${limitMb}MB). Likely Chromium/torch/whisper/other bloat still present.")
}

if ($errors.Count -gt 0) {
  Write-Host "[lean-assert] FAILED for $GatewayDir (total ${totalMb} MB)" -ForegroundColor Red
  foreach ($e in $errors) {
    Write-Host "  - $e" -ForegroundColor Red
  }
  throw "[lean-assert] lean gateway bundle checks failed ($($errors.Count) issue(s))"
}

Write-Host "[lean-assert] OK: $GatewayDir (${totalMb} MB; chromium=$allowChromium localEmbed=$allowLocalEmbed whisper=$allowWhisper)" -ForegroundColor Green

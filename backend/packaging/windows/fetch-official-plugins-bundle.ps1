<#
.SYNOPSIS
  Windows wrapper for packaging/fetch-official-plugins-bundle.sh.

.DESCRIPTION
  Prefers Git Bash when available; otherwise unpacks the committed
  packaging/official-plugins-bundle.tar.gz, or optional URL/SOURCE/cache overrides.
#>
$ErrorActionPreference = "Stop"

$ScriptDir = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$PackagingDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
$Dest = Join-Path $PackagingDir "official-plugins-bundle"
$BashFetch = Join-Path $PackagingDir "fetch-official-plugins-bundle.sh"
$SyncPs1 = Join-Path $ScriptDir "sync-official-plugins-bundle.ps1"

function Test-PluginVersioned([string]$PluginDir) {
  if (-not (Test-Path -LiteralPath $PluginDir)) { return $false }
  $flat = Join-Path $PluginDir "plugin.json"
  if (Test-Path -LiteralPath $flat) {
    $raw = Get-Content -LiteralPath $flat -Raw -ErrorAction SilentlyContinue
    if ($raw -and ($raw -match '0\.0\.0-stub|stub - real plugin')) { return $false }
  }
  $versions = @(Get-ChildItem -LiteralPath $PluginDir -Directory -ErrorAction SilentlyContinue)
  foreach ($ver in $versions) {
    foreach ($rel in @(".zcode-plugin\plugin.json", ".evoflow-plugin\plugin.json")) {
      if (Test-Path -LiteralPath (Join-Path $ver.FullName $rel)) { return $true }
    }
  }
  return $false
}

function Test-BundleReady([string]$Root) {
  $required = @(
    "browser-use", "computer-use", "node-repl-host", "documents", "pdf",
    "presentations", "spreadsheets", "image-search", "plugin-creator", "skill-creator"
  )
  if (-not (Test-Path -LiteralPath $Root)) { return $false }
  foreach ($name in $required) {
    if (-not (Test-PluginVersioned (Join-Path $Root $name))) { return $false }
  }
  $helper = Join-Path $Root "cua-helper\runtime\dist\windows-helper.js"
  $addon = Join-Path $Root "cua-helper\runtime\build\Release\ax_native.node"
  if (-not ((Test-Path -LiteralPath $helper) -and (Test-Path -LiteralPath $addon))) { return $false }
  # Stub addon is ~1 byte; real native addon is much larger.
  return ((Get-Item -LiteralPath $addon).Length -gt 1024)
}

function Find-GitBash {
  $candidates = @(
    (Join-Path ${env:ProgramFiles} "Git\bin\bash.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Git\bin\bash.exe"),
    "C:\Program Files\Git\bin\bash.exe"
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

$bash = Find-GitBash
if ($bash -and (Test-Path -LiteralPath $BashFetch)) {
  Write-Host "[fetch-official-plugins] using Git Bash: $bash"
  $unixPath = ($BashFetch -replace '\\', '/')
  & $bash -lc "chmod +x `"$unixPath`" && `"$unixPath`""
  if ($LASTEXITCODE -ne 0) {
    throw "[fetch-official-plugins] bash fetch failed with exit $LASTEXITCODE"
  }
  exit 0
}

if (Test-BundleReady $Dest) {
  Write-Host "[fetch-official-plugins] OK (already populated)"
  exit 0
}

$src = [Environment]::GetEnvironmentVariable("EVOFLOW_OFFICIAL_PLUGINS_SOURCE")
if (-not [string]::IsNullOrWhiteSpace($src)) {
  Write-Host "[fetch-official-plugins] syncing from EVOFLOW_OFFICIAL_PLUGINS_SOURCE=$src"
  & $SyncPs1 -Source $src.Trim() -Dest $Dest
  if (-not (Test-BundleReady $Dest)) {
    throw "[fetch-official-plugins] sync left incomplete bundle"
  }
  Write-Host "[fetch-official-plugins] OK (synced from source dir)"
  exit 0
}

function Resolve-ReleaseAssetUrl([string]$Spec) {
  $ownerRepo = ""
  $tag = ""
  if ($Spec -match '@') {
    $parts = $Spec.Split('@', 2)
    $ownerRepo = $parts[0]
    $tag = $parts[1]
  } else {
    $tag = $Spec
    $ownerRepo = [Environment]::GetEnvironmentVariable("GITHUB_REPOSITORY")
  }
  if ([string]::IsNullOrWhiteSpace($ownerRepo) -or [string]::IsNullOrWhiteSpace($tag)) {
    throw "[fetch-official-plugins] EVOFLOW_OFFICIAL_PLUGINS_RELEASE needs owner/repo@tag"
  }
  $api = "https://api.github.com/repos/$ownerRepo/releases/tags/$tag"
  $headers = @{ Accept = "application/vnd.github+json"; "User-Agent" = "evoflow-fetch-official-plugins" }
  $token = [Environment]::GetEnvironmentVariable("EVOFLOW_OFFICIAL_PLUGINS_TOKEN")
  if ([string]::IsNullOrWhiteSpace($token)) {
    $token = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN")
  }
  if (-not [string]::IsNullOrWhiteSpace($token)) {
    $headers["Authorization"] = "Bearer $($token.Trim())"
  }
  $payload = Invoke-RestMethod -Uri $api -Headers $headers
  $wanted = @("official-plugins-bundle.tar.gz", "official-plugins-bundle.tgz", "official-plugins-bundle.zip")
  foreach ($name in $wanted) {
    $asset = @($payload.assets | Where-Object { $_.name -eq $name }) | Select-Object -First 1
    if ($null -ne $asset) {
      if ($asset.url) { return [string]$asset.url }
      if ($asset.browser_download_url) { return [string]$asset.browser_download_url }
    }
  }
  throw "[fetch-official-plugins] release $Spec has no official-plugins-bundle archive"
}

function Install-FromArchiveUrl([string]$Url) {
  $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("evoflow-plugins-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null
  try {
    $archive = if ($Url -match '\.zip($|\?)') {
      Join-Path $tmpRoot "bundle.zip"
    } else {
      Join-Path $tmpRoot "bundle.tar.gz"
    }
    Write-Host "[fetch-official-plugins] downloading $Url"
    $headers = @{ "User-Agent" = "evoflow-fetch-official-plugins" }
    $token = [Environment]::GetEnvironmentVariable("EVOFLOW_OFFICIAL_PLUGINS_TOKEN")
    if ([string]::IsNullOrWhiteSpace($token)) {
      $token = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN")
    }
    if ($Url -match 'api\.github\.com/.*/releases/assets/') {
      $headers["Accept"] = "application/octet-stream"
      if (-not [string]::IsNullOrWhiteSpace($token)) {
        $headers["Authorization"] = "Bearer $($token.Trim())"
      }
    } elseif ((-not [string]::IsNullOrWhiteSpace($token)) -and ($Url -match 'github\.com')) {
      $headers["Authorization"] = "Bearer $($token.Trim())"
    }
    Invoke-WebRequest -Uri $Url -OutFile $archive -Headers $headers
    $extract = Join-Path $tmpRoot "extract"
    New-Item -ItemType Directory -Path $extract -Force | Out-Null
    if ($archive -like "*.zip") {
      Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
    } else {
      tar -xzf $archive -C $extract
    }
    $srcDir = $extract
    $nested = Join-Path $extract "official-plugins-bundle"
    if (Test-Path -LiteralPath $nested) {
      $srcDir = $nested
    } else {
      $kids = @(Get-ChildItem -LiteralPath $extract -Directory -ErrorAction SilentlyContinue)
      if ($kids.Count -eq 1) { $srcDir = $kids[0].FullName }
    }
    if (-not (Test-BundleReady $srcDir)) {
      throw "[fetch-official-plugins] archive contents incomplete under $srcDir"
    }
    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    Get-ChildItem -LiteralPath $Dest -Force -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.Name -eq ".gitignore") { return }
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
    Copy-Item -Path (Join-Path $srcDir "*") -Destination $Dest -Recurse -Force
    if (-not (Test-Path -LiteralPath (Join-Path $Dest ".gitignore"))) {
      @(
        "# Populated by packaging sync/fetch (do not commit blobs).",
        "*",
        "!.gitignore"
      ) | Set-Content -LiteralPath (Join-Path $Dest ".gitignore") -Encoding utf8
    }
  } finally {
    Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-FromLocalArchive([string]$ArchivePath) {
  $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("evoflow-plugins-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null
  try {
    $extract = Join-Path $tmpRoot "extract"
    New-Item -ItemType Directory -Path $extract -Force | Out-Null
    if ($ArchivePath -like "*.zip") {
      Expand-Archive -LiteralPath $ArchivePath -DestinationPath $extract -Force
    } else {
      tar -xzf $ArchivePath -C $extract
    }
    $srcDir = $extract
    $nested = Join-Path $extract "official-plugins-bundle"
    if (Test-Path -LiteralPath $nested) {
      $srcDir = $nested
    } else {
      $kids = @(Get-ChildItem -LiteralPath $extract -Directory -ErrorAction SilentlyContinue)
      if ($kids.Count -eq 1) { $srcDir = $kids[0].FullName }
    }
    if (-not (Test-BundleReady $srcDir)) {
      throw "[fetch-official-plugins] archive contents incomplete under $srcDir"
    }
    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    Get-ChildItem -LiteralPath $Dest -Force -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.Name -eq ".gitignore") { return }
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
    Copy-Item -Path (Join-Path $srcDir "*") -Destination $Dest -Recurse -Force
    if (-not (Test-Path -LiteralPath (Join-Path $Dest ".gitignore"))) {
      @(
        "# Populated by packaging sync/fetch (do not commit blobs).",
        "*",
        "!.gitignore"
      ) | Set-Content -LiteralPath (Join-Path $Dest ".gitignore") -Encoding utf8
    }
  } finally {
    Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$repoArchive = Join-Path $PackagingDir "official-plugins-bundle.tar.gz"
if (Test-Path -LiteralPath $repoArchive) {
  Write-Host "[fetch-official-plugins] unpacking in-repo $repoArchive"
  Install-FromLocalArchive $repoArchive
  if (-not (Test-BundleReady $Dest)) {
    throw "[fetch-official-plugins] in-repo archive left incomplete bundle"
  }
  Write-Host "[fetch-official-plugins] OK (from in-repo archive)"
  exit 0
}

$url = [Environment]::GetEnvironmentVariable("EVOFLOW_OFFICIAL_PLUGINS_URL")
$release = [Environment]::GetEnvironmentVariable("EVOFLOW_OFFICIAL_PLUGINS_RELEASE")
if ([string]::IsNullOrWhiteSpace($url) -and (-not [string]::IsNullOrWhiteSpace($release))) {
  $url = Resolve-ReleaseAssetUrl $release.Trim()
}
if (-not [string]::IsNullOrWhiteSpace($url)) {
  Install-FromArchiveUrl $url.Trim()
  if (-not (Test-BundleReady $Dest)) {
    throw "[fetch-official-plugins] download left incomplete bundle"
  }
  Write-Host "[fetch-official-plugins] OK (from URL/release)"
  exit 0
}

# Fall back to local cache sync.
Write-Host "[fetch-official-plugins] trying local cache sync..."
& $SyncPs1 -Dest $Dest
if (Test-BundleReady $Dest) {
  Write-Host "[fetch-official-plugins] OK (synced from local cache)"
  exit 0
}

# All sources failed — refuse to ship empty/stub plugins unless explicitly allowed.
$allowStub = $env:EVOFLOW_ALLOW_OFFICIAL_PLUGINS_STUB -and (
  $env:EVOFLOW_ALLOW_OFFICIAL_PLUGINS_STUB.Trim().ToLower() -in @("1", "true", "yes", "on")
)
Write-Host @"
[fetch-official-plugins] ERROR: official-plugins-bundle is empty and no archive was found.

Expected committed archive:
  backend/packaging/official-plugins-bundle.tar.gz

Or set EVOFLOW_OFFICIAL_PLUGINS_SOURCE / URL / RELEASE, or sync from a local cache.

Dev-only escape hatch (NOT for release): EVOFLOW_ALLOW_OFFICIAL_PLUGINS_STUB=1
"@
if (-not $allowStub) {
  throw "[fetch-official-plugins] missing official plugins source (refusing stub for release safety)"
}

Write-Host "[fetch-official-plugins] WARNING: generating stub bundle (EVOFLOW_ALLOW_OFFICIAL_PLUGINS_STUB=1)"
$stubDirs = @(
  "browser-use", "computer-use", "node-repl-host", "documents", "pdf",
  "presentations", "spreadsheets", "image-search", "plugin-creator", "skill-creator"
)
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
foreach ($name in $stubDirs) {
  $dir = Join-Path $Dest "$name\0.0.0-stub\.zcode-plugin"
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  @{ name = $name; version = "0.0.0-stub"; description = "stub - real plugin not bundled" } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dir "plugin.json") -Encoding utf8
}
$helperDir = Join-Path $Dest "cua-helper\runtime\dist"
$addonDir = Join-Path $Dest "cua-helper\runtime\build\Release"
New-Item -ItemType Directory -Path $helperDir -Force | Out-Null
New-Item -ItemType Directory -Path $addonDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $helperDir "windows-helper.js") -Value "// stub`n" -Encoding utf8
# Pad past the size check (still not a real native addon).
[byte[]] $pad = New-Object byte[] 1025
[System.IO.File]::WriteAllBytes((Join-Path $addonDir "ax_native.node"), $pad)
if (-not (Test-Path -LiteralPath (Join-Path $Dest ".gitignore"))) {
  @(
    "# Populated by packaging sync/fetch (do not commit blobs).",
    "*",
    "!.gitignore"
  ) | Set-Content -LiteralPath (Join-Path $Dest ".gitignore") -Encoding utf8
}
Write-Host "[fetch-official-plugins] OK (stub bundle generated — do not ship)"

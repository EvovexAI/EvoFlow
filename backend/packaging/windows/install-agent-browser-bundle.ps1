param(
  [switch]$Force,
  # Desktop installers download Chromium on first browser use (~400MB).
  # Pass -IncludeChromium only for offline/dev full bundles.
  [switch]$IncludeChromium
)

$ErrorActionPreference = "Stop"
$ScriptDir = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$BackendDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir "..\.."))
$AbRoot = Join-Path $BackendDir "packaging\agent-browser-bundle"
$BrowsersRoot = Join-Path $AbRoot "browsers"
$BinDir = Join-Path $AbRoot "node_modules\.bin"

function Test-AgentBrowserCliPresent {
  $cli = Get-ChildItem -LiteralPath $BinDir -Filter "agent-browser*" -File -ErrorAction SilentlyContinue | Select-Object -First 1
  return ($null -ne $cli)
}

function Test-AgentBrowserChromiumPresent {
  $chrome = Get-ChildItem -LiteralPath $BrowsersRoot -Recurse -Filter "chrome.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($chrome) { return $true }
  $chrome = Get-ChildItem -LiteralPath $BrowsersRoot -Recurse -Filter "chrome" -File -ErrorAction SilentlyContinue | Select-Object -First 1
  return ($null -ne $chrome)
}

$wantChromium = $IncludeChromium -or (
  $env:EVOFLOW_BUNDLE_CHROMIUM -and
  $env:EVOFLOW_BUNDLE_CHROMIUM.Trim().ToLower() -in @("1", "true", "yes", "on")
)

if ((Test-AgentBrowserCliPresent) -and -not $Force) {
  if ($wantChromium -and -not (Test-AgentBrowserChromiumPresent)) {
    Write-Host "[agent-browser-bundle] CLI present but Chromium missing; refreshing with -IncludeChromium"
  } else {
    if (-not $wantChromium -and (Test-Path -LiteralPath $BrowsersRoot)) {
      Write-Host "[agent-browser-bundle] stripping prebundled Chromium (on-demand install at runtime)"
      Remove-Item -Path $BrowsersRoot -Recurse -Force
    }
    Write-Host "[agent-browser-bundle] already present under $AbRoot (use -Force to refresh)"
    exit 0
  }
}

if (Test-Path -LiteralPath $AbRoot) {
  Remove-Item -Path $AbRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $AbRoot -Force | Out-Null

@"
{
  "name": "evoflow-agent-browser-bundle",
  "private": true,
  "dependencies": {
    "agent-browser": "latest"
  }
}
"@ | Set-Content -Path (Join-Path $AbRoot "package.json") -Encoding UTF8

Push-Location $AbRoot
try {
  Write-Host "[agent-browser-bundle] npm install agent-browser -> $AbRoot"
  npm install --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }

  $env:PATH = "$BinDir;$env:PATH"

  if ($wantChromium) {
    Write-Host "[agent-browser-bundle] agent-browser install (Chromium -> %USERPROFILE%\.agent-browser\browsers)"
    agent-browser install
    if ($LASTEXITCODE -ne 0) { throw "agent-browser install failed: $LASTEXITCODE" }

    $userBrowsers = Join-Path $env:USERPROFILE ".agent-browser\browsers"
    if (-not (Test-Path -LiteralPath $userBrowsers)) {
      throw "agent-browser install finished but browsers dir missing: $userBrowsers"
    }
    if (Test-Path -LiteralPath $BrowsersRoot) {
      Remove-Item -Path $BrowsersRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $BrowsersRoot -Force | Out-Null
    # Copy only the newest chrome-* (user cache may accumulate versions).
    $newest = Get-ChildItem -LiteralPath $userBrowsers -Directory -Filter "chrome-*" -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      Select-Object -First 1
    if (-not $newest) {
      throw "No chrome-* directory under $userBrowsers"
    }
    Copy-Item -Path $newest.FullName -Destination (Join-Path $BrowsersRoot $newest.Name) -Recurse -Force
    Write-Host "[agent-browser-bundle] copied Chromium $($newest.Name) -> $BrowsersRoot"
  } else {
    Write-Host "[agent-browser-bundle] skip Chromium (runtime on-demand). Use -IncludeChromium or EVOFLOW_BUNDLE_CHROMIUM=1 to prebundle."
    if (Test-Path -LiteralPath $BrowsersRoot) {
      Remove-Item -Path $BrowsersRoot -Recurse -Force
    }
  }
}
finally {
  Pop-Location
}

Write-Host "[agent-browser-bundle] done"

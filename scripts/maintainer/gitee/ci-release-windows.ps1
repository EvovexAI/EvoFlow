#requires -Version 5.1
<#
.SYNOPSIS
  Gitee Go Windows agent entry: build NSIS independently, publish Gitee Release
  metadata + checksums, stage installer for CDN, refresh Gitee update/latest.json.

  Does NOT upload setup.exe to Gitee Releases (hard ~100MB limit).
  Does NOT mirror GitHub artifacts.

.ENVIRONMENT
  GITEE_REPO_TOKEN              required for Release + latest.json
  EVOFLOW_CN_INSTALLER_BASE_URL required public HTTPS base (no trailing slash)
  EVOFLOW_CN_INSTALLER_DIR      optional directory to copy installer into
  TAURI_SIGNING_*               optional updater signing
#>
$ErrorActionPreference = "Stop"
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
Set-Location -LiteralPath $RepoRoot

function Import-DotEnv([string]$LiteralPath) {
    if (-not (Test-Path -LiteralPath $LiteralPath)) { return }
    $raw = Get-Content -LiteralPath $LiteralPath -Raw -Encoding UTF8
    foreach ($line in $raw -split "`r?`n") {
        $t = $line.Trim()
        if ($t.Length -eq 0 -or $t.StartsWith('#')) { continue }
        $t = $t -replace '^\s*export\s+', ''
        $eq = $t.IndexOf('=')
        if ($eq -lt 1) { continue }
        $name = $t.Substring(0, $eq).Trim()
        $val = $t.Substring($eq + 1).Trim()
        if ($val.Length -ge 2) {
            $q = $val[0]
            if (($q -eq '"' -or $q -eq [char]39) -and $val[$val.Length - 1] -eq $q) {
                $val = $val.Substring(1, $val.Length - 2)
            }
        }
        [Environment]::SetEnvironmentVariable($name, $val, 'Process')
    }
}
Import-DotEnv (Join-Path $RepoRoot "scripts\maintainer\windows\local-publish.env")

Write-Host "=== Gitee independent Windows release ===" -ForegroundColor Cyan
Write-Host "RepoRoot=$RepoRoot"

$baseUrl = $env:EVOFLOW_CN_INSTALLER_BASE_URL
if (-not $baseUrl -or $baseUrl.Trim().Length -eq 0) {
    throw "Set EVOFLOW_CN_INSTALLER_BASE_URL (public HTTPS base for setup.exe, e.g. https://cdn.example.com/evoflow/releases)"
}
$baseUrl = $baseUrl.Trim().TrimEnd('/')

# --- toolchain / deps (mirrors GitHub Actions shape, Windows-native) ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js required on Gitee Windows agent" }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw "Rust/Cargo required on Gitee Windows agent" }
if (-not (Get-Command python -ErrorAction SilentlyContinue) -and -not (Get-Command py -ErrorAction SilentlyContinue)) {
    throw "Python 3.12+ required on Gitee Windows agent"
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    npm install -g pnpm@11
}
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv required on Gitee Windows agent (https://docs.astral.sh/uv/)"
}

Write-Host "=== backend uv sync ===" -ForegroundColor Cyan
Push-Location (Join-Path $RepoRoot "backend")
try {
    python (Join-Path $RepoRoot "scripts\ci\prepare-backend-uv-for-ci.py")
    $ok = $false
    for ($i = 1; $i -le 3; $i++) {
        uv sync --group dev
        if ($LASTEXITCODE -eq 0) { $ok = $true; break }
        Start-Sleep -Seconds 15
    }
    if (-not $ok) { throw "uv sync failed" }
    uv run python (Join-Path $RepoRoot "scripts\preflight-build-check.py")
    if ($LASTEXITCODE -ne 0) { throw "preflight-build-check failed" }
}
finally { Pop-Location }

$fetchPlugins = Join-Path $RepoRoot "backend\packaging\windows\fetch-official-plugins-bundle.ps1"
if (Test-Path -LiteralPath $fetchPlugins) {
    Write-Host "=== official plugins bundle ===" -ForegroundColor Cyan
    & powershell -NoProfile -ExecutionPolicy Bypass -File $fetchPlugins
    if ($LASTEXITCODE -ne 0) { throw "fetch-official-plugins-bundle failed" }
}

Write-Host "=== evopanel deps ===" -ForegroundColor Cyan
Push-Location (Join-Path $RepoRoot "evopanel")
try {
    $pnpmOk = $false
    for ($i = 1; $i -le 3; $i++) {
        pnpm install --frozen-lockfile
        if ($LASTEXITCODE -eq 0) { $pnpmOk = $true; break }
        Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 15
    }
    if (-not $pnpmOk) { throw "pnpm install failed" }

    Write-Host "=== build:desktop:win ===" -ForegroundColor Cyan
    pnpm run build:desktop:win
    if ($LASTEXITCODE -ne 0) { throw "build:desktop:win failed" }
}
finally { Pop-Location }

$ver = node -p "require('./evopanel/package.json').version"
$tag = "v$ver"
$nsis = Join-Path $RepoRoot "evopanel\src-tauri\target\release\bundle\nsis"
if (-not (Test-Path -LiteralPath $nsis)) { throw "NSIS dir missing: $nsis" }

$verMark = [regex]::Escape($ver)
$exe = Get-ChildItem -LiteralPath $nsis -Filter "*setup.exe" -File |
    Where-Object { $_.Name -match $verMark } | Select-Object -First 1
if (-not $exe) { throw "Missing setup.exe for v$ver under $nsis" }

$hash = (Get-FileHash -LiteralPath $exe.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$sumLine = "$hash  $($exe.Name)"
Set-Content -LiteralPath "$($exe.FullName).sha256" -Value $sumLine -Encoding ascii
Set-Content -LiteralPath (Join-Path $nsis "SHA256SUMS.txt") -Value $sumLine -Encoding ascii
Write-Host "Built $($exe.Name) sha256=$hash" -ForegroundColor Green

# Stage large assets for CDN (Gitee Releases cannot hold them).
$stageDir = $env:EVOFLOW_CN_INSTALLER_DIR
if ($stageDir -and $stageDir.Trim().Length -gt 0) {
    $stageDir = $stageDir.Trim()
    if (-not (Test-Path -LiteralPath $stageDir)) {
        New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
    }
    Write-Host "=== stage installer → $stageDir ===" -ForegroundColor Cyan
    Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $stageDir $exe.Name) -Force
    Copy-Item -LiteralPath "$($exe.FullName).sha256" -Destination (Join-Path $stageDir "$($exe.Name).sha256") -Force
    $zip = Get-ChildItem -LiteralPath $nsis -Filter "*.nsis.zip" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $verMark } | Select-Object -First 1
    if ($zip) {
        Copy-Item -LiteralPath $zip.FullName -Destination (Join-Path $stageDir $zip.Name) -Force
        if (Test-Path -LiteralPath "$($zip.FullName).sig") {
            Copy-Item -LiteralPath "$($zip.FullName).sig" -Destination (Join-Path $stageDir "$($zip.Name).sig") -Force
        }
    }
}

$installerUrl = "$baseUrl/$($exe.Name)"
Write-Host "Public installer URL: $installerUrl" -ForegroundColor Cyan

# Gitee Release: notes + small checksums only (skip huge exe inside publish script).
$notesPath = Join-Path $env:TEMP ("evoflow-gitee-notes-" + [guid]::NewGuid().ToString("n") + ".md")
try {
    $py = Get-Command python -ErrorAction SilentlyContinue
    if ($py) {
        & python (Join-Path $RepoRoot "scripts\ci\build-release-body.py") $ver $notesPath
    }
    $body = "EvoFlow $ver (Gitee independent Windows build)`n`nInstaller: $installerUrl"
    if ((Test-Path -LiteralPath $notesPath) -and ((Get-Item $notesPath).Length -gt 0)) {
        $body = [System.IO.File]::ReadAllText($notesPath, [System.Text.Encoding]::UTF8)
        $body = "$body`n`n---`nInstaller (CDN): $installerUrl`n"
    }

    Write-Host "=== Gitee Release (metadata + checksums) ===" -ForegroundColor Cyan
    & powershell -NoProfile -ExecutionPolicy Bypass -File `
        (Join-Path $RepoRoot "scripts\maintainer\windows\publish-gitee-release.ps1") `
        -Tag $tag -NsisDir $nsis -Body $body -Replace
    if ($LASTEXITCODE -ne 0) { throw "publish-gitee-release.ps1 failed" }

    Write-Host "=== Gitee update/latest.json (SkipGithub) ===" -ForegroundColor Cyan
    & powershell -NoProfile -ExecutionPolicy Bypass -File `
        (Join-Path $RepoRoot "scripts\maintainer\windows\push-public-latest-json.ps1") `
        -Tag $tag -NsisDir $nsis -SkipGithub -PrimaryUrl $installerUrl -InstallerHost gitee
    if ($LASTEXITCODE -ne 0) { throw "push-public-latest-json.ps1 failed" }
}
finally {
    Remove-Item -LiteralPath $notesPath -Force -ErrorAction SilentlyContinue
}

Write-Host "Done Gitee Windows release $tag" -ForegroundColor Green
Write-Host "  CDN/setup: $installerUrl"
Write-Host "  Manifest:  https://gitee.com/evovexai/EvoFlow/raw/main/update/latest.json"

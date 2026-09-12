# Local Windows desktop release helper for THIS public repo (EvovexAI/EvoFlow).
# Mirrors (approximately):
#   .github/workflows/release-windows-public.yml (build + checksums) -> -BuildDesktopInstaller
#   then attach installer to a NEW GitHub Release on EvovexAI/EvoFlow -> -CreatePublicGhRelease
#
# Config: copy scripts/maintainer/windows/local-publish.env.example -> scripts/maintainer/windows/local-publish.env (gitignored).
#         Optional: set env EVOFLOW_LOCAL_PUBLISH_ENV to an absolute path to use another file.
#
# Usage (from anywhere; script resolves repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\maintainer\windows\local-publish.ps1 -BuildDesktopInstaller
#   powershell ... -CreatePublicGhRelease
#   powershell ... -All
#   -All runs: BuildDesktopInstaller -> CreatePublicGhRelease (needs gh or GITHUB_TOKEN).
#
# Prerequisites:
#   Copy local-publish.env.example -> local-publish.env next to this script
#   -BuildDesktopInstaller: Node, Rust, uv; uses existing evopanel/node_modules (no npm ci unless -InstallNpmDeps). After NSIS build, only keeps installer/checksums for evopanel/package.json version (removes stale other-version files in bundle/nsis).
#   -CreatePublicGhRelease: GitHub CLI gh or GITHUB_TOKEN; uses version from evopanel/package.json. Only creates a NEW Release for that tag — never deletes assets or overwrites body/title on an existing Release (bump version for each upload). After upload, prune-public-github-releases.ps1 keeps only the newest 2 semver releases on EvovexAI/EvoFlow (env EVOFLOW_PUBLIC_RELEASE_KEEP_COUNT, default 2). Optional -PublicReleaseBodyPath (UTF-8 Markdown) overrides scripts/maintainer/windows/public-release-body.txt for the release body; env EVOFLOW_PUBLIC_RELEASE_BODY (path) also works.

param(
    [switch] $BuildDesktopInstaller,
    [switch] $CreatePublicGhRelease,
    [switch] $All,
    [switch] $InstallNpmDeps,
    # UTF-8 Markdown for -CreatePublicGhRelease (overrides public-release-body.txt). Env EVOFLOW_PUBLIC_RELEASE_BODY (path) also supported.
    [string] $PublicReleaseBodyPath = ""
)

$ErrorActionPreference = "Stop"
# scripts/maintainer/windows -> repo root
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
Set-Location -LiteralPath $RepoRoot

function Import-LocalPublishDotEnv {
    param([Parameter(Mandatory)][string]$LiteralPath)
    if (-not (Test-Path -LiteralPath $LiteralPath)) { return }
    Write-Host "[local-publish] Loading env file: $LiteralPath" -ForegroundColor DarkGray
    $raw = Get-Content -LiteralPath $LiteralPath -Raw -Encoding UTF8
    foreach ($line in $raw -split "`r?`n") {
        $t = $line.Trim()
        if ($t.Length -eq 0 -or $t.StartsWith('#')) { continue }
        $t = $t -replace '^\s*export\s+', ''
        $eq = $t.IndexOf('=')
        if ($eq -lt 1) { continue }
        $name = $t.Substring(0, $eq).Trim()
        if ($name.Length -eq 0) { continue }
        $val = $t.Substring($eq + 1).Trim()
        if ($val.Length -ge 2) {
            $q = $val[0]
            $last = $val[$val.Length - 1]
            if (($q -eq '"' -or $q -eq [char]39) -and $last -eq $q) {
                $val = $val.Substring(1, $val.Length - 2)
            }
        }
        [Environment]::SetEnvironmentVariable($name, $val, 'Process')
    }
}

$defaultEnvFile = Join-Path $PSScriptRoot "local-publish.env"
if ($env:EVOFLOW_LOCAL_PUBLISH_ENV -and $env:EVOFLOW_LOCAL_PUBLISH_ENV.Trim().Length -gt 0) {
    Import-LocalPublishDotEnv -LiteralPath $env:EVOFLOW_LOCAL_PUBLISH_ENV.Trim()
}
Import-LocalPublishDotEnv -LiteralPath $defaultEnvFile

# Capture once: in some hosts GetTempPath() can later return empty; TEMP/TMP stay usable for staging uploads.
$script:EvoFlowProcessTempRoot = [string][System.IO.Path]::GetTempPath()
if ([string]::IsNullOrWhiteSpace($script:EvoFlowProcessTempRoot)) {
    $script:EvoFlowProcessTempRoot = $env:TEMP
}
if ([string]::IsNullOrWhiteSpace($script:EvoFlowProcessTempRoot)) {
    $script:EvoFlowProcessTempRoot = $env:TMP
}
if ([string]::IsNullOrWhiteSpace($script:EvoFlowProcessTempRoot) -and $env:USERPROFILE) {
    $script:EvoFlowProcessTempRoot = [System.IO.Path]::Combine($env:USERPROFILE, "AppData", "Local", "Temp")
}

if ($All) {
    $BuildDesktopInstaller = $true
    $CreatePublicGhRelease = $true
}

if (-not ($BuildDesktopInstaller -or $CreatePublicGhRelease)) {
    $helpText = @"
No action selected. Pick one or more:

  -BuildDesktopInstaller  evopanel build:desktop:win + SHA256SUMS (skips npm ci if node_modules already OK; use -InstallNpmDeps to run npm ci)
  -CreatePublicGhRelease  Create a NEW GitHub Release on EvovexAI/EvoFlow for evopanel/package.json version only (fails if that tag/release already exists; bump version then rebuild)
  -All                     BuildDesktopInstaller, then CreatePublicGhRelease (new Release tag only)

  -InstallNpmDeps         With -BuildDesktopInstaller: run npm ci in evopanel first (clean install; slow on Windows)

Examples:
  .\scripts\maintainer\windows\local-publish.ps1 -BuildDesktopInstaller
  .\scripts\maintainer\windows\local-publish.ps1 -BuildDesktopInstaller -InstallNpmDeps
  .\scripts\maintainer\windows\local-publish.ps1 -BuildDesktopInstaller -CreatePublicGhRelease
  .\scripts\maintainer\windows\local-publish.ps1 -All
"@
    Write-Host $helpText -ForegroundColor Yellow
    exit 2
}

function Test-Cmd {
    param([string] $Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-GhExecutable {
    $cmd = Get-Command "gh" -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    foreach ($p in @(
            (Join-Path $env:ProgramFiles "GitHub CLI\gh.exe"),
            (Join-Path ${env:ProgramFiles(x86)} "GitHub CLI\gh.exe"),
            (Join-Path $env:LOCALAPPDATA "Programs\GitHub CLI\gh.exe")
        )) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

# Windows PowerShell 5.1 has no -Encoding utf8NoBOM on Set-Content.
function Write-Utf8NoBomFile {
    param(
        [Parameter(Mandatory)][string] $LiteralPath,
        [Parameter(Mandatory)][string] $Content
    )
    [System.IO.File]::WriteAllText($LiteralPath, $Content, [System.Text.UTF8Encoding]::new($false))
}

# Keep only NSIS artifacts for evopanel/package.json version; rewrite per-file .sha256 and SHA256SUMS.txt (avoids uploading old installers).
function Sync-NsisReleaseArtifactsForEvopanelVersion {
    $nsis = Join-Path $RepoRoot "evopanel/src-tauri/target/release/bundle/nsis"
    if (-not (Test-Path -LiteralPath $nsis)) { throw "NSIS output missing: $nsis" }
    $pkgV = ([string]((Get-Content (Join-Path $RepoRoot "evopanel/package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version)).Trim()
    if ($pkgV -notmatch '^\d+\.\d+\.\d+') { throw "Invalid package.json version: $pkgV" }
    $verMark = '_' + [regex]::Escape($pkgV) + '_'
    Get-ChildItem -LiteralPath $nsis -File -ErrorAction SilentlyContinue | Where-Object {
        ($_.Extension -in '.exe', '.msi') -and ($_.Name -notmatch $verMark)
    } | ForEach-Object {
        Write-Host "[local-publish] Removing other-version NSIS file: $($_.Name)" -ForegroundColor DarkGray
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
    Get-ChildItem -LiteralPath $nsis -Filter "*.sha256" -File -ErrorAction SilentlyContinue | Where-Object {
        (($_.Name -replace '\.sha256$', '') -notmatch $verMark)
    } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

    $files = @()
    $files += Get-ChildItem -LiteralPath $nsis -Filter "*.exe" -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $verMark }
    $files += Get-ChildItem -LiteralPath $nsis -Filter "*.msi" -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $verMark }
    if ($files.Count -eq 0) { throw "No .exe/.msi for version $pkgV under $nsis" }
    $lines = @()
    foreach ($f in $files) {
        $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $line = "$h  $($f.Name)"
        $lines += $line
        Write-Utf8NoBomFile -LiteralPath "$($f.FullName).sha256" -Content $line
    }
    $sums = Join-Path $nsis "SHA256SUMS.txt"
    Write-Utf8NoBomFile -LiteralPath $sums -Content ($lines -join "`n")
}

function Invoke-BuildDesktopInstaller {
    Write-Host "`n=== BuildDesktopInstaller (NSIS bundle, like release-windows-desktop.yml) ===" -ForegroundColor Cyan
    if (-not (Test-Cmd "npm")) { throw "npm not found" }
    if (-not (Test-Cmd "uv")) { throw "uv not found (backend PyInstaller needs it)" }
    $be = Join-Path $RepoRoot "backend"
    Push-Location $be
    try {
        & uv sync --group dev
        if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }
    } finally { Pop-Location }

    $ep = Join-Path $RepoRoot "evopanel"
    $tauriJs = Join-Path $ep "node_modules/@tauri-apps/cli/tauri.js"
    $wantNpmCi = $InstallNpmDeps -or ($env:EVOFLOW_INSTALL_NPM_DEPS -eq '1') -or ($env:EVOFLOW_INSTALL_NPM_DEPS -eq 'true')

    Push-Location $ep
    try {
        if ($wantNpmCi) {
            Write-Host "[local-publish] Running npm ci in evopanel (InstallNpmDeps / EVOFLOW_INSTALL_NPM_DEPS)..." -ForegroundColor Cyan
            $prevCi = $env:CI
            Remove-Item Env:\CI -ErrorAction SilentlyContinue
            try {
                & npm ci --progress=true --loglevel warn
                if ($LASTEXITCODE -ne 0) { throw "npm ci in evopanel failed" }
            } finally {
                if ($null -ne $prevCi -and $prevCi.Length -gt 0) { $env:CI = $prevCi }
            }
        }
        elseif (-not (Test-Path -LiteralPath $tauriJs)) {
            throw @"
evopanel/node_modules missing Tauri CLI:
  $tauriJs

Install once (e.g. cd evopanel && npm ci), or re-run with -InstallNpmDeps / set EVOFLOW_INSTALL_NPM_DEPS=1 in local-publish.env
"@
        }
        else {
            Write-Host "[local-publish] Skipping npm ci (found Tauri CLI). Use -InstallNpmDeps for a clean install." -ForegroundColor DarkGray
        }

        & npm run build:desktop:win
        if ($LASTEXITCODE -ne 0) { throw "npm run build:desktop:win failed" }
    } finally { Pop-Location }

    Sync-NsisReleaseArtifactsForEvopanelVersion
    $nsis = Join-Path $RepoRoot "evopanel/src-tauri/target/release/bundle/nsis"
    Write-Host "Artifacts:" -ForegroundColor Green
    Get-ChildItem -LiteralPath $nsis -File | ForEach-Object { Write-Host "  $($_.Name)" }
}

function Get-PublicEvoPanelReleaseMarkdown {
    if ($PublicReleaseBodyPath -and $PublicReleaseBodyPath.Trim().Length -gt 0) {
        $p = $PublicReleaseBodyPath.Trim()
        if (Test-Path -LiteralPath $p) {
            return [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false)).TrimEnd()
        }
        throw "PublicReleaseBodyPath not found: $p"
    }
    if ($env:EVOFLOW_PUBLIC_RELEASE_BODY -and $env:EVOFLOW_PUBLIC_RELEASE_BODY.Trim().Length -gt 0) {
        $p = $env:EVOFLOW_PUBLIC_RELEASE_BODY.Trim()
        if (Test-Path -LiteralPath $p) {
            return [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false)).TrimEnd()
        }
        throw "EVOFLOW_PUBLIC_RELEASE_BODY path not found: $p"
    }
    $path = Join-Path $PSScriptRoot "public-release-body.txt"
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Missing release notes file: $path"
    }
    return [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false)).TrimEnd()
}

function Invoke-PrunePublicGhReleasesAfterPublish {
    param([string[]]$ProtectTags = @())
    $pruneScript = Join-Path $PSScriptRoot "prune-public-github-releases.ps1"
    if (-not (Test-Path -LiteralPath $pruneScript)) {
        Write-Host "[CreatePublicGhRelease] Skip prune: missing $pruneScript" -ForegroundColor DarkYellow
        return
    }
    if (Get-Command powershell.exe -ErrorAction SilentlyContinue) {
        $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $pruneScript)
        if ($ProtectTags -and $ProtectTags.Count -gt 0) {
            $args += "-ProtectTags"
            $args += $ProtectTags
        }
        & powershell.exe @args
    } elseif ($ProtectTags -and $ProtectTags.Count -gt 0) {
        & $pruneScript -ProtectTags $ProtectTags
    } else {
        & $pruneScript
    }
    if ($LASTEXITCODE -ne 0) { throw "prune-public-github-releases.ps1 failed with exit code $LASTEXITCODE" }
}

function Invoke-CreatePublicGhReleaseViaToken {
    param(
        [Parameter(Mandatory)][string] $Token,
        [Parameter(Mandatory)][string] $Tag,
        [Parameter(Mandatory)][string[]] $FilePaths
    )
    if ($null -eq $FilePaths) { throw "FilePaths parameter is null" }
    $fps = @($FilePaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($fps.Count -eq 0) { throw "FilePaths is empty after filtering null/whitespace entries" }
    $owner = "EvovexAI"
    $repo = "EvoFlow"
    $api = "https://api.github.com/repos/$owner/$repo"
    $headers = @{
        Authorization          = "Bearer $Token"
        Accept                 = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent"           = "EvoFlow-local-publish"
    }
    $notes = Get-PublicEvoPanelReleaseMarkdown
    $rel = $null
    try {
        $rel = Invoke-RestMethod -Uri "${api}/releases/tags/${Tag}" -Headers $headers -Method Get -ErrorAction Stop
    }
    catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -ne 404) { throw }
    }
    if ($rel) {
        throw @"
[CreatePublicGhRelease] Release $Tag already exists on ${owner}/${repo}. Public uploads are only for a NEW version (new tag), not in-place replacement.

  Bump version in evopanel (e.g. cd evopanel; npm run version:set -- 0.1.1), rebuild the installer, then run -CreatePublicGhRelease again.
"@
    }
    $body = @{
        tag_name   = $Tag
        name       = ("EvoFlow " + $Tag)
        body       = $notes
        draft      = $false
        prerelease = $false
    } | ConvertTo-Json -Compress
    $ct = "application/json; charset=utf-8"
    $rel = Invoke-RestMethod -Uri "${api}/releases" -Headers $headers -Method Post -Body $body -ContentType $ct
    Write-Host "[CreatePublicGhRelease] Created release $Tag via API." -ForegroundColor Green
    $releaseId = [int]$rel.id
    $uploadBase = $rel.upload_url
    $brace = $uploadBase.IndexOf('{')
    if ($brace -gt 0) { $uploadBase = $uploadBase.Substring(0, $brace) }
    # Stage under TEMP so InFile upload is not blocked by Defender / locked build outputs.
    $tmpBase = $script:EvoFlowProcessTempRoot
    if ([string]::IsNullOrWhiteSpace($tmpBase)) {
        $tmpBase = [string][System.IO.Path]::GetTempPath()
    }
    if ([string]::IsNullOrWhiteSpace($tmpBase)) {
        $tmpBase = $env:TEMP
    }
    if ([string]::IsNullOrWhiteSpace($tmpBase)) {
        $tmpBase = $env:TMP
    }
    if ([string]::IsNullOrWhiteSpace($tmpBase)) {
        throw "No usable temp directory (script temp root, GetTempPath, TEMP, TMP all empty)."
    }
    $stagingRoot = [System.IO.Path]::Combine($tmpBase, "evoflow-gh-upload-" + [Guid]::NewGuid().ToString("N"))
    if ([string]::IsNullOrEmpty($stagingRoot)) {
        throw "Could not build staging directory path (GetTempPath='$tmpBase')"
    }
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
    try {
        foreach ($fp in $fps) {
            if ([string]::IsNullOrWhiteSpace($fp)) {
                throw "Empty path in FilePaths (staging upload)"
            }
            if (-not (Test-Path -LiteralPath $fp)) {
                throw "Release file missing: $fp"
            }
            $fn = [System.IO.Path]::GetFileName($fp)
            if ([string]::IsNullOrWhiteSpace($fn)) {
                throw "Could not get file name from path: $fp"
            }
            $staged = Join-Path $stagingRoot $fn
            if ([string]::IsNullOrWhiteSpace($staged)) {
                throw "Join-Path returned empty for staging (root=$stagingRoot name=$fn)"
            }
            Copy-Item -LiteralPath $fp -Destination $staged -Force
            $q = [System.Uri]::EscapeDataString($fn)
            $url = "${uploadBase}?name=$q"
            Write-Host "  uploading $fn ..." -ForegroundColor Cyan
            $null = Invoke-RestMethod -Uri $url -Headers $headers -Method Post -InFile $staged -ContentType "application/octet-stream" -TimeoutSec 7200
        }
    }
    finally {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Release $Tag assets uploaded to $owner/$repo (API)." -ForegroundColor Green
    Invoke-PrunePublicGhReleasesAfterPublish -ProtectTags @($Tag)
}

function Invoke-CreatePublicGhRelease {
    Write-Host "`n=== CreatePublicGhRelease (EvovexAI/EvoFlow) ===" -ForegroundColor Cyan
    $pkg = Get-Content (Join-Path $RepoRoot "evopanel/package.json") -Raw | ConvertFrom-Json
    $ver = "v$($pkg.version)"
    $pv = ([string]$pkg.version).Trim()
    if ($pv -notmatch '^\d+\.\d+\.\d+') { throw "Invalid package.json version: $pv" }
    $verMark = '_' + [regex]::Escape($pv) + '_'
    $nsis = Join-Path $RepoRoot "evopanel/src-tauri/target/release/bundle/nsis"
    if (-not (Test-Path -LiteralPath $nsis)) {
        throw "NSIS output missing: $nsis — run -BuildDesktopInstaller first"
    }
    Sync-NsisReleaseArtifactsForEvopanelVersion
    $upload = @()
    $upload += Get-ChildItem -LiteralPath $nsis -Filter "*.exe" -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $verMark }
    $upload += Get-ChildItem -LiteralPath $nsis -Filter "*.msi" -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $verMark }
    $upload += Get-ChildItem -LiteralPath $nsis -Filter "*.sha256" -File -ErrorAction SilentlyContinue | Where-Object { ($_.Name -replace '\.sha256$', '') -match $verMark }
    $upload += Get-ChildItem -LiteralPath $nsis -Filter "SHA256SUMS.txt" -File -ErrorAction SilentlyContinue
    if ($upload.Count -eq 0) { throw "No release files under $nsis — run -BuildDesktopInstaller first" }
    $paths = [System.Collections.Generic.List[string]]::new()
    foreach ($it in $upload) {
        if ($null -ne $it -and $it.FullName) { $paths.Add([string]$it.FullName) }
    }
    if ($paths.Count -eq 0) { throw "No valid file paths under $nsis (upload entries were empty)" }
    $notes = Get-PublicEvoPanelReleaseMarkdown
    $nf = Join-Path $env:TEMP "evoflow-release-notes.md"
    [System.IO.File]::WriteAllText($nf, $notes, [System.Text.UTF8Encoding]::new($false))

    $ghExe = Get-GhExecutable
    if ($ghExe) {
        Write-Host "[CreatePublicGhRelease] Using: $ghExe" -ForegroundColor DarkGray
        $argList = @("release", "create", $ver, "--repo", "EvovexAI/EvoFlow", "--notes-file", $nf) + @($paths.ToArray())
        & $ghExe @argList
        if ($LASTEXITCODE -ne 0) {
            throw @"
gh release create failed (exit $LASTEXITCODE). If the release already exists for $ver, bump evopanel/package.json version, rebuild, and publish a new tag only — same-tag uploads are not supported.
"@
        }
        Write-Host "Release $ver created on EvovexAI/EvoFlow (new tag only)." -ForegroundColor Green
        Invoke-PrunePublicGhReleasesAfterPublish -ProtectTags @($ver)
        return
    }

    $tok = $null
    if ($env:GITHUB_TOKEN -and $env:GITHUB_TOKEN.Trim().Length -gt 0) { $tok = $env:GITHUB_TOKEN.Trim() }
    elseif ($env:GH_TOKEN -and $env:GH_TOKEN.Trim().Length -gt 0) { $tok = $env:GH_TOKEN.Trim() }
    if ($tok) {
        Write-Host "[CreatePublicGhRelease] gh not found; using GITHUB_TOKEN / GH_TOKEN (repo contents + releases scope)." -ForegroundColor DarkYellow
        $filePathsForUpload = $paths.ToArray()
        if ($null -eq $filePathsForUpload) { throw "paths.ToArray() returned null (paths.Count=$($paths.Count))" }
        Invoke-CreatePublicGhReleaseViaToken -Token $tok -Tag $ver -FilePaths $filePathsForUpload
        return
    }

    throw @"
Neither GitHub CLI (gh) nor GITHUB_TOKEN/GH_TOKEN available.
  Install gh: https://cli.github.com/ (or add GitHub CLI to PATH), then: gh auth login
  Or set GITHUB_TOKEN in scripts/maintainer/windows/local-publish.env (classic PAT: repo scope; fine-grained: Contents + Releases read/write for EvovexAI/EvoFlow).
"@
}

# When building together with CreatePublicGhRelease, run the long build first, then publish.
if ($BuildDesktopInstaller -and $CreatePublicGhRelease) {
    Invoke-BuildDesktopInstaller
    Invoke-CreatePublicGhRelease
}
else {
    if ($BuildDesktopInstaller) { Invoke-BuildDesktopInstaller }
    if ($CreatePublicGhRelease) { Invoke-CreatePublicGhRelease }
}
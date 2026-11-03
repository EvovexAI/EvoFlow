#requires -Version 5.1
<#
.SYNOPSIS
  After GitHub Actions (or local) publishes a Windows installer, refresh
  scripts/maintainer/update/latest.json and push update/latest.json to both
  GitHub and Gitee.

  Default path (current product):
  - Installer lives on GitHub Releases (CI builds it)
  - Primary download URL = ghfast mirror of that GitHub asset
  - Clients check for updates via Gitee latest.json first

  Clients poll manifests in order:
    https://gitee.com/evovexai/EvoFlow/raw/main/update/latest.json
    https://cdn.jsdelivr.net/gh/EvovexAI/EvoFlow@main/update/latest.json
    https://raw.githubusercontent.com/EvovexAI/EvoFlow/main/update/latest.json

.PARAMETER SkipGitee
  Do not push to gitee.com/evovexai/EvoFlow.

.PARAMETER SkipGithub
  Do not push via GitHub Contents API.

.PARAMETER Tag
  Release tag, e.g. v1.2.3 or 1.2.3.

.PARAMETER NsisDir
  Optional local NSIS output dir. When set, hash/size/signature come from disk.
  When omitted, hash/size are taken from the GitHub Release asset + .sha256 file.

.PARAMETER Changelog
  Optional changelog line. Default: first non-empty line of PRODUCT-NOTES or draft.

.PARAMETER DryRun
  Write local draft only; do not push to the public repo.

.PARAMETER PrimaryUrl
  Override the primary installer download URL written into latest.json (e.g. CDN
  URL used by an independent Gitee Windows build).

.PARAMETER InstallerHost
  github (default): primary URL prefers ghfast mirror of GitHub Releases.
  gitee: independent Gitee build — primary URL is PrimaryUrl / CN CDN; do not
  pretend Gitee Releases hosts the ~380MB setup.exe.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\maintainer\windows\push-public-latest-json.ps1 -Tag v1.2.3
#>
param(
    [Parameter(Mandatory)]
    [string] $Tag,
    [string] $NsisDir = "",
    [string] $Changelog = "",
    [string] $PrimaryUrl = "",
    [ValidateSet('github', 'gitee')]
    [string] $InstallerHost = 'github',
    [switch] $DryRun,
    [switch] $SkipGitee,
    [switch] $SkipGithub
)

$ErrorActionPreference = "Stop"
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
Set-Location -LiteralPath $RepoRoot

function Import-LocalPublishDotEnv {
    param([string]$LiteralPath)
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

Import-LocalPublishDotEnv (Join-Path $PSScriptRoot "local-publish.env")
if ($env:EVOFLOW_LOCAL_PUBLISH_ENV) {
    Import-LocalPublishDotEnv $env:EVOFLOW_LOCAL_PUBLISH_ENV.Trim()
}

$owner = "EvovexAI"
$repo = "EvoFlow"
$tagName = $Tag.Trim()
if (-not $tagName.StartsWith('v')) { $tagName = "v$tagName" }
$semVer = $tagName.Substring(1)

function Get-AuthHeaders {
    $tok = $env:GITHUB_TOKEN
    if (-not $tok) { $tok = $env:GH_TOKEN }
    if (-not $tok) { $tok = $env:PUBLIC_REPO_TOKEN }
    if (-not $tok -or $tok.Trim().Length -eq 0) {
        # Prefer gh auth token when available (CI + local maintainer machines).
        if (Get-Command gh -ErrorAction SilentlyContinue) {
            $ghTok = (& gh auth token 2>$null)
            if ($ghTok -and $ghTok.Trim().Length -gt 0) { $tok = $ghTok.Trim() }
        }
    }
    if (-not $tok -or $tok.Trim().Length -eq 0) {
        throw "Need GITHUB_TOKEN / GH_TOKEN / PUBLIC_REPO_TOKEN or authenticated gh CLI"
    }
    return @{
        Authorization = "Bearer $($tok.Trim())"
        Accept        = "application/vnd.github+json"
        "User-Agent"  = "evoflow-push-public-latest-json"
    }
}

function Resolve-ChangelogLine {
    param([string]$Version, [string]$Override)
    if ($Override -and $Override.Trim().Length -gt 0) { return $Override.Trim() }

    $notes = Join-Path $RepoRoot "scripts\maintainer\windows\release-notes\PRODUCT-NOTES-$Version.md"
    if (Test-Path -LiteralPath $notes) {
        $line = (Get-Content -LiteralPath $notes -Encoding UTF8 |
            Where-Object { $_.Trim().Length -gt 0 -and -not $_.Trim().StartsWith('#') } |
            Select-Object -First 1)
        if ($line) { return $line.Trim() }
    }

    $draftPath = Join-Path $RepoRoot "scripts\maintainer\update\latest.json"
    if (Test-Path -LiteralPath $draftPath) {
        try {
            $draft = Get-Content -LiteralPath $draftPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($draft.changelog) { return [string]$draft.changelog }
        } catch { }
    }
    return "EvoFlow $Version"
}

$headers = $null
$api = "https://api.github.com/repos/$owner/$repo"
$releasedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$changelogLine = Resolve-ChangelogLine -Version $semVer -Override $Changelog

$hash = ""
$size = 0
$assetName = "EvoFlow_${semVer}_x64-setup.exe"
$platforms = $null

# GitHub token only when we need Release metadata or will push to GitHub.
$needGithubAuth = (-not $SkipGithub) -or (-not ($NsisDir -and $NsisDir.Trim().Length -gt 0))
if ($needGithubAuth) {
    $headers = Get-AuthHeaders
}

if ($NsisDir -and $NsisDir.Trim().Length -gt 0) {
    if (-not (Test-Path -LiteralPath $NsisDir)) { throw "NsisDir not found: $NsisDir" }
    $verMark = [regex]::Escape($semVer)
    $exe = Get-ChildItem -LiteralPath $NsisDir -Filter "*setup.exe" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $verMark } | Select-Object -First 1
    if (-not $exe) { throw "No *setup.exe for $semVer under $NsisDir" }
    $assetName = $exe.Name
    $hash = (Get-FileHash -LiteralPath $exe.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $size = [int64]$exe.Length

    $nsisZip = Get-ChildItem -LiteralPath $NsisDir -Filter "*.nsis.zip" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $verMark } | Select-Object -First 1
    if ($nsisZip) {
        $sigPath = "$($nsisZip.FullName).sig"
        if (Test-Path -LiteralPath $sigPath) {
            $sig = (Get-Content -LiteralPath $sigPath -Raw -Encoding UTF8).Trim()
            $zipUrl = "https://github.com/$owner/$repo/releases/download/$tagName/$($nsisZip.Name)"
            if ($InstallerHost -eq 'gitee' -and $PrimaryUrl -and $PrimaryUrl.Trim().Length -gt 0) {
                # Same CDN directory as setup.exe (replace filename).
                $zipUrl = (($PrimaryUrl.Trim() -replace '/[^/]+$', '') + '/' + $nsisZip.Name)
            }
            $platforms = @{
                "windows-x86_64" = @{
                    signature = $sig
                    url       = $zipUrl
                }
            }
            Write-Host "  updater bundle: $($nsisZip.Name) (+ signature)" -ForegroundColor DarkGray
        } else {
            Write-Warning "Found $($nsisZip.Name) but missing .sig — one-click in-app update will stay manual"
        }
    } else {
        Write-Warning "No *.nsis.zip under $NsisDir — clients fall back to setup.exe download"
    }
}
else {
    Write-Host "Resolving hash/size from GitHub Release $tagName ..." -ForegroundColor DarkGray
    $rel = Invoke-RestMethod -Uri "$api/releases/tags/$tagName" -Headers $headers -Method Get
    $setup = @($rel.assets | Where-Object { $_.name -match '_x64-setup\.exe$' }) | Select-Object -First 1
    if (-not $setup) { throw "Release $tagName has no *_x64-setup.exe asset" }
    $assetName = $setup.name
    $size = [int64]$setup.size

    $shaAsset = @($rel.assets | Where-Object { $_.name -eq "$assetName.sha256" }) | Select-Object -First 1
    if (-not $shaAsset) {
        $shaAsset = @($rel.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }) | Select-Object -First 1
    }
    if (-not $shaAsset) { throw "Release $tagName missing $assetName.sha256 / SHA256SUMS.txt" }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("evoflow-sha-" + [guid]::NewGuid().ToString("n") + ".txt")
    try {
        Invoke-WebRequest -Uri $shaAsset.browser_download_url -Headers $headers -OutFile $tmp -UseBasicParsing
        $shaLine = (Get-Content -LiteralPath $tmp -Encoding ascii | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -First 1)
        if ($shaLine -match '([a-fA-F0-9]{64})') {
            $hash = $Matches[1].ToLowerInvariant()
        } else {
            throw "Could not parse sha256 from $($shaAsset.name): $shaLine"
        }
    }
    finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }

    $zipAsset = @($rel.assets | Where-Object { $_.name -match '\.nsis\.zip$' }) | Select-Object -First 1
    $sigAsset = $null
    if ($zipAsset) {
        $sigAsset = @($rel.assets | Where-Object { $_.name -eq "$($zipAsset.name).sig" }) | Select-Object -First 1
    }
    if ($zipAsset -and $sigAsset) {
        $sigTmp = Join-Path ([IO.Path]::GetTempPath()) ("evoflow-sig-" + [guid]::NewGuid().ToString("n") + ".sig")
        try {
            Invoke-WebRequest -Uri $sigAsset.browser_download_url -Headers $headers -OutFile $sigTmp -UseBasicParsing
            $sig = (Get-Content -LiteralPath $sigTmp -Raw -Encoding UTF8).Trim()
            $platforms = @{
                "windows-x86_64" = @{
                    signature = $sig
                    url       = $zipAsset.browser_download_url
                }
            }
            Write-Host "  updater bundle from release: $($zipAsset.name)" -ForegroundColor DarkGray
        }
        finally {
            Remove-Item -LiteralPath $sigTmp -Force -ErrorAction SilentlyContinue
        }
    }
}

if (-not $hash) { throw "hash is empty" }
if ($size -le 0) { throw "size must be > 0 (got $size)" }

$giteeOwner = if ($env:GITEE_OWNER) { $env:GITEE_OWNER.Trim() } else { "evovexai" }
$giteeRepo = if ($env:GITEE_REPO) { $env:GITEE_REPO.Trim() } else { "EvoFlow" }
$urlGithub = "https://github.com/$owner/$repo/releases/download/$tagName/$assetName"
# Gitee Releases attach_files hard-caps ~100MB — cannot host ~380MB setup.exe.
$urlGiteeRelease = "https://gitee.com/$giteeOwner/$giteeRepo/releases/download/$tagName/$assetName"
$urlCnMirror = "https://ghfast.top/$urlGithub"
$urlGitee = $urlGiteeRelease
if ($InstallerHost -eq 'gitee') {
    # Independent Gitee build: binary lives on CDN (EVOFLOW_CN_INSTALLER_BASE_URL), not Gitee attach_files.
    if (-not $PrimaryUrl -or $PrimaryUrl.Trim().Length -eq 0) {
        throw "InstallerHost=gitee requires -PrimaryUrl (CDN HTTPS URL for setup.exe)"
    }
    $primaryUrl = $PrimaryUrl.Trim()
    $urlGitee = $primaryUrl
    $urlCnMirror = $primaryUrl
}
elseif ($PrimaryUrl -and $PrimaryUrl.Trim().Length -gt 0) {
    $primaryUrl = $PrimaryUrl.Trim()
}
else {
    # GitHub-built package: CN clients use ghfast mirror of GitHub Releases.
    $primaryUrl = $urlCnMirror
}

# Build UTF-8 JSON via Node (PS 5.1 ConvertTo-Json mangles CJK / em-dashes).
$draftPath = Join-Path $RepoRoot "scripts\maintainer\update\latest.json"
$draftDir = Split-Path -Parent $draftPath
if (-not (Test-Path -LiteralPath $draftDir)) {
    New-Item -ItemType Directory -Path $draftDir -Force | Out-Null
}

$metaPath = Join-Path ([IO.Path]::GetTempPath()) ("evoflow-latest-meta-" + [guid]::NewGuid().ToString("n") + ".json")
$changelogPath = Join-Path ([IO.Path]::GetTempPath()) ("evoflow-latest-cl-" + [guid]::NewGuid().ToString("n") + ".txt")
$platformsPath = ""
try {
    [System.IO.File]::WriteAllText($changelogPath, $changelogLine, [System.Text.UTF8Encoding]::new($false))
    $meta = @{
        version       = $semVer
        minAppVersion = $semVer
        updateKind    = "full"
        assetKind     = "installer"
        hash          = "sha256:$hash"
        url           = $primaryUrl
        urlCnMirror   = $urlCnMirror
        urlGitee      = $urlGitee
        urlGithub     = $urlGithub
        size          = [int64]$size
        releasedAt    = $releasedAt
        pub_date      = $releasedAt
        outPath       = $draftPath
        changelogPath = $changelogPath
    }
    if ($platforms) {
        $platformsPath = Join-Path ([IO.Path]::GetTempPath()) ("evoflow-latest-plat-" + [guid]::NewGuid().ToString("n") + ".json")
        # Also expose Gitee mirror URL for the signed updater zip when present.
        $platCopy = $platforms
        try {
            if ($platCopy.'windows-x86_64' -and $platCopy.'windows-x86_64'.url) {
                $zipName = [IO.Path]::GetFileName([string]$platCopy.'windows-x86_64'.url)
                if ($zipName) {
                    if ($InstallerHost -eq 'gitee') {
                        $platCopy.'windows-x86_64'.urlGitee = [string]$platCopy.'windows-x86_64'.url
                    } else {
                        $platCopy.'windows-x86_64'.urlGitee = "https://gitee.com/$giteeOwner/$giteeRepo/releases/download/$tagName/$zipName"
                    }
                }
            }
        } catch { }
        ($platCopy | ConvertTo-Json -Depth 8 -Compress) | Set-Content -LiteralPath $platformsPath -Encoding ascii
        $meta.platformsPath = $platformsPath
    }
    ($meta | ConvertTo-Json -Compress -Depth 5) | Set-Content -LiteralPath $metaPath -Encoding ascii

    $nodeWrite = @'
const fs = require("fs");
const metaPath = process.argv[2];
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
const changelog = fs.readFileSync(meta.changelogPath, "utf8");
const out = {
  version: meta.version,
  minAppVersion: meta.minAppVersion,
  updateKind: meta.updateKind,
  assetKind: meta.assetKind,
  hash: meta.hash,
  url: meta.url,
  urlCnMirror: meta.urlCnMirror,
  urlGitee: meta.urlGitee,
  urlGithub: meta.urlGithub,
  size: meta.size,
  changelog,
  notes: changelog,
  releasedAt: meta.releasedAt,
  pub_date: meta.pub_date,
};
if (meta.platformsPath) {
  out.platforms = JSON.parse(fs.readFileSync(meta.platformsPath, "utf8"));
}
fs.writeFileSync(meta.outPath, JSON.stringify(out, null, 2) + "\n", "utf8");
'@
    $nodeScriptPath = Join-Path ([IO.Path]::GetTempPath()) ("evoflow-latest-json-" + [guid]::NewGuid().ToString("n") + ".js")
    [System.IO.File]::WriteAllText($nodeScriptPath, $nodeWrite, [System.Text.UTF8Encoding]::new($false))
    & node $nodeScriptPath $metaPath
    if ($LASTEXITCODE -ne 0) { throw "node failed to write $draftPath" }
    Remove-Item -LiteralPath $nodeScriptPath -Force -ErrorAction SilentlyContinue
}
finally {
    Remove-Item -LiteralPath $metaPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $changelogPath -Force -ErrorAction SilentlyContinue
    if ($platformsPath) { Remove-Item -LiteralPath $platformsPath -Force -ErrorAction SilentlyContinue }
}

$json = [System.IO.File]::ReadAllText($draftPath, [System.Text.Encoding]::UTF8)
Write-Host "Wrote draft: $draftPath" -ForegroundColor Green

if ($DryRun) {
    Write-Host "DryRun: skip public push" -ForegroundColor Yellow
    Write-Host $json
    exit 0
}

function Push-GithubLatestJson {
    param([string]$JsonPath, [string]$TagName, [hashtable]$Headers, [string]$Owner, [string]$Repo)
    $contentPath = "update/latest.json"
    $contentApi = "https://api.github.com/repos/$Owner/$Repo/contents/$contentPath"
    $bytes = [System.IO.File]::ReadAllBytes($JsonPath)
    $b64 = [Convert]::ToBase64String($bytes)
    $bodyObj = @{
        message = "chore: update latest.json for $TagName"
        content = $b64
    }
    try {
        $existing = Invoke-RestMethod -Uri $contentApi -Headers $Headers -Method Get -ErrorAction Stop
        if ($existing.sha) { $bodyObj.sha = $existing.sha }
    }
    catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -ne 404) { throw }
    }
    $putPath = Join-Path ([IO.Path]::GetTempPath()) ("evoflow-latest-put-" + [guid]::NewGuid().ToString("n") + ".json")
    try {
        $putAscii = @{ message = $bodyObj.message; content = $bodyObj.content }
        if ($bodyObj.sha) { $putAscii.sha = $bodyObj.sha }
        ($putAscii | ConvertTo-Json -Compress) | Set-Content -LiteralPath $putPath -Encoding ascii
        $putBody = [System.IO.File]::ReadAllText($putPath, [System.Text.Encoding]::ASCII)
        $null = Invoke-RestMethod -Uri $contentApi -Headers $Headers -Method Put -Body $putBody -ContentType "application/json; charset=utf-8"
    }
    finally {
        Remove-Item -LiteralPath $putPath -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Pushed $contentPath to GitHub $Owner/$Repo" -ForegroundColor Green
    try {
        $purgeUrl = "https://purge.jsdelivr.net/gh/$Owner/$Repo@main/update/latest.json"
        $null = Invoke-WebRequest -Uri $purgeUrl -UseBasicParsing -TimeoutSec 15
        Write-Host "Requested jsDelivr purge for @main/update/latest.json" -ForegroundColor DarkGray
    } catch {
        Write-Warning "jsDelivr purge failed (cache may lag): $($_.Exception.Message)"
    }
}

function Push-GiteeLatestJson {
    param(
        [string]$JsonPath,
        [string]$TagName,
        [string]$GiteeOwner,
        [string]$GiteeRepo
    )
    # Prefer Contents API when token is set; else shallow-clone + commit + push (uses git credential).
    $tok = $env:GITEE_REPO_TOKEN
    if (-not $tok) { $tok = $env:GITEE_TOKEN }
    if (-not $tok) { $tok = $env:GITEE_PRIVATE_TOKEN }
    $contentPath = "update/latest.json"
    $commitMsg = "chore: update latest.json for $TagName"

    if ($tok -and $tok.Trim().Length -gt 0) {
        $api = "https://gitee.com/api/v5/repos/$GiteeOwner/$GiteeRepo/contents/$contentPath"
        $bytes = [System.IO.File]::ReadAllBytes($JsonPath)
        $b64 = [Convert]::ToBase64String($bytes)
        $sha = $null
        try {
            $existing = Invoke-RestMethod -Uri "$api`?access_token=$([uri]::EscapeDataString($tok.Trim()))&ref=main" -Method Get -ErrorAction Stop
            if ($existing.sha) { $sha = $existing.sha }
        } catch {
            $code = $null
            if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
            if ($code -ne 404) { throw }
        }
        $form = @{
            access_token = $tok.Trim()
            content      = $b64
            message      = $commitMsg
            branch       = "main"
        }
        if ($sha) { $form.sha = $sha }
        if ($sha) {
            $null = Invoke-RestMethod -Uri $api -Method Put -Body $form -ContentType "application/x-www-form-urlencoded"
        } else {
            $null = Invoke-RestMethod -Uri $api -Method Post -Body $form -ContentType "application/x-www-form-urlencoded"
        }
        Write-Host "Pushed $contentPath to Gitee $GiteeOwner/$GiteeRepo (API)" -ForegroundColor Green
        return
    }

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "GITEE_REPO_TOKEN not set and git not available — cannot push to Gitee"
    }
    $work = Join-Path ([IO.Path]::GetTempPath()) ("evoflow-gitee-latest-" + [guid]::NewGuid().ToString("n"))
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    try {
        $remote = "https://gitee.com/$GiteeOwner/$GiteeRepo.git"
        Write-Host "Cloning $remote (depth 1) to push update/latest.json ..." -ForegroundColor DarkGray
        & git clone --depth 1 --branch main $remote $work
        if ($LASTEXITCODE -ne 0) { throw "git clone gitee failed (exit $LASTEXITCODE)" }
        $destDir = Join-Path $work "update"
        if (-not (Test-Path -LiteralPath $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $JsonPath -Destination (Join-Path $destDir "latest.json") -Force
        Push-Location $work
        try {
            & git add --force -- update/latest.json
            & git -c user.name="EvoFlow Updater" -c user.email="updater@evovexai.com" commit -m $commitMsg
            if ($LASTEXITCODE -ne 0) {
                # nothing to commit is ok if identical
                $status = (& git status --porcelain)
                if (-not $status) {
                    Write-Host "Gitee update/latest.json already up to date" -ForegroundColor DarkGray
                    return
                }
                throw "git commit on gitee worktree failed"
            }
            & git push origin HEAD:main
            if ($LASTEXITCODE -ne 0) { throw "git push to gitee failed (exit $LASTEXITCODE)" }
        }
        finally {
            Pop-Location
        }
        Write-Host "Pushed $contentPath to Gitee $GiteeOwner/$GiteeRepo (git)" -ForegroundColor Green
    }
    finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not $SkipGithub) {
    try {
        Push-GithubLatestJson -JsonPath $draftPath -TagName $tagName -Headers $headers -Owner $owner -Repo $repo
    } catch {
        Write-Warning "GitHub push failed: $($_.Exception.Message)"
        if ($SkipGitee) { throw }
    }
} else {
    Write-Host "Skip GitHub push (-SkipGithub)" -ForegroundColor DarkGray
}

if (-not $SkipGitee) {
    try {
        Push-GiteeLatestJson -JsonPath $draftPath -TagName $tagName -GiteeOwner $giteeOwner -GiteeRepo $giteeRepo
    } catch {
        Write-Warning "Gitee push failed: $($_.Exception.Message)"
        if ($SkipGithub) { throw }
    }
} else {
    Write-Host "Skip Gitee push (-SkipGitee)" -ForegroundColor DarkGray
}

Write-Host "Manifest (CN): https://gitee.com/$giteeOwner/$giteeRepo/raw/main/update/latest.json" -ForegroundColor DarkGray
Write-Host "Manifest FO:   https://cdn.jsdelivr.net/gh/$owner/$repo@main/update/latest.json" -ForegroundColor DarkGray
Write-Host "Installer primary: $primaryUrl" -ForegroundColor DarkGray
Write-Host "Installer GH:      $urlGithub" -ForegroundColor DarkGray
if ($InstallerHost -eq 'gitee') {
    Write-Host "Note: Gitee-independent build — setup.exe on CDN ($primaryUrl); Gitee Releases only hold notes/checksums (100MB attach limit)." -ForegroundColor Yellow
} else {
    Write-Host "Note: Gitee Releases cannot host ~380MB setup.exe. GitHub-built packages use ghfast mirror; Gitee hosts latest.json." -ForegroundColor Yellow
}

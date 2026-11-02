#requires -Version 5.1
<#
.SYNOPSIS
  Build scripts/maintainer/update/latest.json from a Windows Release asset and
  push it to the public channel path update/latest.json on EvovexAI/EvoFlow.

  Clients poll (jsDelivr first, raw fallback):
    https://cdn.jsdelivr.net/gh/EvovexAI/EvoFlow@main/update/latest.json
    https://raw.githubusercontent.com/EvovexAI/EvoFlow/main/update/latest.json

  Draft stays under scripts/maintainer/update/ (source tree). The public path is
  written via GitHub Contents API so it does not need a normal source commit.

.PARAMETER Tag
  Release tag, e.g. v1.2.3 or 1.2.3.

.PARAMETER NsisDir
  Optional local NSIS output dir. When set, hash/size/signature come from disk.
  When omitted, hash/size are taken from the GitHub Release asset + .sha256 file.

.PARAMETER Changelog
  Optional changelog line. Default: first non-empty line of PRODUCT-NOTES or draft.

.PARAMETER DryRun
  Write local draft only; do not push to the public repo.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\maintainer\windows\push-public-latest-json.ps1 -Tag v1.2.3
#>
param(
    [Parameter(Mandatory)]
    [string] $Tag,
    [string] $NsisDir = "",
    [string] $Changelog = "",
    [switch] $DryRun
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

$headers = Get-AuthHeaders
$api = "https://api.github.com/repos/$owner/$repo"
$releasedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$changelogLine = Resolve-ChangelogLine -Version $semVer -Override $Changelog

$hash = ""
$size = 0
$assetName = "EvoFlow_${semVer}_x64-setup.exe"
$platforms = $null

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
            $platforms = @{
                "windows-x86_64" = @{
                    signature = $sig
                    url       = "https://github.com/$owner/$repo/releases/download/$tagName/$($nsisZip.Name)"
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
        url           = "https://github.com/$owner/$repo/releases/download/$tagName/$assetName"
        size          = [int64]$size
        releasedAt    = $releasedAt
        pub_date      = $releasedAt
        outPath       = $draftPath
        changelogPath = $changelogPath
    }
    if ($platforms) {
        $platformsPath = Join-Path ([IO.Path]::GetTempPath()) ("evoflow-latest-plat-" + [guid]::NewGuid().ToString("n") + ".json")
        ($platforms | ConvertTo-Json -Depth 8 -Compress) | Set-Content -LiteralPath $platformsPath -Encoding ascii
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

$contentPath = "update/latest.json"
$contentApi = "$api/contents/$contentPath"
$bytes = [System.IO.File]::ReadAllBytes($draftPath)
$b64 = [Convert]::ToBase64String($bytes)
$bodyObj = @{
    message = "chore: update latest.json for $tagName"
    content = $b64
}
try {
    $existing = Invoke-RestMethod -Uri $contentApi -Headers $headers -Method Get -ErrorAction Stop
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
    $null = Invoke-RestMethod -Uri $contentApi -Headers $headers -Method Put -Body $putBody -ContentType "application/json; charset=utf-8"
}
finally {
    Remove-Item -LiteralPath $putPath -Force -ErrorAction SilentlyContinue
}
Write-Host "Pushed $contentPath to $owner/$repo (clients poll this file)" -ForegroundColor Green
Write-Host "Primary: https://cdn.jsdelivr.net/gh/$owner/$repo@main/update/latest.json" -ForegroundColor DarkGray
Write-Host "Fallback: https://raw.githubusercontent.com/$owner/$repo/main/update/latest.json" -ForegroundColor DarkGray
try {
    $purgeUrl = "https://purge.jsdelivr.net/gh/$owner/$repo@main/update/latest.json"
    $null = Invoke-WebRequest -Uri $purgeUrl -UseBasicParsing -TimeoutSec 15
    Write-Host "Requested jsDelivr purge for @main/update/latest.json" -ForegroundColor DarkGray
} catch {
    Write-Warning "jsDelivr purge failed (cache may lag up to hours): $($_.Exception.Message)"
}

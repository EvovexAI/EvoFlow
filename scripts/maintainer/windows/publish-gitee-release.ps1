#requires -Version 5.1
<#
.SYNOPSIS
  Create/update a Gitee Release notes stub. Optional small attachments only.

  IMPORTANT: Gitee attach_files rejects files over ~100MB. The Windows setup.exe
  (~380MB) must NOT be uploaded here. Host the installer on CDN (Gitee-independent
  Windows CI) or GitHub Releases (GitHub Actions); clients poll Gitee for
  update/latest.json and download the large binary from the URL in that manifest.

.PARAMETER Tag
  Release tag, e.g. v1.2.3

.PARAMETER NsisDir
  Directory containing EvoFlow_*_x64-setup.exe (+ optional .sha256 / nsis.zip)

.PARAMETER Body
  Release notes markdown/text.

.PARAMETER Replace
  Delete existing same-name assets before upload.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\maintainer\windows\publish-gitee-release.ps1 `
    -Tag v1.2.3 -NsisDir evopanel\src-tauri\target\release\bundle\nsis -Replace
#>
param(
    [Parameter(Mandatory)][string] $Tag,
    [string] $NsisDir = "",
    [string] $DmgDir = "",
    [ValidateSet('windows', 'macos')][string] $Platform = 'windows',
    [string] $Body = "",
    [string] $ReleaseName = "",
    [switch] $Replace
)

$ErrorActionPreference = "Stop"
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path

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

function Get-GiteeToken {
    $tok = $env:GITEE_REPO_TOKEN
    if (-not $tok) { $tok = $env:GITEE_TOKEN }
    if (-not $tok) { $tok = $env:GITEE_PRIVATE_TOKEN }
    if (-not $tok) { $tok = $env:EVOFLOW_GITEE_TOKEN }
    if ($tok -and $tok.Trim().Length -gt 0) { return $tok.Trim() }
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $credOut = (("protocol=https", "host=gitee.com", "") -join "`n") | & git credential fill 2>$null
        $pass = ($credOut | Where-Object { $_ -match '^password=' }) -replace '^password=', ''
        if ($pass) { return $pass }
    }
    throw "Need GITEE_REPO_TOKEN / GITEE_TOKEN or git credential for gitee.com"
}

$owner = if ($env:GITEE_OWNER) { $env:GITEE_OWNER.Trim() } else { "evovexai" }
$repo = if ($env:GITEE_REPO) { $env:GITEE_REPO.Trim() } else { "EvoFlow" }
$token = Get-GiteeToken
$tagName = $Tag.Trim()
if (-not $tagName.StartsWith('v')) { $tagName = "v$tagName" }
$semVer = $tagName.Substring(1)
if (-not $ReleaseName) { $ReleaseName = "EvoFlow $semVer" }
if (-not $Body) { $Body = "EvoFlow $semVer" }

$apiBase = "https://gitee.com/api/v5/repos/$owner/$repo"
$rel = $null
try {
    $rel = Invoke-RestMethod -Uri "$apiBase/releases/tags/$tagName`?access_token=$([uri]::EscapeDataString($token))" -Method Get -TimeoutSec 30
} catch { $rel = $null }

if (-not $rel -or -not $rel.id) {
    Write-Host "Creating Gitee release $tagName ..." -ForegroundColor Cyan
    $rel = Invoke-RestMethod -Uri "$apiBase/releases" -Method Post -TimeoutSec 60 -Body @{
        access_token     = $token
        tag_name         = $tagName
        name             = $ReleaseName
        body             = $Body
        target_commitish = "main"
    }
}
Write-Host "Gitee release id=$($rel.id) tag=$tagName" -ForegroundColor Green

$files = @()
if ($Platform -eq 'windows') {
    if (-not $NsisDir) {
        $NsisDir = Join-Path $RepoRoot "evopanel\src-tauri\target\release\bundle\nsis"
    }
    if (-not (Test-Path -LiteralPath $NsisDir)) { throw "NsisDir not found: $NsisDir" }
    $verMark = [regex]::Escape($semVer)
    $exe = Get-ChildItem -LiteralPath $NsisDir -Filter "*setup.exe" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $verMark } | Select-Object -First 1
    if (-not $exe) { throw "No *setup.exe for $semVer under $NsisDir" }
    $files += $exe
    $sha = Get-Item -LiteralPath "$($exe.FullName).sha256" -ErrorAction SilentlyContinue
    if ($sha) { $files += $sha }
    $sums = Get-Item -LiteralPath (Join-Path $NsisDir "SHA256SUMS.txt") -ErrorAction SilentlyContinue
    if ($sums) { $files += $sums }
    $zip = Get-ChildItem -LiteralPath $NsisDir -Filter "*.nsis.zip" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $verMark } | Select-Object -First 1
    if ($zip) {
        $files += $zip
        $sig = Get-Item -LiteralPath "$($zip.FullName).sig" -ErrorAction SilentlyContinue
        if ($sig) { $files += $sig }
    }
}
else {
    if (-not $DmgDir) { throw "DmgDir required for macos" }
    $files = @(Get-ChildItem -LiteralPath $DmgDir -Filter "*.dmg" -File -Recurse -ErrorAction SilentlyContinue)
}

if ($files.Count -eq 0) { throw "No assets to upload" }

# Delete same-name assets when -Replace
if ($Replace -and $rel.assets) {
    foreach ($asset in @($rel.assets)) {
        $match = $files | Where-Object { $_.Name -eq $asset.name }
        if ($match) {
            Write-Host "  delete existing $($asset.name) (id=$($asset.id))" -ForegroundColor DarkGray
            try {
                Invoke-RestMethod -Uri "$apiBase/releases/release_id/$($rel.id)/attach_files/$($asset.id)?access_token=$([uri]::EscapeDataString($token))" -Method Delete -TimeoutSec 60 | Out-Null
            } catch {
                Write-Warning "Failed to delete $($asset.name): $($_.Exception.Message)"
            }
        }
    }
}

$attachUrl = "$apiBase/releases/$($rel.id)/attach_files?access_token=$([uri]::EscapeDataString($token))"
$maxMb = 95
foreach ($f in $files) {
    $mb = [math]::Round($f.Length / 1MB, 1)
    if ($mb -gt $maxMb) {
        Write-Warning "Skip $($f.Name) ($mb MB) — Gitee attach limit ~100MB. Host on GitHub Releases; CN clients use ghfast mirror."
        continue
    }
    Write-Host "  upload $($f.Name) ($mb MB) ..." -ForegroundColor Cyan
    # multipart/form-data via .NET for large files
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(60)
    try {
        $multipart = New-Object System.Net.Http.MultipartFormDataContent
        $fs = [System.IO.File]::OpenRead($f.FullName)
        try {
            $streamContent = New-Object System.Net.Http.StreamContent($fs)
            $streamContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse("application/octet-stream")
            $multipart.Add($streamContent, "file", $f.Name)
            $resp = $client.PostAsync($attachUrl, $multipart).GetAwaiter().GetResult()
            $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if (-not $resp.IsSuccessStatusCode) {
                throw "upload $($f.Name) failed: HTTP $([int]$resp.StatusCode) $text"
            }
            Write-Host "  ok $($f.Name)" -ForegroundColor Green
        }
        finally {
            $fs.Dispose()
            $multipart.Dispose()
        }
    }
    finally {
        $client.Dispose()
    }
}

Write-Host "Done: https://gitee.com/$owner/$repo/releases/tag/$tagName" -ForegroundColor Green

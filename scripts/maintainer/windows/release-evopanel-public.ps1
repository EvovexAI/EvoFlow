#requires -Version 5.1
<#
.SYNOPSIS
  EvoPanel 公共仓正式包全流程：升版本号 → 同步 Tauri/Cargo →（可选）打 Windows 安装包 → 用「产品向」Release 说明创建 GitHub Release（不覆盖已有同 tag Release）。

.PARAMETER Version
  目标版本号，如 0.2.0（与 -Bump 二选一）。

.PARAMETER Bump
  在当前 evopanel/package.json 基础上递增：patch | minor | major（与 -Version 二选一）。

.PARAMETER ProductNotes
  本版产品更新说明（多行 Markdown）。建议写清：修复 xxx、新增 xxx、优化 xxx 等。

.PARAMETER ProductNotesPath
  从 UTF-8 文件读取产品说明（与 -ProductNotes 二选一）。

.PARAMETER SkipBuild
  跳过 NSIS 构建（仅当 target/release/bundle/nsis 下已有当前版本产物时使用）。

.PARAMETER InstallNpmDeps
  构建前在 evopanel 执行 npm ci（与 local-publish 一致）。

.PARAMETER PushGitTag
  发布成功后向 origin 推送轻量 tag v<version>（需已配置 remote 与写权限）。
#>
param(
    [string] $Version = "",
    [ValidateSet("", "patch", "minor", "major")]
    [string] $Bump = "",
    [string] $ProductNotes = "",
    [string] $ProductNotesPath = "",
    [switch] $SkipBuild,
    [switch] $InstallNpmDeps,
    [switch] $PushGitTag
)

$ErrorActionPreference = "Stop"
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
Set-Location -LiteralPath $RepoRoot

function Import-LocalPublishDotEnv {
    param([Parameter(Mandatory)][string]$LiteralPath)
    if (-not (Test-Path -LiteralPath $LiteralPath)) { return }
    Write-Host "[release-evopanel-public] Loading env: $LiteralPath" -ForegroundColor DarkGray
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

function Test-Cmd {
    param([string] $Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-HasGhOrToken {
    $tok = $false
    if ($env:GITHUB_TOKEN -and $env:GITHUB_TOKEN.Trim().Length -gt 0) { $tok = $true }
    elseif ($env:GH_TOKEN -and $env:GH_TOKEN.Trim().Length -gt 0) { $tok = $true }
    $gh = $null -ne (Get-Command "gh" -ErrorAction SilentlyContinue)
    if (-not $gh -and -not $tok) {
        throw 'Need GitHub CLI (gh) logged in, or GITHUB_TOKEN / GH_TOKEN in scripts/maintainer/windows/local-publish.env (repo EvovexAI/EvoFlow: releases write).'
    }
}

function Get-NextSemVer {
    param([string]$Current, [string]$Kind)
    if ($Current -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
        throw ('package.json version must be x.y.z, got: ' + $Current)
    }
    $ma = [int]$Matches[1]; $mi = [int]$Matches[2]; $pa = [int]$Matches[3]
    switch ($Kind) {
        "patch" { $pa++ }
        "minor" { $mi++; $pa = 0 }
        "major" { $ma++; $mi = 0; $pa = 0 }
    }
    return "$ma.$mi.$pa"
}

function Format-ProductNotesMarkdown {
    param([string]$Raw)
    $lines = $Raw -split "`r?`n"
    $sb = New-Object System.Text.StringBuilder
    foreach ($line in $lines) {
        $t = $line.TrimEnd()
        $tr = $t.Trim()
        if ($tr.Length -eq 0) {
            [void]$sb.AppendLine()
            continue
        }
        if ($tr -match '^\s*[-*]\s' -or $tr -match '^\s*\d+\.\s' -or $tr -match '^\s*#+\s') {
            [void]$sb.AppendLine($t)
        }
        else {
            [void]$sb.AppendLine("- " + $tr)
        }
    }
    return $sb.ToString().Trim()
}

function Build-CombinedReleaseBody {
    param(
        [Parameter(Mandatory)][string] $SemVerNoV,
        [Parameter(Mandatory)][string] $ProductMarkdown
    )
    $footerPath = Join-Path $PSScriptRoot "public-release-body.txt"
    if (-not (Test-Path -LiteralPath $footerPath)) {
        throw "Missing $footerPath"
    }
    $footer = [System.IO.File]::ReadAllText($footerPath, [System.Text.UTF8Encoding]::new($false)).TrimEnd()
    $vtag = "v$SemVerNoV"
    $sep = "---"
    $cn = -join (@(0x672c, 0x7248, 0x66f4, 0x65b0) | ForEach-Object { [char]$_ })
    $header = "## What's new / $cn ($vtag)`n`n$ProductMarkdown`n`n$sep`n"
    return ($header + "`n" + $footer)
}

# --- args (CLI) ---
$hasV = $Version.Trim().Length -gt 0
$hasB = $Bump.Trim().Length -gt 0
if (($hasV -and $hasB) -or (-not $hasV -and -not $hasB)) {
    $helpLines = @(
        'Usage (run from repo root):',
        '',
        '  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintainer\windows\release-evopanel-public.ps1 -Bump patch -ProductNotes "fix: ...`nfeat: ..."',
        '  powershell ... -Version 0.2.0 -ProductNotesPath .\RELEASE-NOTES.md',
        '',
        '  Optional: -SkipBuild  -InstallNpmDeps  -PushGitTag'
    )
    Write-Host (($helpLines -join [Environment]::NewLine)) -ForegroundColor Yellow
    exit 2
}

$pn = $ProductNotes.Trim()
$pp = $ProductNotesPath.Trim()
if ($pn.Length -eq 0 -and $pp.Length -eq 0) {
    throw 'Provide -ProductNotes (markdown) or -ProductNotesPath (UTF-8 file) for the GitHub release product changelog.'
}
if ($pn.Length -gt 0 -and $pp.Length -gt 0) {
    throw 'Use only one of -ProductNotes and -ProductNotesPath.'
}

Test-HasGhOrToken

$pkgPath = Join-Path $RepoRoot "evopanel/package.json"
if (-not (Test-Path -LiteralPath $pkgPath)) { throw "Missing $pkgPath" }
$pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$current = [string]$pkg.version
if ($current -notmatch '^\d+\.\d+\.\d+') { throw "Invalid evopanel/package.json version: $current" }

if ($hasB) {
    $target = Get-NextSemVer -Current $current -Kind $Bump
    Write-Host ("[release-evopanel-public] Bump {0}: {1} -> {2}" -f $Bump, $current, $target) -ForegroundColor Cyan
}
else {
    $target = $Version.Trim()
    if ($target -notmatch '^\d+\.\d+\.\d+$') {
        throw '-Version must be semver x.y.z (e.g. 0.2.0)'
    }
}

$productMd = ""
if ($pp.Length -gt 0) {
    if (-not [System.IO.Path]::IsPathRooted($pp)) {
        $pp = Join-Path $RepoRoot $pp
    }
    if (-not (Test-Path -LiteralPath $pp)) { throw "ProductNotesPath not found: $pp" }
    $productMd = [System.IO.File]::ReadAllText($pp, [System.Text.UTF8Encoding]::new($false)).Trim()
}
else {
    $productMd = Format-ProductNotesMarkdown -Raw $ProductNotes
}

if ([string]::IsNullOrWhiteSpace($productMd)) {
    throw 'Product notes are empty.'
}

$combined = Build-CombinedReleaseBody -SemVerNoV $target -ProductMarkdown $productMd
$notesFile = Join-Path $env:TEMP ("evoflow-public-release-body-" + [Guid]::NewGuid().ToString("N") + ".md")
[System.IO.File]::WriteAllText($notesFile, $combined, [System.Text.UTF8Encoding]::new($false))

try {
    Write-Host "`n=== [1/3] version:set + sync (evopanel) ===" -ForegroundColor Cyan
    $evopanel = Join-Path $RepoRoot "evopanel"
    Push-Location $evopanel
    try {
        if (-not (Test-Cmd "npm")) { throw "npm not found in PATH" }
        & npm run version:set -- $target
        if ($LASTEXITCODE -ne 0) { throw "npm run version:set failed" }
    }
    finally { Pop-Location }

    Write-Host "`n=== [2/3] Build installer + Create public GitHub Release ===" -ForegroundColor Cyan
    $lp = Join-Path $PSScriptRoot "local-publish.ps1"
    $psArgs = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $lp
    )
    if ($SkipBuild) {
        $psArgs += "-CreatePublicGhRelease", "-PublicReleaseBodyPath", $notesFile
    }
    elseif ($InstallNpmDeps) {
        $psArgs += "-BuildDesktopInstaller", "-InstallNpmDeps", "-CreatePublicGhRelease", "-PublicReleaseBodyPath", $notesFile
    }
    else {
        $psArgs += "-BuildDesktopInstaller", "-CreatePublicGhRelease", "-PublicReleaseBodyPath", $notesFile
    }
    & powershell.exe @psArgs
    if ($LASTEXITCODE -ne 0) { throw "local-publish.ps1 failed with exit code $LASTEXITCODE" }

    if ($PushGitTag) {
        Write-Host "`n=== [3/3] git tag + push ===" -ForegroundColor Cyan
        if (-not (Test-Cmd "git")) { throw "git not found" }
        $tag = "v$target"
        $existingRaw = (& git -C $RepoRoot tag -l $tag 2>$null | Out-String)
        $existing = if ($null -eq $existingRaw) { "" } else { $existingRaw.Trim() }
        if ($existing.Length -eq 0) {
            & git -C $RepoRoot tag $tag
            if ($LASTEXITCODE -ne 0) { throw "git tag failed" }
            Write-Host "Created lightweight tag $tag" -ForegroundColor DarkGray
        }
        else {
            Write-Host "Tag $tag already exists locally; skip tag create." -ForegroundColor DarkYellow
        }
        & git -C $RepoRoot push origin $tag
        if ($LASTEXITCODE -ne 0) { throw "git push origin $tag failed" }
        Write-Host "Pushed $tag to origin." -ForegroundColor Green
    }
}
finally {
    if (Test-Path -LiteralPath $notesFile) {
        Remove-Item -LiteralPath $notesFile -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "`n[release-evopanel-public] Done. Public release v$target with product changelog + static footer." -ForegroundColor Green
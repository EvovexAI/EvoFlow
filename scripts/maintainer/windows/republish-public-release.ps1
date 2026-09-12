#requires -Version 5.1
<#
.SYNOPSIS
  更新 EvovexAI/EvoFlow 上**已有** GitHub Release：替换说明文案 + 重新上传 NSIS 安装包（不推私有仓）。

.PARAMETER Tag
  发布标签，如 v0.2.3 或 0.2.3。

.PARAMETER ProductNotesPath
  产品向更新说明 Markdown（UTF-8）。与 release-evopanel-public 相同，会自动拼接 public-release-body.txt。

.PARAMETER NsisDir
  NSIS 产物目录，默认 evopanel\src-tauri\target\release\bundle\nsis

.PARAMETER Platform
  windows（NSIS .exe）或 macos（.dmg）。默认 windows。

.PARAMETER UpdateLatestJson
  仅 Windows：根据当前安装包重算 SHA256/size，写入 update/latest.json。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\maintainer\windows\republish-public-release.ps1 `
    -Tag v0.2.3 -ProductNotesPath scripts\maintainer\windows\release-notes\PRODUCT-NOTES-0.2.3.md -UpdateLatestJson

  前置：scripts\maintainer\windows\local-publish.env 中配置 GITHUB_TOKEN（EvovexAI/EvoFlow：Contents + Releases 写权限）。
  可选：GITEE_REPO_TOKEN — 同步创建/上传到 gitee.com/evovexai/EvoFlow Releases（走 attach_files，非 LFS）。
#>
param(
    [string] $Tag = "v0.2.3",
    [Parameter(Mandatory)]
    [string] $ProductNotesPath,
    [ValidateSet('windows', 'macos')]
    [string] $Platform = 'windows',
    [string] $NsisDir = "",
    [string] $DmgDir = "",
    [switch] $UpdateLatestJson,
    [switch] $SkipGitee
)

$ErrorActionPreference = "Stop"
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
Set-Location -LiteralPath $RepoRoot

function Import-LocalPublishDotEnv {
    param([string]$LiteralPath)
    if (-not (Test-Path -LiteralPath $LiteralPath)) { return }
    Write-Host "[republish] Loading env: $LiteralPath" -ForegroundColor DarkGray
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

function Get-EvoPublishTempRoot {
    if ($env:TEMP -and $env:TEMP.Trim().Length -gt 0) { return $env:TEMP.Trim() }
    if ($env:TMPDIR -and $env:TMPDIR.Trim().Length -gt 0) { return $env:TMPDIR.Trim() }
    return '/tmp'
}

function Publish-PublicDmgReleaseAssets {
    param(
        [Parameter(Mandatory)][hashtable] $Headers,
        [Parameter(Mandatory)][string] $Owner,
        [Parameter(Mandatory)][string] $Repo,
        [Parameter(Mandatory)][string] $TagName,
        [Parameter(Mandatory)][string] $DmgDir,
        [Parameter(Mandatory)] $Release,
        [switch] $Replace
    )
    $ver = $TagName.Trim()
    if ($ver.StartsWith('v')) { $ver = $ver.Substring(1) }
    $verMark = [regex]::Escape($ver)
    if (-not (Test-Path -LiteralPath $DmgDir)) { throw "DmgDir not found: $DmgDir" }

    $installerFiles = @(Get-ChildItem -LiteralPath $DmgDir -Filter "*.dmg" -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $verMark })
    if ($installerFiles.Count -eq 0) {
        $installerFiles = @(Get-ChildItem -LiteralPath $DmgDir -Filter "*.dmg" -File -Recurse -ErrorAction SilentlyContinue)
    }
    if ($installerFiles.Count -eq 0) { throw "No .dmg under $DmgDir for version $ver" }
    $aarch = @($installerFiles | Where-Object { $_.Name -match '_aarch64\.dmg$' })
    $x64 = @($installerFiles | Where-Object { $_.Name -match '_x64\.dmg$' })
    if ($aarch.Count -eq 0 -or $x64.Count -eq 0) {
        Write-Warning "Expected both *_aarch64.dmg and *_x64.dmg; got aarch64=$($aarch.Count) x64=$($x64.Count) under $DmgDir"
    }

    $sumLines = @()
    foreach ($f in $installerFiles) {
        $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $line = "$h  $($f.Name)"
        $sumLines += $line
        [System.IO.File]::WriteAllText("$($f.FullName).sha256", $line, [System.Text.UTF8Encoding]::new($false))
    }
    [System.IO.File]::WriteAllText((Join-Path $DmgDir "SHA256SUMS.txt"), ($sumLines -join "`n"), [System.Text.UTF8Encoding]::new($false))

    $files = @($installerFiles)
    $files += Get-ChildItem -LiteralPath $DmgDir -Filter "*.sha256" -File -ErrorAction SilentlyContinue
    $files += Get-ChildItem -LiteralPath $DmgDir -Filter "SHA256SUMS.txt" -File -ErrorAction SilentlyContinue

    $namesToUpload = @($files | ForEach-Object { $_.Name })
    if ($Replace -and $Release.assets -and $Release.assets.Count -gt 0) {
        foreach ($asset in @($Release.assets)) {
            if ($namesToUpload -contains $asset.name) {
                Write-Host "Removing existing asset: $($asset.name) (id=$($asset.id)) ..."
                Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/assets/$($asset.id)" -Headers $Headers -Method Delete
            }
        }
    }
    $uploadBase = $Release.upload_url
    $brace = $uploadBase.IndexOf('{')
    if ($brace -gt 0) { $uploadBase = $uploadBase.Substring(0, $brace) }
    $staging = Join-Path (Get-EvoPublishTempRoot) ("evoflow-upload-dmg-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
        foreach ($f in $files) {
            # When -Replace is set, bulk delete (lines 117-124) already removed cached $Release.assets.
            # Only do per-file deletion from cached assets when -Replace is NOT set.
            if (-not $Replace -and $Release.assets -and $Release.assets.Count -gt 0) {
                $existing = @($Release.assets | Where-Object { $_.name -eq $f.Name })
                if ($existing.Count -gt 0) {
                    foreach ($ea in $existing) {
                        Write-Host "Removing existing asset: $($ea.name) (id=$($ea.id)) ..."
                        Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/assets/$($ea.id)" -Headers $Headers -Method Delete -ErrorAction SilentlyContinue
                    }
                }
            }
            # Also try to fetch-and-delete by name in case $Release.assets is stale
            try {
                $existingByName = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/$($Release.id)/assets?per_page=100" -Headers $Headers -Method Get -ErrorAction SilentlyContinue
                $match = @($existingByName | Where-Object { $_.name -eq $f.Name })
                if ($match.Count -gt 0) {
                    foreach ($ea in $match) {
                        Write-Host "Removing stale asset: $($ea.name) (id=$($ea.id)) ..."
                        Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/assets/$($ea.id)" -Headers $Headers -Method Delete -ErrorAction SilentlyContinue
                    }
                }
            } catch {
                # Non-fatal: proceed with upload attempt
            }
            $staged = Join-Path $staging $f.Name
            Copy-Item -LiteralPath $f.FullName -Destination $staged -Force
            $q = [System.Uri]::EscapeDataString($f.Name)
            $mb = [math]::Round($f.Length / 1MB, 1)
            Write-Host "Uploading $($f.Name) (${mb} MB) ..."
            try {
                $null = Invoke-RestMethod -Uri "${uploadBase}?name=$q" -Headers $Headers -Method Post -InFile $staged -ContentType "application/octet-stream" -TimeoutSec 7200
            } catch {
                # If still "already_exists", try to find and delete the asset by listing again, then retry once
                if ($_.Exception.Response -and $_.Exception.Response.StatusCode -eq 422) {
                    Write-Host "  Asset already exists; fetching fresh list to delete ..." -ForegroundColor Yellow
                    try {
                        $freshAssets = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/$($Release.id)/assets?per_page=100" -Headers $Headers -Method Get -ErrorAction SilentlyContinue
                        $conflict = @($freshAssets | Where-Object { $_.name -eq $f.Name })
                        if ($conflict.Count -gt 0) {
                            foreach ($ca in $conflict) {
                                Write-Host "  Removing conflicting asset: $($ca.name) (id=$($ca.id)) ..." -ForegroundColor Yellow
                                Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/assets/$($ca.id)" -Headers $Headers -Method Delete -ErrorAction SilentlyContinue
                            }
                            Start-Sleep -Seconds 2
                            Write-Host "  Retrying upload ..." -ForegroundColor Yellow
                            $null = Invoke-RestMethod -Uri "${uploadBase}?name=$q" -Headers $Headers -Method Post -InFile $staged -ContentType "application/octet-stream" -TimeoutSec 7200
                        } else {
                            throw
                        }
                    } catch {
                        throw
                    }
                } else {
                    throw
                }
            }
        }
    }
    finally {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Done: uploaded $($files.Count) file(s) to $Owner/$Repo release $TagName" -ForegroundColor Green
}

function Push-PublicLatestJsonManifest {
    param(
        [Parameter(Mandatory)][hashtable] $Headers,
        [Parameter(Mandatory)][string] $Owner,
        [Parameter(Mandatory)][string] $Repo,
        [Parameter(Mandatory)][string] $JsonPath,
        [Parameter(Mandatory)][string] $CommitMessage
    )
    if (-not (Test-Path -LiteralPath $JsonPath)) {
        throw "latest.json not found: $JsonPath"
    }
    $contentPath = 'update/latest.json'
    $api = "https://api.github.com/repos/$Owner/$Repo/contents/$contentPath"
    $bytes = [System.IO.File]::ReadAllBytes($JsonPath)
    $b64 = [Convert]::ToBase64String($bytes)
    $body = @{
        message = $CommitMessage
        content = $b64
    }
    try {
        $existing = Invoke-RestMethod -Uri $api -Headers $Headers -Method Get -ErrorAction Stop
        if ($existing.sha) { $body.sha = $existing.sha }
    }
    catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -ne 404) { throw }
    }
    $putBody = $body | ConvertTo-Json -Compress
    $null = Invoke-RestMethod -Uri $api -Headers $Headers -Method Put -Body $putBody -ContentType 'application/json; charset=utf-8'
    Write-Host "Pushed $contentPath to ${Owner}/${Repo} (desktop check-update reads this file)" -ForegroundColor Green
}

$tok = $env:GITHUB_TOKEN
if (-not $tok) { $tok = $env:GH_TOKEN }
if (-not $tok) { $tok = $env:PUBLIC_REPO_TOKEN }
if (-not $tok) {
    throw @"
需要 GitHub Token（EvovexAI/EvoFlow，Releases 写权限）。
  复制 scripts\maintainer\windows\local-publish.env.example -> local-publish.env
  填入 GITHUB_TOKEN=ghp_...
"@
}

$tagName = $Tag.Trim()
if (-not $tagName.StartsWith('v')) { $tagName = "v$tagName" }
$semVer = $tagName.Substring(1)

$notesPath = $ProductNotesPath
if (-not [System.IO.Path]::IsPathRooted($notesPath)) {
    $notesPath = Join-Path $RepoRoot $notesPath
}
if (-not (Test-Path -LiteralPath $notesPath)) {
    throw "ProductNotesPath not found: $notesPath"
}

if ([string]::IsNullOrWhiteSpace($NsisDir)) {
    $NsisDir = Join-Path $RepoRoot "evopanel/src-tauri/target/release/bundle/nsis"
}
if ([string]::IsNullOrWhiteSpace($DmgDir)) {
    $DmgDir = Join-Path $RepoRoot "evopanel/src-tauri/target/release/bundle/dmg"
}
if ($Platform -eq 'windows') {
    if (-not (Test-Path -LiteralPath $NsisDir)) { throw "NsisDir not found: $NsisDir" }
}
else {
    if (-not (Test-Path -LiteralPath $DmgDir)) { throw "DmgDir not found: $DmgDir" }
}
$releaseName = "EvoFlow $tagName"

$footerPath = Join-Path $PSScriptRoot "public-release-body.txt"
if (-not (Test-Path -LiteralPath $footerPath)) { throw "Missing $footerPath" }

$productMd = [System.IO.File]::ReadAllText($notesPath, [System.Text.UTF8Encoding]::new($false)).Trim()
$footer = [System.IO.File]::ReadAllText($footerPath, [System.Text.UTF8Encoding]::new($false)).TrimEnd()
$combined = @"
## What's new / 本版更新 ($tagName)

$productMd

---

$footer
"@.TrimEnd()

$owner = "EvovexAI"
$repo = "EvoFlow"
$api = "https://api.github.com/repos/$owner/$repo"
$headers = @{
    Authorization          = "Bearer $tok"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "EvoFlow-republish-public-release"
}

Write-Host "`n=== [1/3] Create or PATCH release body ($tagName) ===" -ForegroundColor Cyan
$rel = $null
try {
    $rel = Invoke-RestMethod -Uri "${api}/releases/tags/${tagName}" -Headers $headers -Method Get -ErrorAction Stop
}
catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -ne 404) { throw }
}
if ($rel) {
    $patchBody = @{ body = $combined; name = $releaseName } | ConvertTo-Json -Compress
    $null = Invoke-RestMethod -Uri "${api}/releases/$($rel.id)" -Headers $headers -Method Patch -Body $patchBody -ContentType "application/json; charset=utf-8"
    Write-Host "Updated release notes on ${owner}/${repo} $tagName" -ForegroundColor Green
}
else {
    Write-Host "Release $tagName not found; creating new public release ..." -ForegroundColor Yellow
    $createBody = @{
        tag_name   = $tagName
        name       = $releaseName
        body       = $combined
        draft      = $false
        prerelease = $false
    } | ConvertTo-Json -Compress
    $rel = Invoke-RestMethod -Uri "${api}/releases" -Headers $headers -Method Post -Body $createBody -ContentType "application/json; charset=utf-8"
    Write-Host "Created release ${owner}/${repo} $tagName (id=$($rel.id))" -ForegroundColor Green
}

Write-Host "`n=== [2/3] Upload release assets (-Replace) ===" -ForegroundColor Cyan
if ($Platform -eq 'macos') {
    Publish-PublicDmgReleaseAssets -Headers $headers -Owner $owner -Repo $repo -TagName $tagName -DmgDir $DmgDir -Release $rel -Replace
}
else {
    $uploadScript = Join-Path $PSScriptRoot "upload-release-assets-only.ps1"
    & $uploadScript -Tag $tagName -NsisDir $NsisDir -Replace
}

if ($UpdateLatestJson -and $Platform -eq 'windows') {
    Write-Host "`n=== [3/3] Update latest.json (local + public mirror) ===" -ForegroundColor Cyan
    $verMark = [regex]::Escape($semVer)
    $exe = Get-ChildItem -LiteralPath $NsisDir -Filter "*.exe" -File | Where-Object { $_.Name -match $verMark } | Select-Object -First 1
    if (-not $exe) { throw "No installer .exe for $semVer under $NsisDir" }
    $hash = (Get-FileHash -LiteralPath $exe.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $assetName = $exe.Name
    $changelogLine = ($productMd -split "`n" | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -First 1)
    if (-not $changelogLine) { $changelogLine = "v${semVer}" }
    $releasedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $payload = @{
        version       = $semVer
        minAppVersion = $semVer
        updateKind    = "full"
        assetKind     = "installer"
        hash          = "sha256:$hash"
        url           = "https://github.com/$owner/$repo/releases/download/$tagName/$assetName"
        size          = [int]$exe.Length
        changelog     = $changelogLine.Trim()
        notes         = $changelogLine.Trim()
        releasedAt    = $releasedAt
        pub_date      = $releasedAt
    }
    $nsisZip = Get-ChildItem -LiteralPath $NsisDir -Filter "*.nsis.zip" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $verMark } | Select-Object -First 1
    if ($nsisZip) {
        $sigPath = "$($nsisZip.FullName).sig"
        if (-not (Test-Path -LiteralPath $sigPath)) {
            Write-Warning "Missing updater signature: $sigPath (build with TAURI_SIGNING_PRIVATE_KEY)"
        } else {
            $sig = (Get-Content -LiteralPath $sigPath -Raw -Encoding UTF8).Trim()
            $zipName = $nsisZip.Name
            $payload.platforms = @{
                "windows-x86_64" = @{
                    signature = $sig
                    url       = "https://github.com/$owner/$repo/releases/download/$tagName/$zipName"
                }
            }
            Write-Host "  updater bundle: $zipName (+ signature)" -ForegroundColor DarkGray
        }
    } else {
        Write-Warning "No *.nsis.zip under $NsisDir - one-click in-app update will not work until signed build is uploaded"
    }
    $json = ($payload | ConvertTo-Json -Depth 5)
    $draftPath = Join-Path $RepoRoot "scripts/maintainer/update/latest.json"
    $dir = Split-Path -Parent $draftPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    [System.IO.File]::WriteAllText($draftPath, $json + "`n", [System.Text.UTF8Encoding]::new($false))
    Write-Host "  wrote $draftPath" -ForegroundColor DarkGray
    # Clients poll public update/latest.json only — never reintroduce root update/ in the OSS tree.
    Push-PublicLatestJsonManifest -Headers $headers -Owner $owner -Repo $repo -JsonPath $draftPath -CommitMessage "chore: update latest.json for $tagName"
}
elseif ($UpdateLatestJson -and $Platform -eq 'macos') {
    Write-Host "`n=== [3/3] Skip latest.json on macOS (Windows-only manifest) ===" -ForegroundColor DarkGray
}
else {
    Write-Host "`n=== [3/3] Skip latest.json (use -UpdateLatestJson on Windows to refresh) ===" -ForegroundColor DarkGray
}

# [4] Optional Gitee Releases mirror (attach_files API — not git LFS)
$giteeTok = $env:GITEE_REPO_TOKEN
if ($SkipGitee) {
    Write-Host "`n=== [4/4] Skip Gitee (-SkipGitee) ===" -ForegroundColor DarkGray
}
elseif (-not $giteeTok -or $giteeTok.Trim().Length -eq 0) {
    Write-Host "`n=== [4/4] Skip Gitee (GITEE_REPO_TOKEN not set) ===" -ForegroundColor Yellow
}
else {
    Write-Host "`n=== [4/4] Mirror release assets to Gitee ===" -ForegroundColor Cyan
    $giteeScript = Join-Path $PSScriptRoot "publish-gitee-release.ps1"
    if (-not (Test-Path -LiteralPath $giteeScript)) {
        Write-Warning "Gitee mirror skipped: $giteeScript not in this repository."
    }
    else {
    try {
        & $giteeScript `
            -Tag $tagName `
            -Body $combined `
            -Platform $Platform `
            -NsisDir $NsisDir `
            -DmgDir $DmgDir `
            -ReleaseName $releaseName `
            -Replace
        if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
            Write-Warning "Gitee mirror exited with code $LASTEXITCODE (GitHub release already published)."
        }
    }
    catch {
        Write-Warning "Gitee mirror failed (GitHub release already published): $($_.Exception.Message)"
    }
    }
}

Write-Host "`n[republish] Done: https://github.com/$owner/$repo/releases/tag/$tagName" -ForegroundColor Green
if ($giteeTok -and $giteeTok.Trim().Length -gt 0 -and -not $SkipGitee) {
    $giteeOwner = if ($env:GITEE_OWNER) { $env:GITEE_OWNER.Trim() } else { "evovexai" }
    $giteeRepo = if ($env:GITEE_REPO) { $env:GITEE_REPO.Trim() } else { "EvoFlow" }
    Write-Host "[republish] Gitee: https://gitee.com/$giteeOwner/$giteeRepo/releases/tag/$tagName" -ForegroundColor Green
}

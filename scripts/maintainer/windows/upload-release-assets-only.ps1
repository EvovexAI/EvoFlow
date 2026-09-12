#requires -Version 5.1
<#
.SYNOPSIS
  Upload NSIS installer + checksums to an existing GitHub Release on EvovexAI/EvoFlow.

.PARAMETER Replace
  Delete same-named release assets before upload (use when replacing a rebuilt installer on the same tag).
#>
param(
    [Parameter(Mandatory)][string] $Tag,
    [string] $NsisDir = "",
    [switch] $Replace
)
$ErrorActionPreference = "Stop"
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
if ([string]::IsNullOrWhiteSpace($NsisDir)) {
    $NsisDir = Join-Path $RepoRoot "evopanel\src-tauri\target\release\bundle\nsis"
}
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
$tok = $env:GITHUB_TOKEN
if (-not $tok) { $tok = $env:GH_TOKEN }
if (-not $tok) { $tok = $env:PUBLIC_REPO_TOKEN }
if (-not $tok) { throw "Need GITHUB_TOKEN, GH_TOKEN, or PUBLIC_REPO_TOKEN in local-publish.env" }
$ver = $Tag.Trim()
if ($ver.StartsWith('v')) { $ver = $ver.Substring(1) }
$verMark = [regex]::Escape($ver)
$installerFiles = @(
    Get-ChildItem -LiteralPath $NsisDir -Filter "*.exe" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $verMark }
)
$installerFiles += @(
    Get-ChildItem -LiteralPath $NsisDir -Filter "*.msi" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $verMark }
)
$updaterFiles = @(
    Get-ChildItem -LiteralPath $NsisDir -Filter "*.nsis.zip" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $verMark }
)
$updaterFiles += @(
    Get-ChildItem -LiteralPath $NsisDir -Filter "*.nsis.zip.sig" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $verMark }
)
if ($installerFiles.Count -eq 0) { throw "No installer .exe/.msi under $NsisDir for version $ver" }

# Refresh checksum sidecars for the current installer on disk.
$sumLines = @()
foreach ($f in $installerFiles) {
    $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $line = "$h  $($f.Name)"
    $sumLines += $line
    [System.IO.File]::WriteAllText("$($f.FullName).sha256", $line, [System.Text.UTF8Encoding]::new($false))
}
[System.IO.File]::WriteAllText((Join-Path $NsisDir "SHA256SUMS.txt"), ($sumLines -join "`n"), [System.Text.UTF8Encoding]::new($false))

$files = @($installerFiles)
$files += $updaterFiles
$files += Get-ChildItem -LiteralPath $NsisDir -Filter "*.sha256" -File -ErrorAction SilentlyContinue |
    Where-Object { ($_.Name -replace '\.sha256$', '') -match $verMark }
$files += Get-ChildItem -LiteralPath $NsisDir -Filter "SHA256SUMS.txt" -File -ErrorAction SilentlyContinue
if ($files.Count -eq 0) { throw "No artifacts under $NsisDir for version $ver" }

$owner = "EvovexAI"
$repo = "EvoFlow"
$tagName = if ($Tag.StartsWith('v')) { $Tag } else { "v$Tag" }
$headers = @{
    Authorization          = "Bearer $tok"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "EvoFlow-upload-assets-only"
}
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/tags/$tagName" -Headers $headers
$namesToUpload = @($files | ForEach-Object { $_.Name })
if ($Replace -and $rel.assets -and $rel.assets.Count -gt 0) {
    foreach ($asset in @($rel.assets)) {
        if ($namesToUpload -contains $asset.name) {
            Write-Host "Removing existing asset: $($asset.name) (id=$($asset.id)) ..."
            Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/assets/$($asset.id)" -Headers $headers -Method Delete
        }
    }
}
$uploadBase = $rel.upload_url
$brace = $uploadBase.IndexOf('{')
if ($brace -gt 0) { $uploadBase = $uploadBase.Substring(0, $brace) }
$staging = Join-Path $env:TEMP ("evoflow-upload-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $staging -Force | Out-Null
try {
    foreach ($f in $files) {
        $staged = Join-Path $staging $f.Name
        Copy-Item -LiteralPath $f.FullName -Destination $staged -Force
        $q = [System.Uri]::EscapeDataString($f.Name)
        $mb = [math]::Round($f.Length / 1MB, 1)
        Write-Host "Uploading $($f.Name) (${mb} MB) ..."
        try {
            $null = Invoke-RestMethod -Uri "${uploadBase}?name=$q" -Headers $headers -Method Post -InFile $staged -ContentType "application/octet-stream" -TimeoutSec 7200
        }
        catch {
            # If asset already exists (GitHub eventual consistency), delete and retry.
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 422) {
                Write-Host "  asset '$($f.Name)' already exists, fetching fresh asset list ..." -ForegroundColor Yellow
                try {
                    $freshAssets = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/$($rel.id)/assets?per_page=100" -Headers $headers -Method Get -ErrorAction SilentlyContinue
                    $conflict = @($freshAssets | Where-Object { $_.name -eq $f.Name })
                    if ($conflict.Count -gt 0) {
                        foreach ($ca in $conflict) {
                            Write-Host "  Removing conflicting asset: $($ca.name) (id=$($ca.id)) ..." -ForegroundColor Yellow
                            Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/assets/$($ca.id)" -Headers $headers -Method Delete -ErrorAction SilentlyContinue
                        }
                        Start-Sleep -Seconds 3
                    }
                } catch {
                    Write-Host "  Failed to fetch fresh asset list, retrying anyway ..." -ForegroundColor Yellow
                }
                $null = Invoke-RestMethod -Uri "${uploadBase}?name=$q" -Headers $headers -Method Post -InFile $staged -ContentType "application/octet-stream" -TimeoutSec 7200
            } else {
                throw
            }
        }
    }
}
finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "Done: uploaded $($files.Count) file(s) to $owner/$repo release $tagName" -ForegroundColor Green

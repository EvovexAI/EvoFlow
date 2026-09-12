#requires -Version 5.1
<#
.SYNOPSIS
  Keep only the newest N semver GitHub Releases on EvovexAI/EvoFlow; delete older releases and their tags.

.PARAMETER KeepCount
  Number of releases to retain (default: env EVOFLOW_PUBLIC_RELEASE_KEEP_COUNT or 2).

.PARAMETER ProtectTags
  Tag names to never delete (e.g. v0.1.10 just published).
#>
param(
    [int] $KeepCount = -1,
    [string[]] $ProtectTags = @()
)

$ErrorActionPreference = "Stop"
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Import-LocalPublishDotEnv {
    param([Parameter(Mandatory)][string]$LiteralPath)
    if (-not (Test-Path -LiteralPath $LiteralPath)) { return }
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
            if (($q -eq '"' -or $q -eq [char]39) -and $val[$val.Length - 1] -eq $q) {
                $val = $val.Substring(1, $val.Length - 2)
            }
        }
        [Environment]::SetEnvironmentVariable($name, $val, 'Process')
    }
}

function Get-PublicGhToken {
    if ($env:GITHUB_TOKEN -and $env:GITHUB_TOKEN.Trim().Length -gt 0) { return $env:GITHUB_TOKEN.Trim() }
    if ($env:GH_TOKEN -and $env:GH_TOKEN.Trim().Length -gt 0) { return $env:GH_TOKEN.Trim() }
    if ($env:PUBLIC_REPO_TOKEN -and $env:PUBLIC_REPO_TOKEN.Trim().Length -gt 0) { return $env:PUBLIC_REPO_TOKEN.Trim() }
    return $null
}

function Parse-SemVerTag {
    param([string]$Tag)
    $t = [string]$Tag
    if ($t.StartsWith('v')) { $t = $t.Substring(1) }
    if ($t -match '^(\d+)\.(\d+)\.(\d+)$') {
        return [PSCustomObject]@{
            Tag   = $Tag
            Major = [int]$Matches[1]
            Minor = [int]$Matches[2]
            Patch = [int]$Matches[3]
        }
    }
    return $null
}

function Invoke-PrunePublicGhReleasesCore {
    param(
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][int]$Keep,
        [string[]]$Protect = @()
    )
    if ($Keep -lt 1) { throw "KeepCount must be >= 1" }

    $owner = "EvovexAI"
    $repo = "EvoFlow"
    $api = "https://api.github.com/repos/$owner/$repo"
    $headers = @{
        Authorization          = "Bearer $Token"
        Accept                 = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent"           = "EvoFlow-prune-public-releases"
    }

    $protectSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($p in $Protect) {
        $pt = [string]$p
        if ($pt.Length -eq 0) { continue }
        if (-not $pt.StartsWith('v')) { $pt = "v$pt" }
        [void]$protectSet.Add($pt)
    }

    $all = [System.Collections.Generic.List[object]]::new()
    $page = 1
    while ($true) {
        $batch = @(Invoke-RestMethod -Uri "${api}/releases?per_page=100&page=$page" -Headers $headers -Method Get)
        if ($batch.Count -eq 0) { break }
        foreach ($item in $batch) {
            if ($null -ne $item) { [void]$all.Add($item) }
        }
        if ($batch.Count -lt 100) { break }
        $page++
        if ($page -gt 20) { break }
    }

    $semverReleases = @()
    foreach ($rel in @($all)) {
        if ($rel.draft -eq $true) { continue }
        $tag = [string]$rel.tag_name
        if ([string]::IsNullOrWhiteSpace($tag)) { continue }
        $parsed = Parse-SemVerTag -Tag $tag
        if (-not $parsed) { continue }
        $semverReleases += [PSCustomObject]@{
            Id      = [int]$rel.id
            Tag     = $tag
            Major   = $parsed.Major
            Minor   = $parsed.Minor
            Patch   = $parsed.Patch
        }
    }

    if ($semverReleases.Count -le $Keep) {
        Write-Host "[prune-public-releases] $($semverReleases.Count) semver release(s); keep $Keep — nothing to delete." -ForegroundColor DarkGray
        return
    }

    $sorted = $semverReleases | Sort-Object Major, Minor, Patch -Descending
    $keepTags = @($sorted | Select-Object -First $Keep | ForEach-Object { $_.Tag })
    foreach ($t in $keepTags) { [void]$protectSet.Add($t) }

    $toDelete = @($sorted | Where-Object { -not $protectSet.Contains($_.Tag) })
    if ($toDelete.Count -eq 0) {
        Write-Host "[prune-public-releases] No releases to delete after protect rules." -ForegroundColor DarkGray
        return
    }

    Write-Host "[prune-public-releases] Keeping: $($keepTags -join ', '); deleting $($toDelete.Count) older release(s) on ${owner}/${repo} ..." -ForegroundColor Cyan
    foreach ($rel in $toDelete) {
        $tag = $rel.Tag
        Write-Host "  delete release $tag (id=$($rel.Id)) ..." -ForegroundColor Yellow
        try {
            Invoke-RestMethod -Uri "${api}/releases/$($rel.Id)" -Headers $headers -Method Delete | Out-Null
        }
        catch {
            Write-Host "    release delete failed: $_" -ForegroundColor Red
            continue
        }
        try {
            Invoke-RestMethod -Uri "${api}/git/refs/tags/$([Uri]::EscapeDataString($tag))" -Headers $headers -Method Delete | Out-Null
            Write-Host "    deleted tag $tag" -ForegroundColor DarkGray
        }
        catch {
            $code = $null
            if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
            if ($code -ne 404) {
                Write-Host "    tag delete warning ($tag): $_" -ForegroundColor DarkYellow
            }
        }
    }
    Write-Host "[prune-public-releases] Done. Public repo now retains at most $Keep semver release(s)." -ForegroundColor Green
}

# --- main ---
if ($env:EVOFLOW_LOCAL_PUBLISH_ENV -and $env:EVOFLOW_LOCAL_PUBLISH_ENV.Trim().Length -gt 0) {
    Import-LocalPublishDotEnv -LiteralPath $env:EVOFLOW_LOCAL_PUBLISH_ENV.Trim()
}
Import-LocalPublishDotEnv -LiteralPath (Join-Path $PSScriptRoot "local-publish.env")

$keep = $KeepCount
if ($keep -lt 0) {
    $rawKeep = $env:EVOFLOW_PUBLIC_RELEASE_KEEP_COUNT
    $parsedKeep = 0
    if ($rawKeep -and [int]::TryParse($rawKeep.Trim(), [ref]$parsedKeep)) {
        $keep = $parsedKeep
    }
    else {
        $keep = 2
    }
}

$tok = Get-PublicGhToken
if (-not $tok) {
    throw "Need GITHUB_TOKEN, GH_TOKEN, or PUBLIC_REPO_TOKEN (scripts/maintainer/windows/local-publish.env)."
}

Invoke-PrunePublicGhReleasesCore -Token $tok -Keep $keep -Protect $ProtectTags

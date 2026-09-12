# Local replacement when GitHub Actions quota is exhausted.
# Mirrors (approximately):
#   .github/workflows/sync-public.yml        -> -SyncPublic
#   .github/workflows/deploy-site-tos.yml  -> -DeployWebsiteTos
#   .github/workflows/release-windows-desktop.yml (build + checksums) -> -BuildDesktopInstaller
#
# Config: copy scripts/maintainer/windows/local-publish.env.example -> scripts/maintainer/windows/local-publish.env (gitignored).
#         Optional: set env EVOFLOW_LOCAL_PUBLISH_ENV to an absolute path to use another file.
#
# Usage (from anywhere; script resolves repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\maintainer\windows\local-publish.ps1 -SyncPublic
#   powershell ... -DeployWebsiteTos
#   powershell ... -BuildDesktopInstaller
#   powershell ... -All
#   -All runs: BuildDesktopInstaller -> DeployWebsiteTos -> SyncPublic -> CreatePublicGhRelease (needs gh, SSH key, TOS_*).
#
# Prerequisites:
#   Copy local-publish.env.example -> local-publish.env next to this script (TOS_*, SSH path, etc.)
#   -SyncPublic: SSH key (EVOFLOW_PUBLIC_REPO_SSH_KEY �?EvovexAI org only, not evolvear personal key)
#   -FreshPublicHistory: with -SyncPublic, force one orphan commit on public main (clear old private-account history)
#   EVOFLOW_PUBLIC_GIT_USER_NAME / EVOFLOW_PUBLIC_GIT_USER_EMAIL: author on public mirror commits (default EvovexAI noreply)
#   -DeployWebsiteTos: pnpm 10+, Node 22; TOS_* from env file
#   -BuildDesktopInstaller: Node, Rust, uv; uses existing evopanel/node_modules (no npm ci unless -InstallNpmDeps). After NSIS build, only keeps installer/checksums for evopanel/package.json version (removes stale other-version files in bundle/nsis).
#   -CreatePublicGhRelease: GitHub CLI gh or GITHUB_TOKEN; uses version from evopanel/package.json. Only creates a NEW public Release for that tag �?never deletes assets or overwrites body/title on an existing Release (bump version for each upload). After upload, prune-public-github-releases.ps1 keeps only the newest 2 semver releases on EvovexAI/EvoFlow (env EVOFLOW_PUBLIC_RELEASE_KEEP_COUNT, default 2). Optional -PublicReleaseBodyPath (UTF-8 Markdown) overrides scripts/maintainer/windows/public-release-body.txt for the release body; env EVOFLOW_PUBLIC_RELEASE_BODY (path) also works.

param(
    [switch] $SyncPublic,
    # Replace public main with a single orphan commit (drops old history / wrong authors).
    [switch] $FreshPublicHistory,
    [switch] $DeployWebsiteTos,
    [switch] $BuildDesktopInstaller,
    [switch] $CreatePublicGhRelease,
    [switch] $All,
    [switch] $InstallNpmDeps,
    # HTTPS avoids broken global `url.*.insteadof` rules that rewrite `git@github.com:` incorrectly on some machines.
    [string] $PublicGitUrl = "https://github.com/EvovexAI/EvoFlow.git",
    [string] $SshKeyPath = "",
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
    $SyncPublic = $true
    $DeployWebsiteTos = $true
    $BuildDesktopInstaller = $true
    # Full local publish: also attach Windows installer to public GitHub Release (EvovexAI/EvoFlow).
    $CreatePublicGhRelease = $true
}

if (-not ($SyncPublic -or $DeployWebsiteTos -or $BuildDesktopInstaller -or $CreatePublicGhRelease)) {
    $helpText = @"
No action selected. Pick one or more:

  -SyncPublic              Clone public repo, copy whitelisted paths, push main (EvovexAI author only)
  -FreshPublicHistory      With -SyncPublic: one orphan commit on public main (erase old private-account history)
  -DeployWebsiteTos       pnpm install + build:static + deploy-tos.mjs (set TOS_* in local-publish.env)
  -BuildDesktopInstaller  evopanel build:desktop:win + SHA256SUMS (skips npm ci if node_modules already OK; use -InstallNpmDeps to run npm ci)
  -CreatePublicGhRelease  Create a NEW GitHub Release on EvovexAI/EvoFlow for evopanel/package.json version only (fails if that tag/release already exists; bump version then rebuild)
  -All                     BuildDesktopInstaller, then DeployWebsiteTos, SyncPublic, CreatePublicGhRelease (new public Release tag only)

  -InstallNpmDeps         With -BuildDesktopInstaller: run npm ci in evopanel first (clean install; slow on Windows)

Examples:
  .\scripts\maintainer\windows\local-publish.ps1 -SyncPublic
  .\scripts\maintainer\windows\local-publish.ps1 -DeployWebsiteTos
  .\scripts\maintainer\windows\local-publish.ps1 -BuildDesktopInstaller
  .\scripts\maintainer\windows\local-publish.ps1 -BuildDesktopInstaller -InstallNpmDeps
  .\scripts\maintainer\windows\local-publish.ps1 -BuildDesktopInstaller -CreatePublicGhRelease
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

function Remove-PublicRemoteTagsAndReleases {
    $token = $null
    if ($env:GITHUB_TOKEN -and $env:GITHUB_TOKEN.Trim().Length -gt 0) { $token = $env:GITHUB_TOKEN.Trim() }
    elseif ($env:PUBLIC_REPO_TOKEN -and $env:PUBLIC_REPO_TOKEN.Trim().Length -gt 0) { $token = $env:PUBLIC_REPO_TOKEN.Trim() }
    if (-not $token) {
        Write-Host "No GITHUB_TOKEN/PUBLIC_REPO_TOKEN �?skip deleting tags/releases (remove manually on GitHub)." -ForegroundColor Yellow
        return
    }
    $headers = @{
        Authorization          = "Bearer $token"
        Accept                 = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent"           = "EvoFlow-wipe-public-history"
    }
    $base = "https://api.github.com/repos/EvovexAI/EvoFlow"

    Write-Host "Removing GitHub Releases on EvovexAI/EvoFlow..." -ForegroundColor Cyan
    $page = 1
    while ($true) {
        $releases = Invoke-RestMethod -Uri "$base/releases?per_page=100&page=$page" -Headers $headers -Method Get
        if (-not $releases -or @($releases).Count -eq 0) { break }
        foreach ($rel in @($releases)) {
            Write-Host "  delete release $($rel.tag_name) (id=$($rel.id))" -ForegroundColor DarkGray
            Invoke-RestMethod -Uri "$base/releases/$($rel.id)" -Headers $headers -Method Delete | Out-Null
        }
        if (@($releases).Count -lt 100) { break }
        $page++
    }

    Write-Host "Removing git tags via GitHub API..." -ForegroundColor Cyan
    try {
        $tagRefs = Invoke-RestMethod -Uri "$base/git/refs/tags?per_page=100" -Headers $headers
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 404) {
            Write-Host "  (no tags)" -ForegroundColor DarkGray
            return
        }
        throw
    }
    foreach ($ref in @($tagRefs)) {
        $name = $ref.ref -replace '^refs/tags/', ''
        Write-Host "  delete tag $name" -ForegroundColor DarkGray
        Invoke-RestMethod -Uri "$base/git/refs/tags/$name" -Headers $headers -Method Delete | Out-Null
    }
}

function Copy-PublicTree {
    param(
        [Parameter(Mandatory)][string] $Source,
        [Parameter(Mandatory)][string] $Destination
    )
    $parent = Split-Path -Parent $Destination
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $Source)) { return }
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        if (Test-Path -LiteralPath $Destination) {
            Remove-Item -LiteralPath $Destination -Force
        }
        Copy-Item -LiteralPath $Source -Destination $Destination -Force
        return
    }
    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    $exclude = @("node_modules", ".next", "dist", ".turbo", ".git", ".cache", "coverage", ".pnpm-store")
    if (Test-Cmd "robocopy") {
        $xd = ($exclude | ForEach-Object { "/XD", $_ })
        & robocopy $Source $Destination /E @xd /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $Source -> $Destination" }
        return
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force -Exclude $exclude
}

function Resolve-PublicRepoSshKeyPath {
    param([string] $ExplicitPath)
    if ($ExplicitPath -and (Test-Path -LiteralPath $ExplicitPath)) {
        return $ExplicitPath
    }
    if ($env:EVOFLOW_PUBLIC_REPO_SSH_KEY -and $env:EVOFLOW_PUBLIC_REPO_SSH_KEY.Trim().Length -gt 0) {
        $p = $env:EVOFLOW_PUBLIC_REPO_SSH_KEY.Trim()
        if (Test-Path -LiteralPath $p) { return $p }
    }
    if ($env:PUBLIC_REPO_SSH_KEY -and $env:PUBLIC_REPO_SSH_KEY.Trim().Length -gt 0) {
        $b64 = ($env:PUBLIC_REPO_SSH_KEY -replace '\s+', '')
        try {
            $pem = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
        } catch {
            throw "PUBLIC_REPO_SSH_KEY is not valid base64 OpenSSH key: $($_.Exception.Message)"
        }
        $tmpKey = Join-Path $env:TEMP ("evoflow-public-" + [Guid]::NewGuid().ToString("N"))
        Write-Utf8NoBomFile -LiteralPath $tmpKey -Content $pem.TrimEnd() + "`n"
        return $tmpKey
    }
    $fallback = Join-Path $env:USERPROFILE ".ssh/id_ed25519"
    if (Test-Path -LiteralPath $fallback) { return $fallback }
    return $null
}

function Invoke-SyncPublic {
    Write-Host "`n=== SyncPublic (like .github/workflows/sync-public.yml) ===" -ForegroundColor Cyan
    if (-not (Test-Cmd "git")) { throw "git not found in PATH" }

    $script:PublicRepoTempSshKey = $null

    $cloneUrl = $PublicGitUrl
    if ($env:EVOFLOW_PUBLIC_GIT_URL -and $env:EVOFLOW_PUBLIC_GIT_URL.Trim().Length -gt 0) {
        $cloneUrl = $env:EVOFLOW_PUBLIC_GIT_URL.Trim()
    }

    $useSshForPublic = $cloneUrl -match '^(git@|ssh://)'
    if ($useSshForPublic) {
        $key = Resolve-PublicRepoSshKeyPath -ExplicitPath $SshKeyPath
        if (-not $key) {
            throw "SSH private key not found. Set EVOFLOW_PUBLIC_REPO_SSH_KEY (path), PUBLIC_REPO_SSH_KEY (base64), or -SshKeyPath"
        }
        if ($key -like "$env:TEMP*") { $script:PublicRepoTempSshKey = $key }
        $env:GIT_SSH_COMMAND = "ssh -i `"$key`" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
    }

    $authToken = $null
    if ($env:GITHUB_TOKEN -and $env:GITHUB_TOKEN.Trim().Length -gt 0) {
        $authToken = $env:GITHUB_TOKEN.Trim()
    }
    elseif ($env:PUBLIC_REPO_TOKEN -and $env:PUBLIC_REPO_TOKEN.Trim().Length -gt 0) {
        $authToken = $env:PUBLIC_REPO_TOKEN.Trim()
    }

    $cloneUrlEffective = $cloneUrl
    if (-not $useSshForPublic -and $authToken -and ($cloneUrl -match '^https://github\.com/')) {
        if ($cloneUrl -match '^https://github\.com/(.+)$') {
            $cloneUrlEffective = "https://x-access-token:$authToken@github.com/$($matches[1])"
        }
    }

    $publicFiles = @(
        # ?? update/?latest.json ??�?-UpdateLatestJson ????????????????????
        "docs", "README.md", "README.en.md", "CLAUDE.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SUPPORT.md", "SECURITY.md", "MAINTAINERS.md", "LICENSE",
        "NOTICE", "licenses",
        "mkdocs.yml", "requirements-docs.txt", ".gitignore", ".gitattributes",
        ".github/ISSUE_TEMPLATE", ".github/PULL_REQUEST_TEMPLATE.md", ".github/DISCUSSION_TEMPLATE"
    )

    $publicGitName = "EvovexAI"
    if ($env:EVOFLOW_PUBLIC_GIT_USER_NAME -and $env:EVOFLOW_PUBLIC_GIT_USER_NAME.Trim().Length -gt 0) {
        $publicGitName = $env:EVOFLOW_PUBLIC_GIT_USER_NAME.Trim()
    }
    $publicGitEmail = "evovexai@users.noreply.github.com"
    if ($env:EVOFLOW_PUBLIC_GIT_USER_EMAIL -and $env:EVOFLOW_PUBLIC_GIT_USER_EMAIL.Trim().Length -gt 0) {
        $publicGitEmail = $env:EVOFLOW_PUBLIC_GIT_USER_EMAIL.Trim()
    }

    $tmp = Join-Path $env:TEMP ("evoflow-public-sync-" + [Guid]::NewGuid().ToString("N"))
    if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null

    if ($FreshPublicHistory) {
        Write-Host "FreshPublicHistory: init empty repo (no clone) -> $tmp" -ForegroundColor DarkGray
        Push-Location $tmp
        try {
            & git -c init.defaultBranch=main init
            if ($LASTEXITCODE -ne 0) { throw "git init failed" }
        } catch {
            Pop-Location
            throw
        }
    } else {
        Write-Host "Cloning $cloneUrl -> $tmp" -ForegroundColor DarkGray
        if (-not $useSshForPublic) { $env:GIT_TERMINAL_PROMPT = "0" }
        try {
            if ($useSshForPublic) {
                & git clone $cloneUrlEffective $tmp
            } else {
                & git -c credential.helper= clone --depth 1 $cloneUrlEffective $tmp
            }
            if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
        } finally {
            if (-not $useSshForPublic) {
                Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
            }
        }
        Push-Location $tmp
    }

    try {
        & git config user.name $publicGitName
        & git config user.email $publicGitEmail
        Write-Host "Public commit author: $publicGitName <$publicGitEmail>" -ForegroundColor DarkGray

        if (-not $FreshPublicHistory) {
            & git rm -rf . 2>$null | Out-Null
            & git clean -fdx
            if ($LASTEXITCODE -ne 0) { throw "git clean failed" }
        }
        if (Test-Path ".sync-from") { Remove-Item -LiteralPath ".sync-from" -Force }

        foreach ($rel in $publicFiles) {
            $src = Join-Path $RepoRoot $rel
            if (-not (Test-Path -LiteralPath $src)) {
                Write-Host "  skip missing: $rel" -ForegroundColor DarkYellow
                continue
            }
            $dst = Join-Path $tmp $rel
            Copy-PublicTree -Source $src -Destination $dst
            Write-Host "  copied $rel" -ForegroundColor DarkGray
        }

        # ???????????????????????�?????�?
        $privateDocTrees = @(
            "docs\system",
            "docs\roles",
            "docs\prd",
            "docs\dev",
            "docs\verification",
            "docs\knowledge"
        )
        foreach ($rel in $privateDocTrees) {
            $privatePath = Join-Path $tmp $rel
            if (Test-Path -LiteralPath $privatePath) {
                Remove-Item -LiteralPath $privatePath -Recurse -Force
                Write-Host "  stripped $rel (private-only)" -ForegroundColor DarkGray
            }
        }
        Get-ChildItem -Path (Join-Path $tmp "docs") -Recurse -Force -Filter ".obsidian-hybrid-search.db*" -ErrorAction SilentlyContinue |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

        if (Test-Cmd "node") {
            $strip = Join-Path $RepoRoot ".github/scripts/strip-resume-for-public.mjs"
            if (-not (Test-Path -LiteralPath $strip)) {
                $strip = Join-Path $RepoRoot "scripts/maintainer/public-sync/strip-resume-for-public.mjs"
            }
            if (Test-Path -LiteralPath $strip) {
                & node $strip $tmp
                if ($LASTEXITCODE -ne 0) { throw "strip-resume-for-public.mjs failed" }
            }
        }

        Get-ChildItem -Path . -Directory -Filter "node_modules" -Recurse -ErrorAction SilentlyContinue |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
        if (Test-Path ".github") { Remove-Item -LiteralPath ".github" -Recurse -Force }

        if (-not (Test-Cmd "git-lfs")) {
            throw "git-lfs not found in PATH (required for public sync: large mp4 in docs/assets use Git LFS)"
        }
        & git lfs install 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git lfs install failed" }

        & git add -A
        & git status
        $commitMsg = "chore: update public mirror"
        if ($FreshPublicHistory) {
            & git add -A
            & git -c alias.commit= commit --no-verify -m "chore: initial public mirror"
            if ($LASTEXITCODE -ne 0) { throw "git commit failed (FreshPublicHistory)" }
            & git branch -M main
            $pushUrl = if ($useSshForPublic) { $cloneUrl } else { $cloneUrlEffective }
            & git remote add origin $pushUrl
            if ($LASTEXITCODE -ne 0) { throw "git remote add origin failed" }
            if (-not $useSshForPublic) { $env:GIT_TERMINAL_PROMPT = "0" }
            try {
                Remove-PublicRemoteTagsAndReleases
                & git push -u origin main --force
                if ($LASTEXITCODE -ne 0) { throw "git push --force failed (FreshPublicHistory)" }
            } finally {
                if (-not $useSshForPublic) {
                    Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
                }
            }
            Write-Host "Public main initialized (author $publicGitName, no link to private SHAs)." -ForegroundColor Green
            return
        }

        & git -c alias.commit= commit --no-verify -m $commitMsg
        if ($LASTEXITCODE -ne 0) { Write-Host "Nothing to commit (public already matches)?" -ForegroundColor Yellow }
        else {
            $pushed = $false
            foreach ($attempt in 1..3) {
                Write-Host "git push origin main (attempt $attempt/3)..." -ForegroundColor DarkGray
                & git -c http.postBuffer=524288000 -c http.lowSpeedLimit=0 -c http.lowSpeedTime=999999 push origin main
                if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
                if ($attempt -lt 3) { Start-Sleep -Seconds 15 }
            }
            if (-not $pushed) { throw "git push origin main failed" }
            Write-Host "Pushed public main." -ForegroundColor Green
        }
    } finally {
        Pop-Location
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        if ($useSshForPublic) {
            Remove-Item Env:\GIT_SSH_COMMAND -ErrorAction SilentlyContinue
        }
        if ($script:PublicRepoTempSshKey -and (Test-Path -LiteralPath $script:PublicRepoTempSshKey)) {
            Remove-Item -LiteralPath $script:PublicRepoTempSshKey -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-DeployWebsiteTos {
    Write-Host "`n=== DeployWebsiteTos (like deploy-site-tos.yml) ===" -ForegroundColor Cyan
    if (-not (Test-Cmd "pnpm")) { throw "pnpm not found in PATH (install pnpm 10+)" }
    $web = Join-Path $RepoRoot "website"
    Set-Location $web
    try {
        & pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
        & pnpm build:static
        if ($LASTEXITCODE -ne 0) { throw "pnpm build:static failed" }
        Set-Location (Join-Path $web "apps/web")
        & node scripts/deploy-tos.mjs
        if ($LASTEXITCODE -ne 0) { throw "deploy-tos.mjs failed" }
        Write-Host "TOS upload finished." -ForegroundColor Green
    } finally {
        Set-Location $RepoRoot
    }
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
    # ????????????�?build ????�?.exe �?Defender/??/?????? InFile ??�?
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
        throw "NSIS output missing: $nsis �?run -BuildDesktopInstaller first"
    }
    Sync-NsisReleaseArtifactsForEvopanelVersion
    $upload = @()
    $upload += Get-ChildItem -LiteralPath $nsis -Filter "*.exe" -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $verMark }
    $upload += Get-ChildItem -LiteralPath $nsis -Filter "*.msi" -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $verMark }
    $upload += Get-ChildItem -LiteralPath $nsis -Filter "*.sha256" -File -ErrorAction SilentlyContinue | Where-Object { ($_.Name -replace '\.sha256$', '') -match $verMark }
    $upload += Get-ChildItem -LiteralPath $nsis -Filter "SHA256SUMS.txt" -File -ErrorAction SilentlyContinue
    if ($upload.Count -eq 0) { throw "No release files under $nsis �?run -BuildDesktopInstaller first" }
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
gh release create failed (exit $LASTEXITCODE). If the release already exists for $ver, bump evopanel/package.json version, rebuild, and publish a new tag only �?same-tag uploads are not supported.
"@
        }
        Write-Host "Release $ver created on public repo (new tag only)." -ForegroundColor Green
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

# When building the desktop installer together with other steps, run build first (long),
# then website -> public git mirror -> GitHub Release assets on the public repo.
$runBuildFirst = $BuildDesktopInstaller -and ($DeployWebsiteTos -or $SyncPublic -or $CreatePublicGhRelease)
if ($runBuildFirst) {
    Invoke-BuildDesktopInstaller
    if ($DeployWebsiteTos) { Invoke-DeployWebsiteTos }
    if ($SyncPublic) { Invoke-SyncPublic }
    if ($CreatePublicGhRelease) { Invoke-CreatePublicGhRelease }
}
else {
    if ($DeployWebsiteTos) { Invoke-DeployWebsiteTos }
    if ($SyncPublic) { Invoke-SyncPublic }
    if ($BuildDesktopInstaller) { Invoke-BuildDesktopInstaller }
    if ($CreatePublicGhRelease) { Invoke-CreatePublicGhRelease }
}

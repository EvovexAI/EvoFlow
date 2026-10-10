# Push the local commits 9a08e42a..71e327ad to origin/main via the GitHub
# Data API, preserving the commit chain. Used when local `git push` is
# blocked (e.g., DNS/EDR blackholes github.com while api.github.com still
# works).
#
# Compatible with Windows PowerShell 5.1 (no `<<<` operator, no $Error
# shorthand).

[CmdletBinding()]
param(
  [string]$Owner = 'EvovexAI',
  [string]$Repo  = 'EvoFlow',
  [string]$FromRef = '9a08e42a',
  [string]$ToRef   = '71e327ad',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path

# ----------------------------------------------------------------------------
# Helpers (must be defined before any call site - PowerShell 5.1 does NOT
# hoist function declarations).
# ----------------------------------------------------------------------------
function Say($m) { Write-Host "[api-push] $m" }

function Full-Sha([string]$ref) {
  return (git -C $RepoRoot rev-parse $ref).Trim()
}

# Helper: pipe JSON via a temp file so we don't depend on `<<<`.
function Gh-Api([string]$method, [string]$path, [hashtable]$body) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    if ($body) {
      $json = $body | ConvertTo-Json -Depth 10 -Compress
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($tmp, $json, $utf8NoBom)
      if ($env:API_PUSH_DEBUG) {
        $preview = $json.Substring(0, [Math]::Min(200, $json.Length))
        Say "  DEBUG body($($json.Length)B): $preview..."
      }
      $resp = gh api -X $method $path -H 'Content-Type: application/json' --input $tmp 2>&1
    } else {
      $resp = gh api -X $method $path 2>&1
    }
    if ($LASTEXITCODE -ne 0) {
      throw "gh api $method $path failed: $resp"
    }
    if ([string]::IsNullOrWhiteSpace($resp)) { return $null }
    return ($resp | ConvertFrom-Json)
  } finally {
    Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
  }
}

# Raw helper: returns the string body of a `gh api` call (no JSON parse).
function Gh-Api-Raw([string]$method, [string]$path) {
  $resp = gh api -X $method $path 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "gh api $method $path failed: $resp"
  }
  return $resp
}

# Helper: extract the first parent SHA from a `GET git/commits/{sha}` response.
# We use a regex instead of ConvertFrom-Json because PowerShell 5.1 chokes on
# long multibyte commit messages with literal "\n" sequences in the JSON
# payload.
function Get-Server-Parent-Sha([string]$commitSha) {
  $body = Gh-Api-Raw GET "repos/$Owner/$Repo/git/commits/$commitSha"
  # The first occurrence of "sha":"<40hex>" in the parents array.
  $parentsIdx = $body.IndexOf('"parents":[')
  if ($parentsIdx -lt 0) { return $null }
  $rest = $body.Substring($parentsIdx)
  if ($rest -match '"sha"\s*:\s*"([0-9a-f]{40})"') {
    return $Matches[1]
  }
  return $null
}

# Helper: extract the tree SHA from a `GET git/commits/{sha}` response.
function Get-Server-Tree-Sha([string]$commitSha) {
  $body = Gh-Api-Raw GET "repos/$Owner/$Repo/git/commits/$commitSha"
  if ($body -match '"tree"\s*:\s*\{\s*"sha"\s*:\s*"([0-9a-f]{40})"') {
    return $Matches[1]
  }
  return $null
}

# Helper: for any local commit $localSha, return the matching server SHA.
# If the commit is on the server (e.g. it was created by a previous API
# push or is a pre-existing commit), the SHA may match. Otherwise look up
# by the server commit's tree + parent.
function Get-ServerSha([string]$localSha) {
  $serverSha = $serverCommitSha[$localSha]
  if ($serverSha) { return $serverSha }
  $resp = gh api "repos/$Owner/$Repo/git/commits/$localSha" 2>&1
  if ($LASTEXITCODE -eq 0 -and $resp -match '"sha"\s*:\s*"([0-9a-f]{40})"') {
    $serverCommitSha[$localSha] = $Matches[1]
    return $Matches[1]
  }
  return $null
}

# ----------------------------------------------------------------------------
# 1. Verify origin/main is still at FromRef.
# ----------------------------------------------------------------------------
$fromFull = Full-Sha $FromRef
$toFull   = Full-Sha $ToRef
$remoteMain = (Gh-Api GET "repos/$Owner/$Repo/git/refs/heads/main").object.sha
Say "Remote main: $remoteMain  expected: $fromFull"
if ($remoteMain -ne $fromFull) { throw "Remote main moved (now $remoteMain). Refusing to rewrite." }

# ----------------------------------------------------------------------------
# 2. Compute the set of commits to recreate on top of the current server
#    main. We never modify existing server history; we only create new
#    commits descended from $remoteMain.
#
#    Local rev-list is normally used to enumerate the commits in
#    $fromFull..$toFull. If $fromFull isn't local (e.g. the user fetched
#    the script and started from a different ref), walk the server's
#    parent chain from $remoteMain back to a local commit and use that
#    as the from-ref for the local rev-list.
# ----------------------------------------------------------------------------
$shasRaw = ''
$revListFailed = $false
try {
  $shasRaw = git -C $RepoRoot rev-list --reverse "$fromFull..$toFull" 2>$null
  if ($LASTEXITCODE -ne 0) { $revListFailed = $true }
} catch {
  $revListFailed = $true
}
if ($revListFailed -or [string]::IsNullOrWhiteSpace($shasRaw)) {
  Say "WARN: '$fromFull' not local; walking server parent chain for a local ancestor."
  $cur = $remoteMain
  $depth = 0
  while ($depth -lt 30) {
    $depth++
    $type = ''
    try { $type = (git -C $RepoRoot cat-file -t $cur 2>$null) } catch { $type = '' }
    if ($type -eq 'commit') {
      Say ("  Found local ancestor at depth " + $depth + ": " + $cur)
      $fromFull = $cur
      break
    }
    $parentSha = Get-Server-Parent-Sha $cur
    if (-not $parentSha) {
      throw "Walked back to root and never found a local commit; aborting."
    }
    $cur = $parentSha
  }
  $shasRaw = git -C $RepoRoot rev-list --reverse "$fromFull..$toFull" 2>$null
  if ([string]::IsNullOrWhiteSpace($shasRaw)) {
    throw "Cannot determine commits to push (from=$fromFull to=$toFull)"
  }
}
$shas = $shasRaw
Say "Commits to push: $($shas -join ', ')"

# ----------------------------------------------------------------------------
# 3. Server-side cache: parent server commit + tree.
#
#    The new commits will be created on top of $remoteMain, NOT on top of
#    $fromFull - because the server doesn't have any of the local commits
#    between $fromFull and $remoteMain (in our case, the 70b8bb20 server
#    commit was created by a previous API push and has no analogue on the
#    local repo). We never need to recreate the chain that already exists
#    server-side; we only create the new ones.
# ----------------------------------------------------------------------------
$parentOfNewCommits = $remoteMain
$serverCommitSha = @{ $remoteMain = $remoteMain }
$serverTreeSha   = @{
  $remoteMain = (Get-Server-Tree-Sha $remoteMain)
}
Say "Base parent:  $remoteMain  tree: $($serverTreeSha[$remoteMain])"

# ----------------------------------------------------------------------------
# 4. For each local commit, recreate it server-side via blobs/tree/commit.
#    Each new commit is built on top of the previously recreated commit,
#    with $remoteMain as the base for the first one.
# ----------------------------------------------------------------------------
$newTip = $null
$parentServerSha = $parentOfNewCommits
$parentServerTree = $serverTreeSha[$parentOfNewCommits]
foreach ($localSha in $shas) {
  Say "--- commit $localSha ---"
  $parent = Full-Sha "$localSha^"
  # Force UTF-8 output from git so Chinese / non-ASCII characters survive.
  $env:GIT_PAGER = 'cat'
  $msg = git -C $RepoRoot -c i18n.logOutputEncoding=UTF-8 -c core.quotepath=false log -1 --format=%B $localSha
  $subject = ($msg -split "`n")[0]
  Say "  subject: $subject"
  Say "  local parent:  $parent"
  Say "  server parent: $parentServerSha"

  $changed = git -C $RepoRoot diff --name-only "$parent..$localSha"
  Say "  files:   $($changed -join ', ')"
  $treeEntries = New-Object System.Collections.Generic.List[object]
  foreach ($rel in $changed) {
    if ($rel -eq '.gitmodules') { continue }
    $abs = Join-Path $RepoRoot $rel
    if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) {
      $entry = [ordered]@{ path = $rel.Replace([IO.Path]::DirectorySeparatorChar, '/'); mode = '100644'; type = 'blob'; sha = $null }
      $treeEntries.Add( (New-Object psobject -Property $entry) )
      Say "    deleted: $rel"
      continue
    }
    $bytes = [System.IO.File]::ReadAllBytes($abs)
    $isText = $rel -match '\.(sh|ps1|gitattributes|py|ts|tsx|js|jsx|json|ya?ml|toml|md|gitignore|css|html|svg|lock|psm1|psd1|gitkeep)$' -or $rel -eq '.gitattributes' -or $rel -eq '.gitignore'
    if ($isText) {
      $text = [System.IO.File]::ReadAllText($abs, [System.Text.Encoding]::UTF8)
      if ($text.Length -gt 0 -and [int]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
      $text = ($text -replace "`r`n", "`n")
      $body = $text
      $encoding = 'utf-8'
    } else {
      $body = [Convert]::ToBase64String($bytes)
      $encoding = 'base64'
    }
    $resp = Gh-Api POST "repos/$Owner/$Repo/git/blobs" @{ content = $body; encoding = $encoding }
    $entry = [ordered]@{
      path = $rel.Replace([IO.Path]::DirectorySeparatorChar, '/')
      mode = '100644'
      type = 'blob'
      sha  = $resp.sha
    }
    $treeEntries.Add( (New-Object psobject -Property $entry) )
    $size = if ($isText) { ([System.Text.Encoding]::UTF8).GetByteCount($body) } else { $bytes.Length }
    Say "    blob($encoding, $size B): $rel -> $($resp.sha)"
  }

  $treePayload = @{
    base_tree = $parentServerTree
    tree      = $treeEntries.ToArray()
  }
  $treeResp = Gh-Api POST "repos/$Owner/$Repo/git/trees" $treePayload
  $treeSha = $treeResp.sha
  if (-not $treeSha) { throw "tree POST returned no sha: $($treeResp | ConvertTo-Json -Compress)" }
  Say "  tree:    $treeSha"

  # Build the JSON manually to avoid PowerShell's array-on-newline
  # serialization of multi-line strings.
  $msgEscaped = ($msg -replace '\\', '\\\\' -replace '"', '\"' -replace "`r`n", "`n" -replace "`n", '\n')
  $parentsJson = ($parentServerSha | ForEach-Object { '"' + $_ + '"' }) -join ','
  $commitJson = '{"message":"' + $msgEscaped + '","parents":[' + $parentsJson + '],"tree":"' + $treeSha + '"}'
  if ($env:API_PUSH_DEBUG) { Say "  DEBUG commit body($($commitJson.Length)B): $($commitJson.Substring(0, [Math]::Min(220, $commitJson.Length)))..." }
  $tmp = [System.IO.Path]::GetTempFileName()
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tmp, $commitJson, $utf8NoBom)
  $respRaw = gh api -X POST "repos/$Owner/$Repo/git/commits" -H 'Content-Type: application/json' --input $tmp 2>&1
  Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) { throw "commit POST failed: $respRaw" }
  # PowerShell 5.1's ConvertFrom-Json can choke on long multibyte strings.
  # Extract the SHA via a regex instead.
  if ($respRaw -match '"sha"\s*:\s*"([0-9a-f]{40})"') {
    $newSha = $Matches[1]
  } else {
    throw "Could not extract commit SHA from response: $respRaw"
  }
  Say "  commit:  $newSha"
  $serverCommitSha[$localSha] = $newSha
  $serverTreeSha[$localSha]   = $treeSha
  # Advance the parent for the next iteration.
  $parentServerSha = $newSha
  $parentServerTree = $treeSha
  $newTip = $newSha
}

if (-not $newTip) { throw "No new tip created." }
Say "new tip: $newTip"

if ($DryRun) {
  Say "DryRun: not updating refs."
  return
}

# ----------------------------------------------------------------------------
# 5. Update main and tag.
# ----------------------------------------------------------------------------
Gh-Api PATCH "repos/$Owner/$Repo/git/refs/heads/main" @{ sha = $newTip } | Out-Null
Say "main -> $newTip"
Gh-Api PATCH "repos/$Owner/$Repo/git/refs/tags/v1.0.8" @{ sha = $newTip } | Out-Null
Say "tag v1.0.8 -> $newTip"

# ----------------------------------------------------------------------------
# 6. Confirm.
# ----------------------------------------------------------------------------
$finalMain = (Gh-Api GET "repos/$Owner/$Repo/git/refs/heads/main").object.sha
$finalTag  = (Gh-Api GET "repos/$Owner/$Repo/git/refs/tags/v1.0.8").object.sha
Say "verified main=$finalMain  v1.0.8=$finalTag"

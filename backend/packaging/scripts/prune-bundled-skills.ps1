# Prune oversized / non-runtime skill payloads after copying skills/public into the gateway bundle.
# Also drop skills that must not ship in the public installer (gitignored / scrubbed packs)
# and refuse OpenClaw / ~/.openclaw residue in remaining skill text.
# Usage: . .\prune-bundled-skills.ps1; Remove-BundledSkillBloat -SkillsPublicDir $path

function Remove-BundledSkillBloat {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SkillsPublicDir
  )

  if (-not (Test-Path -LiteralPath $SkillsPublicDir)) {
    Write-Host "[skills-prune] skip: missing $SkillsPublicDir"
    return
  }

  # Not redistributed in public desktop builds (also listed under .gitignore skills/public/*).
  $excludedSkills = @(
    "desktop-control",
    "wechat-chat",
    "content-hunter",
    "canvas",
    "gh-issues",
    "newmedia-operations",
    "aihot",
    "wechat-mp-writer-skill-mxx"
  )

  $relativeTargets = @(
    # demo media only (~38MB)
    "hyperframes-animation\examples"
  ) + ($excludedSkills | ForEach-Object { $_ })

  $removed = 0L
  foreach ($rel in $relativeTargets) {
    $full = Join-Path $SkillsPublicDir $rel
    if (-not (Test-Path -LiteralPath $full)) { continue }
    $bytes = 0L
    Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction SilentlyContinue |
      ForEach-Object { $bytes += $_.Length }
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
    $mb = [math]::Round($bytes / 1MB, 1)
    Write-Host "[skills-prune] removed $rel (~${mb} MB)"
    $removed += $bytes
  }

  # Safety net: any leftover node_modules under bundled skills (gitignored locally, still risky)
  Get-ChildItem -LiteralPath $SkillsPublicDir -Directory -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'node_modules' } |
    ForEach-Object {
      $bytes = 0L
      Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
        ForEach-Object { $bytes += $_.Length }
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
      $rel = $_.FullName.Substring($SkillsPublicDir.Length).TrimStart('\', '/')
      $mb = [math]::Round($bytes / 1MB, 1)
      Write-Host "[skills-prune] removed $rel (~${mb} MB)"
      $removed += $bytes
    }

  # Brand gate: no OpenClaw / ~/.openclaw compatibility residue in shipped skill text.
  $brandHits = New-Object System.Collections.Generic.List[string]
  $scanExt = @('.md', '.js', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.txt')
  Get-ChildItem -LiteralPath $SkillsPublicDir -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $scanExt -contains $_.Extension.ToLowerInvariant() } |
    ForEach-Object {
      try {
        $text = [System.IO.File]::ReadAllText($_.FullName)
      } catch {
        return
      }
      if ($text -match '(?i)openclaw|\.openclaw\b') {
        $rel = $_.FullName.Substring($SkillsPublicDir.Length).TrimStart('\', '/')
        $brandHits.Add($rel)
      }
    }
  if ($brandHits.Count -gt 0) {
    Write-Host "[skills-prune] OpenClaw residue in bundled skills:" -ForegroundColor Red
    $brandHits | Select-Object -First 30 | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    throw "[skills-prune] refusing to ship skills with OpenClaw / ~/.openclaw residue ($($brandHits.Count) file(s))"
  }

  Write-Host "[skills-prune] total removed ~$([math]::Round($removed / 1MB, 1)) MB from $SkillsPublicDir"
}

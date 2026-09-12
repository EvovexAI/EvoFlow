# Fail if PowerShell sources contain non-ASCII bytes (breaks PS 5.1 on GHA when read as system ANSI).
# Usage (GHA/cmd-safe): verify-ps1-ascii.ps1 path1.ps1 path2.ps1
# Do not use -Paths @(a,b) after -File; cmd does not pass arrays correctly.
param(
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Paths
)

$ErrorActionPreference = "Stop"
$failed = @()

foreach ($rel in $Paths) {
  if (-not (Test-Path -LiteralPath $rel)) {
    Write-Error "File not found: $rel"
    exit 1
  }
  $full = (Resolve-Path -LiteralPath $rel).Path
  $bytes = [System.IO.File]::ReadAllBytes($full)
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    if ($bytes[$i] -gt 127) {
      $failed += $rel
      break
    }
  }
}

if ($failed.Count -gt 0) {
  Write-Error ("Non-ASCII bytes in PowerShell script(s): " + ($failed -join ", "))
  exit 1
}

Write-Host "[verify-ps1-ascii] OK: $($Paths.Count) file(s)"

param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$RipgrepVersion = "14.1.1"
$ScriptDir = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$BackendDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir "..\.."))
$BundleRoot = Join-Path $BackendDir "packaging\ripgrep-bundle"
$TargetDir = Join-Path $BundleRoot "win-x64"
$RgExe = Join-Path $TargetDir "rg.exe"
$LicenseFile = Join-Path $TargetDir "COPYING"

function Test-RipgrepBundlePresent {
  return (Test-Path -LiteralPath $RgExe) -and (Test-Path -LiteralPath $LicenseFile)
}

if ((Test-RipgrepBundlePresent) -and -not $Force) {
  Write-Host "[ripgrep-bundle] already present under $TargetDir (use -Force to refresh)"
  exit 0
}

$ArchiveName = "ripgrep-$RipgrepVersion-x86_64-pc-windows-msvc.zip"
$DownloadUrl = "https://github.com/BurntSushi/ripgrep/releases/download/$RipgrepVersion/$ArchiveName"
$TempRoot = Join-Path $BackendDir ".build-temp\ripgrep-download"
$ZipPath = Join-Path $TempRoot $ArchiveName

if (Test-Path -LiteralPath $TempRoot) {
  Remove-Item -Path $TempRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null

Write-Host "[ripgrep-bundle] downloading $DownloadUrl"
Invoke-WebRequest -Uri $DownloadUrl -OutFile $ZipPath -UseBasicParsing

$ExtractDir = Join-Path $TempRoot "extract"
Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force

$InnerRoot = Get-ChildItem -LiteralPath $ExtractDir -Directory | Select-Object -First 1
if (-not $InnerRoot) {
  throw "ripgrep archive missing top-level directory: $ExtractDir"
}

$SourceRg = Join-Path $InnerRoot.FullName "rg.exe"
$SourceLicense = Join-Path $InnerRoot.FullName "COPYING"
if (-not (Test-Path -LiteralPath $SourceRg)) {
  throw "rg.exe not found in archive: $SourceRg"
}

Copy-Item -LiteralPath $SourceRg -Destination $RgExe -Force
if (Test-Path -LiteralPath $SourceLicense) {
  Copy-Item -LiteralPath $SourceLicense -Destination $LicenseFile -Force
} else {
  @(
    "Ripgrep $RipgrepVersion",
    "Source: $DownloadUrl",
    "License: Unlicense / dual-licensed (see upstream ripgrep repository)."
  ) | Set-Content -Path $LicenseFile -Encoding UTF8
}

Remove-Item -Path $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "[ripgrep-bundle] installed -> $RgExe"

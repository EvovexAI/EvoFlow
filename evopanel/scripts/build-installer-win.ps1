# EvoPanel Windows installer build. ASCII-only strings for PS 5.1 (CI uses system ANSI, not UTF-8).
param(
  [switch]$SkipBackendBuild,
  [switch]$SkipBundleBuild,
  [switch]$NoParallel
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$msg) {
  Write-Host "[build-installer] $msg"
}

function Get-UpdaterSigningKeyMaterial([string]$ProjectDir) {
  if ($env:TAURI_SIGNING_PRIVATE_KEY -and $env:TAURI_SIGNING_PRIVATE_KEY.Trim().Length -gt 0) {
    return $env:TAURI_SIGNING_PRIVATE_KEY.Trim()
  }
  $keyPath = Join-Path $ProjectDir "src-tauri\updater-signing.key"
  if (Test-Path -LiteralPath $keyPath) {
    return (Get-Content -LiteralPath $keyPath -Raw).Trim()
  }
  return ""
}

function Test-UpdaterSigningReady([string]$ProjectDir) {
  if ($env:EVOFLOW_SKIP_UPDATER_SIGN -eq "1") { return $false }
  $material = Get-UpdaterSigningKeyMaterial -ProjectDir $ProjectDir
  if ($material.Length -lt 280) { return $false }
  return $true
}

function Clear-EmptyUpdaterSigningPasswordEnv() {
  if ($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { return }
  if ($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD.Trim().Length -eq 0) {
    Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    Write-Step "updater signing: removed empty TAURI_SIGNING_PRIVATE_KEY_PASSWORD (delete blank GitHub secret)"
  }
}

function Set-UpdaterSigningEnv([string]$ProjectDir) {
  Clear-EmptyUpdaterSigningPasswordEnv
  if (-not (Test-UpdaterSigningReady -ProjectDir $ProjectDir)) {
    Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
    $len = (Get-UpdaterSigningKeyMaterial -ProjectDir $ProjectDir).Length
    if ($len -gt 0 -and $len -lt 280) {
      Write-Step "updater signing: disabled (key too short: $len chars, need at least 350 - fix TAURI_SIGNING_PRIVATE_KEY secret)"
    } else {
      Write-Step "updater signing: disabled (no valid key - exe only, no in-app one-click update)"
    }
    $env:EVOFLOW_UPDATER_SIGN_ENABLED = "0"
    return $false
  }
  $material = Get-UpdaterSigningKeyMaterial -ProjectDir $ProjectDir
  $env:TAURI_SIGNING_PRIVATE_KEY = $material
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
  Write-Step "updater signing: enabled ($($material.Length) chars)"
  $env:EVOFLOW_UPDATER_SIGN_ENABLED = "1"
  return $true
}

function Invoke-TauriBundleBuild([string]$ProjectDir, [string]$TauriConfig = "") {
  $signEnabled = Set-UpdaterSigningEnv -ProjectDir $ProjectDir
  $localTemp = Join-Path $ProjectDir ".build-temp"
  $localNpmCache = Join-Path $localTemp "npm-cache"
  if (Test-Path $localTemp) {
    Remove-Item -Path $localTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Path $localTemp -Force | Out-Null
  New-Item -ItemType Directory -Path $localNpmCache -Force | Out-Null

  # Some Windows environments may leave stale linker temp files locked.
  Get-ChildItem -Path $env:LOCALAPPDATA\Temp -Filter "lnk*.tmp" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

  $oldTemp = $env:TEMP
  $oldTmp = $env:TMP
  $oldNpmCache = $env:npm_config_cache
  $env:TEMP = $localTemp
  $env:TMP = $localTemp
  # Avoid writing npm cache to C:\Users\...\AppData\Local\npm-cache when C disk is tight.
  $env:npm_config_cache = $localNpmCache
  $tauriCli = Join-Path $ProjectDir "node_modules\@tauri-apps\cli\tauri.js"
  if (-not (Test-Path -LiteralPath $tauriCli)) {
    throw "Tauri CLI not found: $tauriCli (run npm ci in evopanel first)"
  }
  try {
    Push-Location $ProjectDir
    # Call CLI directly. Use --config=path (one arg): separate --config + path is forwarded to cargo on Windows.
    $tauriArgs = @("build")
    $configFiles = @()
    if ($TauriConfig) {
      $configFiles += $TauriConfig
    }
    if (-not $signEnabled) {
      $configFiles += "src-tauri/tauri.ci-nosign.conf.json"
    }
    foreach ($cfg in $configFiles) {
      $configFile = if ([System.IO.Path]::IsPathRooted($cfg)) { $cfg } else { Join-Path $ProjectDir $cfg }
      if (-not (Test-Path -LiteralPath $configFile)) {
        throw "Tauri config overlay not found: $configFile"
      }
      $tauriArgs += "--config=$configFile"
    }
    Write-Step "tauri: node tauri.js $($tauriArgs -join ' ')"
    & node $tauriCli @tauriArgs | Out-Host
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) {
      $exitCode = 0
    }
    return [int]$exitCode
  }
  finally {
    Pop-Location -ErrorAction SilentlyContinue
    $env:TEMP = $oldTemp
    $env:TMP = $oldTmp
    $env:npm_config_cache = $oldNpmCache
  }
}

function Write-ProcessLog([string]$LogPath, [string]$Label) {
  if (!(Test-Path $LogPath)) {
    return
  }
  Write-Step "$Label log: $LogPath"
  Get-Content -Path $LogPath -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
}

function Invoke-ParallelBackendAndFrontend(
  [string]$BackendBuildScript,
  [string]$BackendOutputDir,
  [string]$ProjectDir,
  [string]$BackendBuildTempRoot
) {
  Write-Step "building backend sidecar and frontend in parallel"
  $parallelStart = Get-Date
  $logDir = Join-Path $ProjectDir ".build-temp\parallel-logs"
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  $backendLog = Join-Path $logDir "backend.log"
  $backendErrLog = Join-Path $logDir "backend.err.log"
  $frontendLog = Join-Path $logDir "frontend.log"
  $frontendErrLog = Join-Path $logDir "frontend.err.log"

  # Start-Process avoids Start-Job remoting, which treats Node stderr as terminating errors.
  $backendProc = Start-Process -FilePath "powershell.exe" -PassThru -NoNewWindow -Wait:$false `
    -ArgumentList @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $BackendBuildScript,
      "-OutputPath", $BackendOutputDir,
      "-BuildTempRoot", $BackendBuildTempRoot
    ) `
    -RedirectStandardOutput $backendLog `
    -RedirectStandardError $backendErrLog

  $frontendTemp = Join-Path $ProjectDir ".build-temp\frontend-temp"
  New-Item -ItemType Directory -Path $frontendTemp -Force | Out-Null
  $frontendDist = Join-Path $ProjectDir "dist"
  $frontendCmd = @"
`$env:TEMP='$frontendTemp'; `$env:TMP='$frontendTemp';
Set-Location -LiteralPath '$ProjectDir'
if (Test-Path -LiteralPath '$frontendDist') {
  Remove-Item -LiteralPath '$frontendDist' -Recurse -Force
  Write-Host '[frontend] cleaned stale dist/'
}
npm run build
"@
  $frontendProc = Start-Process -FilePath "powershell.exe" -PassThru -NoNewWindow -Wait:$false `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $frontendCmd) `
    -RedirectStandardOutput $frontendLog `
    -RedirectStandardError $frontendErrLog

  $null = Wait-Process -InputObject @($backendProc, $frontendProc)

  Write-ProcessLog -LogPath $backendLog -Label "Backend sidecar build (stdout)"
  Write-ProcessLog -LogPath $backendErrLog -Label "Backend sidecar build (stderr)"
  if ($backendProc.ExitCode -ne 0) {
    throw "Backend sidecar build failed with exit code: $($backendProc.ExitCode)"
  }

  Write-ProcessLog -LogPath $frontendLog -Label "Frontend build (stdout)"
  Write-ProcessLog -LogPath $frontendErrLog -Label "Frontend build (stderr)"
  if ($frontendProc.ExitCode -ne 0) {
    throw "Frontend build failed with exit code: $($frontendProc.ExitCode)"
  }

  $elapsed = [math]::Round(((Get-Date) - $parallelStart).TotalSeconds, 1)
  Write-Step "parallel backend+frontend finished in ${elapsed}s"
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DeerpanelDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $DeerpanelDir "..")).Path
$BackendBuildScript = Join-Path $RepoRoot "backend\packaging\windows\build-gateway-exe.ps1"
$BackendOutputDir = Join-Path $DeerpanelDir "src-tauri\binaries\evoflow-gateway"
$LegacyBackendExe = Join-Path $DeerpanelDir "src-tauri\binaries\evoflow-gateway.exe"
$OldBackendExe = Join-Path $DeerpanelDir "src-tauri\binaries\backend-gateway.exe"
$OldBackendDir = Join-Path $DeerpanelDir "src-tauri\binaries\backend-gateway"
$OldBackendV2Dir = Join-Path $DeerpanelDir "src-tauri\binaries\backend-gateway-v2"
$OldRenamedV2Dir = Join-Path $DeerpanelDir "src-tauri\binaries\evoflow-gateway-v2"
$BundleDir = Join-Path $DeerpanelDir "src-tauri\target\release\bundle\nsis"
$FrontendDistDir = Join-Path $DeerpanelDir "dist"
$PrebuiltFrontendConfig = "src-tauri/tauri.prebuilt-frontend.conf.json"
$GatewayBuildTempRoot = Join-Path $DeerpanelDir ".build-temp\gateway-build"
$BuildStart = Get-Date

$useParallel = (-not $NoParallel) -and (-not $SkipBackendBuild) -and (-not $SkipBundleBuild)

function Get-DriveFreeGb([string]$Path) {
  $root = [System.IO.Path]::GetPathRoot($Path)
  if ([string]::IsNullOrWhiteSpace($root)) { return $null }
  $drive = Get-PSDrive -Name $root.TrimEnd('\', ':') -ErrorAction SilentlyContinue
  if (-not $drive) { return $null }
  return [math]::Round($drive.Free / 1GB, 2)
}

Write-Step "repo root: $RepoRoot"
Write-Step "evopanel dir: $DeerpanelDir"

Write-Step "sync app version from evopanel/VERSION"
Push-Location $DeerpanelDir
try {
  & npm run version:sync --silent 2>$null
  if ($LASTEXITCODE -ne 0) {
    & npm run version:sync | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "version:sync failed (edit evopanel/VERSION then retry)" }
  }
  $ver = (Get-Content -Path (Join-Path $DeerpanelDir "VERSION") -Raw).Trim()
  Write-Step "installer version: $ver"
}
finally {
  Pop-Location -ErrorAction SilentlyContinue
}
$cFree = Get-DriveFreeGb -Path $env:SystemDrive
if ($null -ne $cFree -and $cFree -lt 2) {
  Write-Step "warning: system drive $env:SystemDrive has ${cFree} GB free - build temp uses $GatewayBuildTempRoot on D drive (or repo drive)"
}
if ($useParallel) {
  Write-Step "parallel mode: backend PyInstaller + vite (pass -NoParallel to run sequentially)"
} else {
  # Sequential Tauri beforeBuildCommand runs vite; wipe stale dist so orphaned public/
  # copies (old kws models, etc.) cannot re-enter the installer.
  if ((-not $SkipBundleBuild) -and (Test-Path -LiteralPath $FrontendDistDir)) {
    Write-Step "cleaning stale frontend dist: $FrontendDistDir"
    Remove-Item -LiteralPath $FrontendDistDir -Recurse -Force
  }
}
if (Test-Path $LegacyBackendExe) {
  Write-Step "removing legacy binary: $LegacyBackendExe"
  Remove-Item -Path $LegacyBackendExe -Force -ErrorAction SilentlyContinue
}
# evoflow-gateway/ is the current sidecar output dir; build-gateway-exe.ps1 recreates it when rebuilding.
if (Test-Path $OldBackendExe) {
  Write-Step "removing old binary: $OldBackendExe"
  Remove-Item -Path $OldBackendExe -Force -ErrorAction SilentlyContinue
}
if (Test-Path $OldBackendDir) {
  Write-Step "removing old directory: $OldBackendDir"
  Remove-Item -Path $OldBackendDir -Recurse -Force -ErrorAction SilentlyContinue
}
if (Test-Path $OldBackendV2Dir) {
  Write-Step "removing old directory: $OldBackendV2Dir"
  Remove-Item -Path $OldBackendV2Dir -Recurse -Force -ErrorAction SilentlyContinue
}
if (Test-Path $OldRenamedV2Dir) {
  Write-Step "removing old directory: $OldRenamedV2Dir"
  Remove-Item -Path $OldRenamedV2Dir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($useParallel) {
  Invoke-ParallelBackendAndFrontend -BackendBuildScript $BackendBuildScript -BackendOutputDir $BackendOutputDir -ProjectDir $DeerpanelDir -BackendBuildTempRoot $GatewayBuildTempRoot
} else {
  if (-not $SkipBackendBuild) {
    Write-Step "building backend sidecar"
    & $BackendBuildScript -OutputPath $BackendOutputDir -BuildTempRoot $GatewayBuildTempRoot
  }
}

if (!(Test-Path $BackendOutputDir)) {
  throw "Backend output dir not found: $BackendOutputDir"
}

# Even with -SkipBackendBuild, refuse to NSIS-pack a fat/stale sidecar.
$LeanAssert = Join-Path $RepoRoot "backend\packaging\windows\assert-lean-gateway-bundle.ps1"
Write-Step "assert lean gateway sidecar (no Chromium/torch unless explicitly opted in)"
& $LeanAssert -GatewayDir $BackendOutputDir

$ManifestPath = Join-Path $BackendOutputDir "sidecar-manifest.json"
$ExpectedVer = (Get-Content -LiteralPath (Join-Path $DeerpanelDir "VERSION") -Raw).Trim()
if (-not (Test-Path -LiteralPath $ManifestPath)) {
  Write-Step "sidecar-manifest missing; writing from evopanel/VERSION"
  & (Join-Path $RepoRoot "backend\packaging\windows\write-sidecar-manifest.ps1") -GatewayDir $BackendOutputDir
}
$manifestObj = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$manifestVer = [string]$manifestObj.panel_version
if ($manifestVer -ne $ExpectedVer) {
  throw "sidecar-manifest panel_version='$manifestVer' != evopanel/VERSION='$ExpectedVer' (rebuild sidecar or re-run write-sidecar-manifest)"
}
Write-Step "sidecar pin ok: panel_version=$manifestVer"

if (-not $SkipBundleBuild) {
  if (-not $useParallel) {
    Write-Step "building desktop installer (tauri nsis)"
  } else {
    Write-Step "building desktop installer (tauri nsis, frontend already built)"
  }
  Push-Location $DeerpanelDir
  try {
    if ($useParallel -and !(Test-Path $FrontendDistDir)) {
      throw "Frontend dist not found after parallel build: $FrontendDistDir"
    }
    $tauriConfig = ""
    if ($useParallel) {
      $tauriConfig = $PrebuiltFrontendConfig
    }
    $buildExitCode = Invoke-TauriBundleBuild -ProjectDir $DeerpanelDir -TauriConfig $tauriConfig
    if ($buildExitCode -ne 0) {
      Write-Step "desktop installer build failed once (exit=$buildExitCode), retrying..."
      Start-Sleep -Seconds 2
      $buildExitCode = Invoke-TauriBundleBuild -ProjectDir $DeerpanelDir -TauriConfig $tauriConfig
    }
    if ($buildExitCode -ne 0) {
      throw "Desktop installer build failed with exit code: $buildExitCode (if ENOSPC, free C drive or keep building from D drive workspace)"
    }
  } finally {
    Pop-Location
  }
}

if (!(Test-Path $BundleDir)) {
  throw "Installer bundle directory not found: $BundleDir"
}

$installers = Get-ChildItem -Path $BundleDir -Filter "*.exe" -File | Sort-Object LastWriteTime -Descending
if (!$installers -or $installers.Count -eq 0) {
  throw "No NSIS installer exe found in: $BundleDir"
}

$latest = $installers[0]
if (-not $SkipBundleBuild -and $latest.LastWriteTime -lt $BuildStart) {
  throw "Installer build did not produce a fresh package. Latest found: $($latest.FullName)"
}
Write-Step "installer ready: $($latest.FullName)"
Write-Step "done"

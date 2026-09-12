param(
  [string]$InstallDir = "$env:LOCALAPPDATA\EvoPanel",
  [switch]$SkipBackendBuild,
  [switch]$SkipDesktopBuild,
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$msg) {
  Write-Host "[build-deploy] $msg"
}

function Ensure-Path([string]$path) {
  if (!(Test-Path $path)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
  }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DeerpanelDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $DeerpanelDir "..")).Path
$BackendBuildScript = Join-Path $RepoRoot "backend\packaging\windows\build-gateway-exe.ps1"
$BackendOutputDir = Join-Path $DeerpanelDir "src-tauri\binaries\evoflow-gateway"
$ReleaseExe = Join-Path $DeerpanelDir "src-tauri\target\release\evoflow.exe"
$InstallExe = Join-Path $InstallDir "evoflow.exe"
$InstallBackendDir = Join-Path $InstallDir "binaries\evoflow-gateway"
$OldBackendDir = Join-Path $DeerpanelDir "src-tauri\binaries\backend-gateway-v2"
$OldRenamedV2Dir = Join-Path $DeerpanelDir "src-tauri\binaries\evoflow-gateway-v2"

Write-Step "repo root: $RepoRoot"
Write-Step "install dir: $InstallDir"

Write-Step "stopping running processes (desktop tree first, then gateway leftovers)"
# runtime pack: desktop owns one stdio gateway child — kill parent /T first.
cmd /c "taskkill /F /T /IM evoflow.exe >nul 2>nul"
cmd /c "taskkill /F /T /IM evopanel.exe >nul 2>nul"
cmd /c "taskkill /F /T /IM EvoPanel.exe >nul 2>nul"
cmd /c "taskkill /F /T /IM evoflow-gateway.exe >nul 2>nul"
cmd /c "taskkill /F /T /IM backend-gateway.exe >nul 2>nul"

if (Test-Path $OldBackendDir) {
  Write-Step "removing old directory: $OldBackendDir"
  Remove-Item -Path $OldBackendDir -Recurse -Force -ErrorAction SilentlyContinue
}
if (Test-Path $OldRenamedV2Dir) {
  Write-Step "removing old directory: $OldRenamedV2Dir"
  Remove-Item -Path $OldRenamedV2Dir -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not $SkipBackendBuild) {
  Write-Step "building backend sidecar"
  # 同进程调用，避免嵌套 powershell.exe 时 -OutputPath 等参数未传入子脚本导致 Join-Path/GetFullPath 失败
  & $BackendBuildScript -OutputPath $BackendOutputDir
}

if (-not $SkipDesktopBuild) {
  Write-Step "building desktop executable"
  Push-Location $DeerpanelDir
  try {
    npm run tauri -- build --no-bundle
  } finally {
    Pop-Location
  }
}

if (!(Test-Path $ReleaseExe)) {
  throw "Desktop exe not found: $ReleaseExe"
}
if (!(Test-Path $BackendOutputDir)) {
  throw "Backend output dir not found: $BackendOutputDir"
}

Write-Step "deploying files to install dir"
Ensure-Path $InstallDir
Ensure-Path (Join-Path $InstallDir "binaries")
Copy-Item -Path $ReleaseExe -Destination $InstallExe -Force

robocopy $BackendOutputDir $InstallBackendDir /MIR | Out-Null
$robocopyCode = $LASTEXITCODE
if ($robocopyCode -gt 7) {
  throw "robocopy failed with code: $robocopyCode"
}

if (-not $NoLaunch) {
  Write-Step "launching app"
  Start-Process $InstallExe
  Start-Sleep -Seconds 3

  $runtimeState = Join-Path $env:USERPROFILE ".evoflow\evopanel\backend-runtime.json"
  $healthOk = $false
  $healthPort = 38012
  if (Test-Path $runtimeState) {
    try {
      $runtime = Get-Content $runtimeState -Raw | ConvertFrom-Json
      if ($runtime.port) {
        $healthPort = [int]$runtime.port
      }
    } catch {}
  }

  for ($i = 0; $i -lt 20; $i++) {
    try {
      $status = (Invoke-WebRequest -Uri "http://127.0.0.1:$healthPort/health" -UseBasicParsing -TimeoutSec 2).StatusCode
      if ($status -eq 200) {
        $healthOk = $true
        break
      }
    } catch {}
    Start-Sleep -Seconds 1
  }

  if ($healthOk) {
    Write-Step "gateway health check passed on port $healthPort"
  } else {
    Write-Step "gateway health check not ready yet (port $healthPort), check ~/.evoflow/logs"
  }
}

Write-Step "done"

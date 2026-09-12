param(
  [string]$OutputPath = "..\evopanel\src-tauri\binaries\evoflow-gateway",
  [string]$BuildTempRoot = "",
  [switch]$ForceAgentBrowserInstall,
  # Desktop Tauri already ships Vite UI via frontendDist. Opt-in only for
  # headless Gateway WebUI (same as macOS build, which never copies this).
  [switch]$IncludeEvopanelDist,
  # Enable PyArmor code obfuscation (requires: pip install pyarmor)
  [switch]$EnablePyArmor
)

$ErrorActionPreference = "Stop"

$ScriptDir = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$BackendDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir "..\.."))
if ([System.IO.Path]::IsPathRooted($OutputPath)) {
  $OutputAbs = [System.IO.Path]::GetFullPath($OutputPath)
} else {
  $OutputAbs = [System.IO.Path]::GetFullPath((Join-Path $BackendDir $OutputPath))
}
if ([string]::IsNullOrWhiteSpace($BuildTempRoot)) {
  $BuildTempRoot = Join-Path $BackendDir ".build-temp"
} else {
  $BuildTempRoot = [System.IO.Path]::GetFullPath($BuildTempRoot)
}
$VenvPython = Join-Path $BackendDir ".venv\Scripts\python.exe"

Write-Host "[gateway-build] backend dir: $BackendDir"
Write-Host "[gateway-build] output: $OutputAbs"
Write-Host "[gateway-build] build temp (TEMP/TMP/PyInstaller cache): $BuildTempRoot"

$tempDir = Join-Path $BuildTempRoot "temp"
$localAppData = Join-Path $BuildTempRoot "localappdata"
$pyiWork = Join-Path $BuildTempRoot "pyinstaller-work"
foreach ($d in @($BuildTempRoot, $tempDir, $localAppData, $pyiWork)) {
  New-Item -ItemType Directory -Path $d -Force | Out-Null
}

$oldTemp = $env:TEMP
$oldTmp = $env:TMP
$oldLocalAppData = $env:LOCALAPPDATA
$env:TEMP = $tempDir
$env:TMP = $tempDir
$env:LOCALAPPDATA = $localAppData

Push-Location $BackendDir
try {
  # Always scrub stale Chromium from the packaging cache before install/copy.
  # Historical builds accumulated multiple chrome-* trees (~400MB each).
  $AbBundlePre = Join-Path $BackendDir "packaging\agent-browser-bundle"
  $AbBrowsersPre = Join-Path $AbBundlePre "browsers"
  $keepChromiumEnv = $env:EVOFLOW_BUNDLE_CHROMIUM -and (
    $env:EVOFLOW_BUNDLE_CHROMIUM.Trim().ToLower() -in @("1", "true", "yes", "on")
  )
  if ((-not $keepChromiumEnv) -and (Test-Path -LiteralPath $AbBrowsersPre)) {
    Write-Host "[gateway-build] scrubbing stale packaging Chromium: $AbBrowsersPre"
    Remove-Item -Path $AbBrowsersPre -Recurse -Force
  }

  # Wipe previous PyInstaller dist so lean excludes cannot be shadowed by stale torch/.
  foreach ($stale in @(
      (Join-Path $BackendDir "dist\evoflow-gateway"),
      (Join-Path $BackendDir "dist\backend-gateway")
    )) {
    if (Test-Path -LiteralPath $stale) {
      Write-Host "[gateway-build] removing stale dist: $stale"
      Remove-Item -Path $stale -Recurse -Force
    }
  }

  $installArgs = @()
  if ($ForceAgentBrowserInstall) { $installArgs += "-Force" }
  try {
    & (Join-Path $ScriptDir "install-agent-browser-bundle.ps1") @installArgs
  } catch {
    Write-Host "[gateway-build] WARNING: agent-browser install failed: $($_.Exception.Message), continuing without it"
  }

  $rgInstallArgs = @()
  if ($ForceAgentBrowserInstall) { $rgInstallArgs += "-Force" }
  try {
    & (Join-Path $ScriptDir "install-ripgrep-bundle.ps1") @rgInstallArgs
  } catch {
    Write-Host "[gateway-build] WARNING: ripgrep install failed: $($_.Exception.Message), continuing without it"
  }

  # Build whisper ASR fallback (optional — skipped if openai-whisper not installed)
  try {
    $whisperPyi = Join-Path $BackendDir "whisper-dist"
    if (-not (Test-Path $whisperPyi)) {
      Write-Host "[gateway-build] Building whisper ASR..." -ForegroundColor Cyan
      & (Join-Path $ScriptDir "build-whisper.ps1")
    } else {
      Write-Host "[gateway-build] whisper-dist already exists, skip build"
    }
  } catch {
    Write-Host "[gateway-build] NOTE: whisper ASR skipped (pip install openai-whisper to include)" -ForegroundColor Yellow
  }

  # PyArmor code obfuscation (optional)
  $specFile = "packaging/windows/gateway.spec"
  if ($EnablePyArmor) {
    Write-Host "[gateway-build] PyArmor obfuscation enabled" -ForegroundColor Cyan
    $obfuscatedDir = Join-Path $BuildTempRoot "obfuscated"
    try {
      & (Join-Path $ScriptDir "obfuscate-with-pyarmor.ps1") -OutputDir $obfuscatedDir -Force
      # Use the obfuscated spec file
      $specFile = "packaging/windows/gateway-pyarmor.spec"
      Write-Host "[gateway-build] using obfuscated spec: $specFile" -ForegroundColor Green
    } catch {
      Write-Host "[gateway-build] WARNING: PyArmor obfuscation failed: $($_.Exception.Message)" -ForegroundColor Red
      Write-Host "[gateway-build] falling back to standard spec" -ForegroundColor Yellow
      $specFile = "packaging/windows/gateway.spec"
    }
  }

  $pyiArgs = @(
    "--noconfirm", "--clean",
    "--workpath", $pyiWork,
    "--distpath", (Join-Path $BackendDir "dist"),
    $specFile
  )
  if (Test-Path -LiteralPath $VenvPython) {
    & $VenvPython -m PyInstaller @pyiArgs
  } else {
    uv run pyinstaller @pyiArgs
  }
  if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed with exit code: $LASTEXITCODE"
  }

  $DistCandidates = @(
    (Join-Path $BackendDir "dist\evoflow-gateway"),
    (Join-Path $BackendDir "dist\backend-gateway")
  )
  $DistDir = $DistCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $DistDir) {
    throw "PyInstaller output not found. Checked: $($DistCandidates -join ', ')"
  }

  if (Test-Path $OutputAbs) {
    Remove-Item -Path $OutputAbs -Recurse -Force
  }
  New-Item -ItemType Directory -Path $OutputAbs -Force | Out-Null

  Copy-Item -Path (Join-Path $DistDir "*") -Destination $OutputAbs -Recurse -Force

  $AbBundle = Join-Path $BackendDir "packaging\agent-browser-bundle"
  $AbTarget = Join-Path $OutputAbs "tools\agent-browser"
  if (Test-Path $AbBundle) {
    if (Test-Path $AbTarget) {
      Remove-Item -Path $AbTarget -Recurse -Force
    }
    New-Item -ItemType Directory -Path (Split-Path $AbTarget -Parent) -Force | Out-Null
    # Never copy browsers/ into the lean sidecar (exclude at copy time).
    $keepChromium = $env:EVOFLOW_BUNDLE_CHROMIUM -and (
      $env:EVOFLOW_BUNDLE_CHROMIUM.Trim().ToLower() -in @("1", "true", "yes", "on")
    )
    if ($keepChromium) {
      Copy-Item -Path $AbBundle -Destination $AbTarget -Recurse -Force
      # Keep only the newest chrome-* to avoid multi-version bloat (~400MB each).
      $AbBrowsers = Join-Path $AbTarget "browsers"
      if (Test-Path -LiteralPath $AbBrowsers) {
        $chromeDirs = @(Get-ChildItem -LiteralPath $AbBrowsers -Directory -Filter "chrome-*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
        if ($chromeDirs.Count -gt 1) {
          $keep = $chromeDirs[0]
          foreach ($d in $chromeDirs | Select-Object -Skip 1) {
            Write-Host "[gateway-build] dropping older Chromium tree: $($d.Name)"
            Remove-Item -LiteralPath $d.FullName -Recurse -Force
          }
          Write-Host "[gateway-build] kept Chromium: $($keep.Name)"
        }
      }
    } else {
      New-Item -ItemType Directory -Path $AbTarget -Force | Out-Null
      Get-ChildItem -LiteralPath $AbBundle -Force | Where-Object { $_.Name -ne "browsers" } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $AbTarget $_.Name) -Recurse -Force
      }
      Write-Host "[gateway-build] bundled agent-browser CLI only (Chromium excluded)"
    }
    Write-Host "[gateway-build] bundled agent-browser -> $AbTarget"
  } else {
    Write-Host "[gateway-build] agent-browser bundle missing, skip: $AbBundle"
  }

  $RgBundle = Join-Path $BackendDir "packaging\ripgrep-bundle\win-x64"
  $RgTarget = Join-Path $OutputAbs "tools\ripgrep"
  $RgExe = Join-Path $RgBundle "rg.exe"
  if (Test-Path -LiteralPath $RgExe) {
    if (Test-Path $RgTarget) {
      Remove-Item -Path $RgTarget -Recurse -Force
    }
    New-Item -ItemType Directory -Path $RgTarget -Force | Out-Null
    Copy-Item -LiteralPath $RgExe -Destination (Join-Path $RgTarget "rg.exe") -Force
    $RgLicense = Join-Path $RgBundle "COPYING"
    if (Test-Path -LiteralPath $RgLicense) {
      Copy-Item -LiteralPath $RgLicense -Destination (Join-Path $RgTarget "COPYING") -Force
    }
    Write-Host "[gateway-build] bundled ripgrep -> $RgTarget"
  } else {
    Write-Host "[gateway-build] ripgrep bundle missing, skip: $RgBundle"
  }

  $CliTarget = Join-Path $OutputAbs "tools\evoflow"
  New-Item -ItemType Directory -Path $CliTarget -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $ScriptDir "..\scripts\evoflow.cmd") -Destination (Join-Path $CliTarget "evoflow.cmd") -Force
  Write-Host "[gateway-build] bundled evoflow CLI -> $CliTarget"

  $SkillsRoot = Join-Path ([System.IO.Path]::GetFullPath((Split-Path -Parent $BackendDir))) "skills"
  $PublicSkills = Join-Path $SkillsRoot "public"
  $SkillsTarget = Join-Path $OutputAbs "skills"
  if (Test-Path $PublicSkills) {
    if (Test-Path $SkillsTarget) {
      Remove-Item -Path $SkillsTarget -Recurse -Force
    }
    New-Item -ItemType Directory -Path $SkillsTarget -Force | Out-Null
    $PublicTarget = Join-Path $SkillsTarget "public"
    Copy-Item -Path $PublicSkills -Destination $PublicTarget -Recurse -Force
    Write-Host "[gateway-build] bundled skills/public only (excluded custom): $PublicTarget"
    $PruneScript = Join-Path $ScriptDir "..\scripts\prune-bundled-skills.ps1"
    . $PruneScript
    Remove-BundledSkillBloat -SkillsPublicDir $PublicTarget
  } else {
    Write-Host "[gateway-build] skills/public not found, skip bundling: $PublicSkills"
  }

  # Bundle whisper ASR fallback
  $WhisperDist = Join-Path $BackendDir "whisper-dist"
  $WhisperTarget = Join-Path $OutputAbs "tools\whisper"
  if (Test-Path (Join-Path $WhisperDist "whisper_server.exe")) {
    if (Test-Path $WhisperTarget) { Remove-Item -Path $WhisperTarget -Recurse -Force }
    New-Item -ItemType Directory -Path $WhisperTarget -Force | Out-Null
    Copy-Item -Path (Join-Path $WhisperDist "*") -Destination $WhisperTarget -Recurse -Force
    Write-Host "[gateway-build] bundled whisper ASR -> $WhisperTarget"
  } else {
    Write-Host "[gateway-build] whisper ASR not built, skip (run build-whisper.ps1 first)" -ForegroundColor Yellow
  }

  # Do not duplicate Vite UI inside the sidecar by default (Tauri frontendDist already ships it).
  # Headless Gateway WebUI: pass -IncludeEvopanelDist or set EVOFLOW_EVOPANEL_DIST at runtime.
  if ($IncludeEvopanelDist) {
    $EvopanelDist = Join-Path ([System.IO.Path]::GetFullPath((Join-Path $BackendDir ".."))) "evopanel\dist"
    $EvopanelTarget = Join-Path $OutputAbs "evopanel-dist"
    if (Test-Path (Join-Path $EvopanelDist "index.html")) {
      if (Test-Path $EvopanelTarget) {
        Remove-Item -Path $EvopanelTarget -Recurse -Force
      }
      Copy-Item -Path $EvopanelDist -Destination $EvopanelTarget -Recurse -Force
      Write-Host "[gateway-build] bundled evopanel dist -> $EvopanelTarget"
    } else {
      Write-Host "[gateway-build] -IncludeEvopanelDist set but dist missing: $EvopanelDist" -ForegroundColor Yellow
    }
  } else {
    Write-Host "[gateway-build] skip evopanel-dist (Tauri UI / set -IncludeEvopanelDist for headless WebUI)"
  }

  # Hard gate: refuse to ship fat Chromium/torch in the default desktop sidecar.
  & (Join-Path $ScriptDir "assert-lean-gateway-bundle.ps1") -GatewayDir $OutputAbs

  # native-style pin: desktop CARGO_PKG_VERSION must match this at startup.
  & (Join-Path $ScriptDir "write-sidecar-manifest.ps1") -GatewayDir $OutputAbs

  Write-Host "[gateway-build] done"
}
finally {
  Pop-Location
  $env:TEMP = $oldTemp
  $env:TMP = $oldTmp
  $env:LOCALAPPDATA = $oldLocalAppData
}

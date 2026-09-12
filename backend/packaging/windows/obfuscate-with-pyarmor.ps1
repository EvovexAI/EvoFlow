param(
  [string]$OutputDir = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$ScriptDir = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$BackendDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir "..\.."))
$HarnessDir = [System.IO.Path]::GetFullPath((Join-Path $BackendDir "packages\harness"))

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $BackendDir ".build-temp\obfuscated"
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)

$VenvPython = Join-Path $BackendDir ".venv\Scripts\python.exe"

Write-Host "[pyarmor] backend dir: $BackendDir"
Write-Host "[pyarmor] output: $OutputDir"

# Check if PyArmor is installed
$pyarmorCmd = $null
if (Test-Path -LiteralPath $VenvPython) {
  try {
    & $VenvPython -m pyarmor --version 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $pyarmorCmd = @($VenvPython, "-m", "pyarmor")
    }
  } catch {}
}
if (-not $pyarmorCmd) {
  try {
    & pyarmor --version 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $pyarmorCmd = @("pyarmor")
    }
  } catch {}
}
if (-not $pyarmorCmd) {
  Write-Host "[pyarmor] PyArmor not found. Install with: pip install pyarmor" -ForegroundColor Red
  throw "PyArmor not installed"
}

Write-Host "[pyarmor] using: $($pyarmorCmd -join ' ')"

# Clean output if exists
if (Test-Path $OutputDir) {
  if ($Force) {
    Remove-Item -Path $OutputDir -Recurse -Force
  } else {
    Write-Host "[pyarmor] output exists, use -Force to overwrite" -ForegroundColor Yellow
    return
  }
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

Push-Location $BackendDir
try {
  # Obfuscate main app package
  Write-Host "[pyarmor] obfuscating app package..." -ForegroundColor Cyan
  & $pyarmorCmd[0] @($pyarmorCmd[1..($pyarmorCmd.Count-1)]) obfuscate `
    --recursive `
    --output $OutputDir `
    --exclude "tests" `
    app/gateway/gateway_entry.py
  
  if ($LASTEXITCODE -ne 0) {
    throw "PyArmor obfuscate failed for app package"
  }

  # Obfuscate evoflow harness package
  Write-Host "[pyarmor] obfuscating evoflow package..." -ForegroundColor Cyan
  Push-Location $HarnessDir
  try {
    & $pyarmorCmd[0] @($pyarmorCmd[1..($pyarmorCmd.Count-1)]) obfuscate `
      --recursive `
      --output (Join-Path $OutputDir "evoflow") `
      --exclude "tests" `
      evoflow/__init__.py
    
    if ($LASTEXITCODE -ne 0) {
      throw "PyArmor obfuscate failed for evoflow package"
    }
  } finally {
    Pop-Location
  }

  Write-Host "[pyarmor] obfuscation complete: $OutputDir" -ForegroundColor Green
}
finally {
  Pop-Location
}

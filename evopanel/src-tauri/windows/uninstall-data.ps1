# EvoPanel：可选脚本，用于手动或自定义流程中清理本地数据（当前 NSIS 卸载钩子不再自动调用，避免无确认删盘）。
$ErrorActionPreference = 'SilentlyContinue'

$configPath = Join-Path $env:USERPROFILE '.evoflow\evopanel.json'
$customDataDir = $null
if (Test-Path -LiteralPath $configPath) {
  try {
    $c = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $root = [string]$c.userWorkspaceRoot
    if ($root -and $root.Trim().Length -gt 0) {
      $r0 = $root.Trim()
      $rNorm = $r0 -replace '\\', '/'
      $wsRoot = if ($rNorm.EndsWith('/workspace', [StringComparison]::OrdinalIgnoreCase)) {
        $r0.TrimEnd('\', '/')
      } else {
        Join-Path $r0 'workspace'
      }
      $customDataDir = Join-Path $wsRoot 'data'
    }
  } catch {
    # ignore
  }
}

if ($customDataDir -and (Test-Path -LiteralPath $customDataDir)) {
  Remove-Item -LiteralPath $customDataDir -Recurse -Force
}

$ef = Join-Path $env:USERPROFILE '.evoflow'
if (Test-Path -LiteralPath $ef) {
  Remove-Item -LiteralPath $ef -Recurse -Force
}

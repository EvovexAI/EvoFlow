# EvoPanel NSIS POSTINSTALL：合并写入 ~/.evoflow/evopanel.json；可选将 bundled CLI 目录加入用户 PATH。
# 可选 -UserWorkspaceRoot（安装器现默认不传，使用应用默认用户目录；与「设置 → 用户工作空间」一致）
# -InstallDir：安装根目录（$INSTDIR）
# -AddToPath：仅当安装向导勾选「将 evoflow CLI 添加到 PATH」时传入
param(
  [Parameter(Mandatory = $false)]
  [string] $UserWorkspaceRoot = '',
  [Parameter(Mandatory = $false)]
  [string] $InstallDir = '',
  [Parameter(Mandatory = $false)]
  [switch] $AddToPath
)
$ErrorActionPreference = 'Stop'

$dir = Join-Path $env:USERPROFILE '.evoflow'
$null = New-Item -ItemType Directory -Force -Path $dir
$path = Join-Path $dir 'evopanel.json'

$j = [ordered]@{}
if (Test-Path -LiteralPath $path) {
  try {
    $existing = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $existing.PSObject.Properties) {
      $j[$p.Name] = $p.Value
    }
  } catch {
    # 损坏时仍尝试写入新键
  }
}

$u = $UserWorkspaceRoot.Trim()
if ($u.Length -gt 0) {
  $j['userWorkspaceRoot'] = ($u -replace '\\', '/')
} else {
  if ($j.Contains('userWorkspaceRoot')) {
    $j.Remove('userWorkspaceRoot')
  }
}

$json = ($j | ConvertTo-Json -Depth 40) + "`n"
[System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))

# Add bundled admin CLI (evoflow.cmd → evoflow-gateway.exe --mode cli) to user PATH.
# Do NOT add $InstallDir itself: that contains evoflow.exe (desktop GUI), which would
# shadow the CLI when both are named "evoflow".
function Add-UserPathEntry([string] $Entry) {
  if (-not $Entry -or -not (Test-Path -LiteralPath $Entry)) { return }
  $norm = [System.IO.Path]::GetFullPath($Entry).TrimEnd('\')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($null -eq $userPath) { $userPath = '' }
  $parts = @($userPath -split ';' | Where-Object { $_ -and $_.Trim().Length -gt 0 })
  foreach ($p in $parts) {
    try {
      if ([System.IO.Path]::GetFullPath($p.TrimEnd('\')).Equals($norm, [StringComparison]::OrdinalIgnoreCase)) {
        return
      }
    } catch {
      # ignore bad PATH entries
    }
  }
  $newPath = if ($userPath.Trim().Length -eq 0) { $norm } else { "$norm;$userPath" }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  $env:Path = "$norm;$env:Path"
}

if ($AddToPath) {
  $inst = $InstallDir.Trim().TrimEnd('\', '/')
  if ($inst.Length -gt 0) {
    $cliDir = Join-Path $inst 'binaries\evoflow-gateway\tools\evoflow'
    Add-UserPathEntry $cliDir
  }
}

# -*- keep-utf8 -*-
# 实时尾随 EvoFlow 后端运行日志(桌面 pack 模式下 Gateway 是 Tauri 无窗口子进程,
# 运行时日志只落文件;本脚本把它接到一个可看的控制台窗口)。
#
# 用法:
#   tail-logs.ps1                     # 新开窗口尾随最新 gateway 日志(Python logging,含 langgraph_api)
#   tail-logs.ps1 -Here               # 在当前终端尾随(不新开窗口)
#   tail-logs.ps1 -Prefix evoflow-gateway   # 尾随 sidecar stderr(启动横幅/崩溃栈)
#   tail-logs.ps1 -All                # 每类日志各开一个窗口
#   tail-logs.ps1 -ResolveOnly        # 只打印选中的日志目录和文件,不尾随
#
# 日志目录解析(候选全部参与,"有最新 gateway-*.log"者获胜):
#   -LogsDir 参数 > EVOFLOW_LOGS_DIR(Tauri sidecar 用)
#   > ~/.evoflow-dev/logs(Tauri dev 诊断/sidecar stderr)
#   > ~/.evoflow-dev/data/logs(Gateway 文件日志,EVOFLOW_HOME=data 目录)
#   > ~/.evoflow/logs、~/.evoflow/data/logs(安装版)
#   > <仓库>/logs(serve.sh / uvicorn 直启)
param(
    [string] $LogsDir = "",
    [ValidateSet("gateway", "evoflow-gateway", "langgraph", "all")]
    [string] $Prefix = "gateway",
    [int] $Tail = 120,
    [switch] $All,
    [switch] $Here,
    [switch] $ResolveOnly
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Get-CandidateLogDirs {
    $list = @()
    if ($LogsDir -and $LogsDir.Trim()) { $list += $LogsDir.Trim() }
    $envLd = "$env:EVOFLOW_LOGS_DIR"
    if ($envLd -and $envLd.Trim()) { $list += $envLd.Trim() }
    foreach ($base in @((Join-Path $HOME ".evoflow-dev"), (Join-Path $HOME ".evoflow"))) {
        $list += (Join-Path $base "logs")
        $list += (Join-Path $base "data\logs")
    }
    $list += (Join-Path $RepoRoot "logs")
    return @($list | Select-Object -Unique)
}

function Find-NewestLog {
    param([string] $Dir, [string] $NamePrefix)
    if (-not (Test-Path -LiteralPath $Dir)) { return $null }
    $today = Get-Date -Format "yyyy-MM-dd"
    $todayFile = Join-Path $Dir ("{0}-{1}.log" -f $NamePrefix, $today)
    if (Test-Path -LiteralPath $todayFile) { return (Get-Item -LiteralPath $todayFile) }
    # 只认 <prefix>-YYYY-MM-DD.log,排除 gateway-startup.log 这类非日期命名。
    return @(Get-ChildItem -LiteralPath $Dir -Filter ($NamePrefix + "-*.log") -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match ("^" + $NamePrefix + "-\d{4}-\d{2}-\d{2}\.log$") } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1)[0]
}

# 选目录:优先"有最新 gateway-*.log"的那个(桌面 pack 与 serve.sh 两种落点自动二选一)。
$candidates = Get-CandidateLogDirs
$chosen = $null
$best = $null
foreach ($dir in $candidates) {
    $newest = Find-NewestLog -Dir $dir -NamePrefix "gateway"
    if ($newest -and (-not $best -or $newest.LastWriteTime -gt $best.LastWriteTime)) {
        $best = $newest
        $chosen = $dir
    }
}
if (-not $chosen) {
    foreach ($dir in $candidates) {
        if (Test-Path -LiteralPath $dir) { $chosen = $dir; break }
    }
}
if (-not $chosen) { $chosen = $candidates[-1] }
New-Item -ItemType Directory -Force -Path $chosen | Out-Null

$prefixes = @()
if ($All) { $prefixes = @("gateway", "evoflow-gateway", "langgraph") } else { $prefixes = @($Prefix) }

# 每个前缀独立跨全部候选目录取最新文件(不同前缀可能落在不同目录:
# gateway-*.log 在 data\logs,evoflow-gateway-*.log 在 Tauri 的 logs\)。
$targets = @()
foreach ($p in $prefixes) {
    $newest = $null
    foreach ($dir in $candidates) {
        $f = Find-NewestLog -Dir $dir -NamePrefix $p
        if ($f -and (-not $newest -or $f.LastWriteTime -gt $newest.LastWriteTime)) { $newest = $f }
    }
    if ($newest) { $targets += $newest }
}
$targets = @($targets | Sort-Object FullName -Unique)

Write-Host ""
Write-Host "[tail-logs] 日志目录: $chosen" -ForegroundColor Cyan
if (-not $targets) {
    Write-Host "[tail-logs] 未找到可尾随的日志文件(前缀: $($prefixes -join ', '))。" -ForegroundColor Yellow
    Write-Host "[tail-logs] 服务启动后会生成 gateway-YYYY-MM-DD.log;也可换 -Prefix 或 -All 重试。" -ForegroundColor Yellow
    if ($ResolveOnly) { return }
    exit 1
}

foreach ($f in $targets) {
    $age = [int]((Get-Date) - $f.LastWriteTime).TotalSeconds
    Write-Host ("[tail-logs] 尾随: {0}  (最后写入 {1:s}, {2}s 前, {3:N0} KB)" -f $f.Name, $f.LastWriteTime, $age, ($f.Length / 1KB)) -ForegroundColor DarkGray
}
Write-Host "[tail-logs] 提示: 日志按天滚动,跨天后重跑本脚本即可跟到新文件;Ctrl+C 退出。" -ForegroundColor DarkGray

if ($ResolveOnly) { return }

function Start-TailWindow {
    param([System.IO.FileInfo] $File)
    $title = "EvoFlow 日志尾随 - $($File.Name)"
    # 文件名不含单引号(日期+前缀),单引号包裹字面量安全;转义 PowerShell 内层引号用反引号。
    $inner = "chcp 65001 > `$null; " +
        "`$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); " +
        "`$Host.UI.RawUI.WindowTitle = '$title'; " +
        "Write-Host ''; " +
        "Write-Host '== 尾随 $($File.FullName) ==' -ForegroundColor Cyan; " +
        "Write-Host '== 按天滚动,跨天后重跑 scripts\windows\tail-logs.ps1 ==' -ForegroundColor DarkGray; " +
        "Write-Host ''; " +
        "Get-Content -LiteralPath '$($File.FullName)' -Wait -Tail $Tail -Encoding UTF8"
    Start-Process powershell.exe -ArgumentList @(
        "-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $inner
    ) -WindowStyle Normal | Out-Null
}

if ($Here) {
    foreach ($f in $targets) {
        Write-Host ""
        Write-Host "== 尾随 $($f.FullName) ==" -ForegroundColor Cyan
        Get-Content -LiteralPath $f.FullName -Wait -Tail $Tail -Encoding UTF8
    }
} else {
    foreach ($f in $targets) {
        Start-TailWindow -File $f
        Write-Host "[tail-logs] 已打开日志窗口: $($f.Name)" -ForegroundColor Green
    }
}

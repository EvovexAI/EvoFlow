# Supervises operator-owned Gateway (uvicorn on EVOFLOW_GATEWAY_PORT, default 8070).
# Root-cause aid for「连接极不稳定」: every exit is logged with exit code + timestamp,
# then the process is restarted. Pair with desktop EVOFLOW_GATEWAY_URL.
#
# 死亡取证（2026-10-27）：exitCode=-1 无 Python 栈 = 被 Stop-Process/TaskKill 强杀。
# 每次异常退出自动拍「死亡现场快照」（竞争网关进程 / taskkill / 端口双绑定监听者），
# 运行期每 60s 记录进程树 RSS（验证 OOM 假设）。grep ``[gateway-supervisor]``。
#
# Grep: ``[gateway-supervisor]``
# Log:  ``%USERPROFILE%\.evoflow-dev\logs\gateway-supervisor.log``
#       plus backend ``evoflow-gateway-*.log`` / ``[GATEWAY-EXIT]`` lines.
#
# Usage:
#   .\scripts\windows\watch-external-gateway.ps1
#   .\scripts\windows\watch-external-gateway.ps1 -Port 8070 -RestartDelaySec 3
#   # Then launch desktop with:
#   #   $env:EVOFLOW_GATEWAY_URL='http://127.0.0.1:8070'

param(
    [int] $Port = 0,
    [int] $RestartDelaySec = 3,
    [switch] $NoRestart
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $PSScriptRoot "backend-common.ps1")
Initialize-EvoFlowBackendPaths -RepoRoot $RepoRoot

if ($Port -le 0) {
    if ($env:EVOFLOW_GATEWAY_PORT -and $env:EVOFLOW_GATEWAY_PORT.Trim()) {
        [void][int]::TryParse($env:EVOFLOW_GATEWAY_PORT.Trim(), [ref]$Port)
    }
}
if ($Port -le 0) { $Port = 8070 }

$logDir = Join-Path $env:USERPROFILE ".evoflow-dev\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$supervisorLog = Join-Path $logDir "gateway-supervisor.log"
$pidFile = Join-Path $logDir "gateway-8070.pid"
if ($Port -ne 8070) {
    $pidFile = Join-Path $logDir ("gateway-{0}.pid" -f $Port)
}

function Write-SupervisorLog {
    param([string] $Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
    $line = "[$ts] [gateway-supervisor] $Message"
    Add-Content -LiteralPath $supervisorLog -Value $line -Encoding UTF8
    Write-Host $line
}

# 死亡现场快照：异常退出瞬间，抓出所有竞争网关/击杀进程与端口双绑定监听者。
# 背景：exitCode=-1 是外部 Stop-Process 强杀；07:27 曾出现 gen2 死后 5 秒另一
# 进程（0.0.0.0 双绑定）占住 8070 —— 不拍快照就永远抓不到竞争者。
function Write-DeathScene {
    param([int] $Port)
    try {
        Write-SupervisorLog "death-scene: capturing competing gateway processes"
        $pat = 'uvicorn|app\.gateway\.app|gateway_entry|evoflow-gateway|taskkill|Stop-Process|watch-external-gateway|dev-stack|restart-dev-stack|langgraph'
        $now = Get-Date
        foreach ($proc in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
            if (-not $proc.CommandLine -or $proc.CommandLine -notmatch $pat) { continue }
            $ageSec = -1
            try { $ageSec = [int]($now - $proc.CreationDate).TotalSeconds } catch { }
            $cmd = ($proc.CommandLine -replace '\s+', ' ')
            if ($cmd.Length -gt 200) { $cmd = $cmd.Substring(0, 200) }
            Write-SupervisorLog ("  proc pid={0} ppid={1} name={2} age_s={3} cmd={4}" -f `
                $proc.ProcessId, $proc.ParentProcessId, $proc.Name, $ageSec, $cmd)
        }
        foreach ($c in @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
            Write-SupervisorLog ("  listener port={0} pid={1}" -f $Port, $c.OwningProcess)
        }
        Write-SupervisorLog "death-scene: done"
    } catch {
        Write-SupervisorLog "death-scene capture failed: $_"
    }
}

$pyExe = Join-Path $script:DFBackendDir ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $pyExe)) {
    throw "Python venv not found: $pyExe"
}

Write-SupervisorLog "begin port=$Port repo=$RepoRoot py=$pyExe restart=$(-not $NoRestart)"
Write-Host ""
Write-Host "Gateway supervisor watching :$Port" -ForegroundColor Cyan
Write-Host "  Log: $supervisorLog" -ForegroundColor DarkGray
Write-Host "  Set desktop: EVOFLOW_GATEWAY_URL=http://127.0.0.1:$Port" -ForegroundColor DarkYellow
Write-Host "  Ctrl+C to stop supervisor (and current uvicorn)." -ForegroundColor DarkGray
Write-Host ""

$generation = 0
while ($true) {
    $generation += 1
    # Free port if a zombie holds it
    try {
        $listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
        foreach ($c in @($listeners)) {
            $opid = [int]$c.OwningProcess
            if ($opid -gt 0) {
                Write-SupervisorLog "killing stale listener pid=$opid on port=$Port"
                Stop-Process -Id $opid -Force -ErrorAction SilentlyContinue
            }
        }
    } catch { }

    $env:EVOFLOW_GATEWAY_URL = "http://127.0.0.1:$Port"
    $env:EVOFLOW_GATEWAY_PORT = [string]$Port
    $env:PYTHONUTF8 = "1"
    $env:PYTHONIOENCODING = "utf-8"
    $env:PYTHONUNBUFFERED = "1"
    $env:PYTHONPATH = "$($script:DFBackendDir);$($script:DFBackendDir)\packages\harness"

    $day = Get-Date -Format "yyyyMMdd"
    $outLog = Join-Path $logDir ("gateway-supervisor-uvicorn-{0}.out.log" -f $day)
    $errLog = Join-Path $logDir ("gateway-supervisor-uvicorn-{0}.err.log" -f $day)
    Write-SupervisorLog "spawn gen=$generation uvicorn port=$Port out=$outLog err=$errLog"

    $p = Start-Process -FilePath $pyExe `
        -ArgumentList @("-u", "-m", "uvicorn", "app.gateway.app:app", "--host", "127.0.0.1", "--port", "$Port") `
        -WorkingDirectory $script:DFBackendDir `
        -PassThru `
        -NoNewWindow `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog

    Set-Content -LiteralPath $pidFile -Value "$($p.Id)" -Encoding ASCII
    Write-SupervisorLog "running gen=$generation pid=$($p.Id)"

    # 等退出 + 每 60s 采样进程树 RSS（venv shim 是父进程，真身是子 python —— 记树总值验证 OOM 假设）
    while ($true) {
        Wait-Process -Id $p.Id -Timeout 60 -ErrorAction SilentlyContinue
        if ($p.HasExited) { break }
        try {
            $tree = @(Get-Process -Id $p.Id -ErrorAction SilentlyContinue)
            $tree += @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" -ErrorAction SilentlyContinue |
                ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
            $rssMb = ($tree | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB
            Write-SupervisorLog ("rss gen={0} root={1} tree_mb={2:N0}" -f $generation, $p.Id, $rssMb)
        } catch { }
    }
    $code = $p.ExitCode
    if ($null -eq $code) { $code = -1 }
    Write-SupervisorLog "exit gen=$generation pid=$($p.Id) exitCode=$code — check evoflow-gateway-*.log for [GATEWAY-EXIT]"
    if ($code -ne 0) {
        # 非优雅退出（-1 = 外部强杀）才拍现场；优雅 [GATEWAY-EXIT] 无需竞争快照。
        Write-DeathScene -Port $Port
    }

    if ($NoRestart) {
        Write-SupervisorLog "NoRestart set; supervisor exiting"
        break
    }
    Write-SupervisorLog "restart in ${RestartDelaySec}s"
    Start-Sleep -Seconds $RestartDelaySec
}

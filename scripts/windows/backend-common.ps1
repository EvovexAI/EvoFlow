# Shared helpers for EvoFlow backend (Gateway with LangGraph in-process) on Windows.
# Keep this file as UTF-8 with BOM; Windows PowerShell 5.1 mis-parses it if the BOM is stripped.
# Port roles in this repo:
#   1420 — Tauri 桌面开发时加载的前端地址 (evopanel/src-tauri/tauri.conf.json devUrl)，即「桌面 Web」入口
#   1421 — Vite 默认端口 (evopanel/vite.config.js)；strictPort=false 时可能被占用后顺延到 1422、1423…
#   8012 — FastAPI Gateway (REST/SSE 等 /api，LangGraph 内嵌在同一个进程)

function Initialize-EvoFlowBackendPaths {
    param(
        [Parameter(Mandatory = $true)]
        [string] $RepoRoot
    )
    $script:DFRepoRoot = (Resolve-Path $RepoRoot).Path
    $script:DFBackendDir = Join-Path $script:DFRepoRoot "backend"
    $script:DFLogsDir = Join-Path $script:DFRepoRoot "logs"
    $script:DFTempDir = Join-Path $script:DFRepoRoot "temp"
    $script:DFBackendConsolePidFile = Join-Path $script:DFTempDir "evoflow-backend-console-pids.txt"
    $script:DFBackendLastStartStateFile = Join-Path $script:DFTempDir "evoflow-backend-last-start.json"
    $gatewayPort = 8012
    if ($env:EVOFLOW_GATEWAY_PORT) {
        $tmp = 0
        if ([int]::TryParse($env:EVOFLOW_GATEWAY_PORT.Trim(), [ref]$tmp) -and $tmp -gt 0 -and $tmp -lt 65536) {
            $gatewayPort = $tmp
        }
    }
    $script:DFGatewayPort = $gatewayPort
    $webPorts = @(1420, 1421)
    $wdpRaw = $env:EVOFLOW_WEB_DEV_PORTS
    if (-not [string]::IsNullOrWhiteSpace($wdpRaw)) {
        $parsedPorts = New-Object System.Collections.Generic.List[int]
        foreach ($part in $wdpRaw.Split(',')) {
            $t = $part.Trim()
            if ($t.Length -eq 0) { continue }
            $wp = 0
            if ([int]::TryParse($t, [ref]$wp) -and $wp -gt 0 -and $wp -lt 65536) {
                [void]$parsedPorts.Add($wp)
            }
        }
        if ($parsedPorts.Count -gt 0) {
            $webPorts = @($parsedPorts)
        }
    }
    $script:DFEvoPanelWebPorts = $webPorts
    New-Item -ItemType Directory -Force -Path $script:DFTempDir | Out-Null
}

function Test-EvoFlowPortFree {
    param([int]$Port)
    if ($Port -le 0) { return $false }
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        $listener.Stop()
        return $true
    } catch {
        return $false
    }
}

function Resolve-EvoFlowPort {
    param(
        [int]$Preferred,
        [int]$RangeStart,
        [int]$RangeEnd
    )
    if (Test-EvoFlowPortFree -Port $Preferred) {
        return $Preferred
    }
    for ($p = $RangeStart; $p -le $RangeEnd; $p++) {
        if (Test-EvoFlowPortFree -Port $p) {
            return $p
        }
    }
    throw "No free port available in range $RangeStart..$RangeEnd"
}

function Test-EvoFlowCommandExists {
    param([string] $Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Stop-EvoFlowProcessTree {
    <#
      结束指定 PID 及其**子进程**（taskkill /T 不包含父进程）。
      使用 cmd 包裹 taskkill，避免在 $ErrorActionPreference=Stop 的脚本里触发 NativeCommandError。
      先 Stop-Process 再 taskkill，部分环境下更稳。
    #>
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return }
    try {
        Get-Process -Id $ProcessId -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    } catch { }
    $null = cmd.exe /c "taskkill /T /F /PID $ProcessId >nul 2>&1"
}

function Get-EvoFlowListeningPidsMap {
    <#
      一次 netstat + 按端口 Get-NetTCPConnection，避免每个端口重复扫全表（否则 stop 会卡很久且无输出）。
    #>
    param([int[]]$PortList)
    $sets = @{}
    foreach ($pt in $PortList) {
        $sets[$pt] = @{}
    }
    try {
        foreach ($line in @(netstat -ano 2>$null)) {
            if ($line -notmatch '(?i)LISTENING\s+(\d+)\s*$') { continue }
            if ($line -notmatch '(?i)^\s*TCP\s') { continue }
            $pidVal = [int]$Matches[1]
            if ($pidVal -le 0) { continue }
            foreach ($pt in $PortList) {
                if ($line -match ":$pt\s") {
                    $sets[$pt][$pidVal] = $true
                }
            }
        }
    } catch { }
    foreach ($pt in $PortList) {
        try {
            foreach ($c in @(Get-NetTCPConnection -LocalPort $pt -ErrorAction SilentlyContinue)) {
                if ($c.State -ne 'Listen') { continue }
                $oid = [int]$c.OwningProcess
                if ($oid -gt 0) { $sets[$pt][$oid] = $true }
            }
        } catch { }
    }
    $out = @{}
    foreach ($pt in $PortList) {
        $out[$pt] = @($sets[$pt].Keys)
    }
    return $out
}

function Get-EvoFlowListeningPidsOnPort {
    param([int]$Port)
    $m = Get-EvoFlowListeningPidsMap -PortList @($Port)
    $arr = $m[$Port]
    if ($null -eq $arr) { return @() }
    return @($arr)
}

function Stop-EvoFlowKillPortListenerRoots {
    <#
      uvicorn --reload：真正 Listen 的往往是 worker，父进程是 reload 监视器；对 worker 做 taskkill /T
      杀不到父进程，端口会立刻被拉起。沿父链向上找到 start-backend 用的「隐藏 powershell + -Command ... uvicorn/langgraph」
      后整树结束；找不到则仍杀监听 PID 树。
    #>
    param([int]$ListenPid)
    if ($ListenPid -le 0) { return }
    $p = $ListenPid
    for ($i = 0; $i -le 20; $i++) {
        $row = @(Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue)[0]
        if (-not $row) {
            Stop-EvoFlowProcessTree -ProcessId $ListenPid
            return
        }
        $name = [string]$row.Name
        $cl = [string]$row.CommandLine
        if (($name -match '(?i)powershell|pwsh') -and ($cl -match '(?i)uvicorn|langgraph_cli')) {
            Stop-EvoFlowProcessTree -ProcessId $p
            return
        }
        # uvicorn --reload：监听常在子进程 python 上，父链中间是「python -m uvicorn …」而非 powershell
        if (($name -match '(?i)^python(?:w)?\.exe$') -and ($cl -match '(?i)app\.gateway\.app:app')) {
            Stop-EvoFlowProcessTree -ProcessId $p
            return
        }
        $pp = [int]$row.ParentProcessId
        if ($pp -le 0 -or $pp -eq $p) { break }
        $p = $pp
    }
    Stop-EvoFlowProcessTree -ProcessId $ListenPid
}

function Stop-EvoFlowPortProcess {
    param([int] $Port)
    try {
        foreach ($listenPid in @(Get-EvoFlowListeningPidsOnPort -Port $Port)) {
            if ($listenPid -and $listenPid -ne 0) {
                Stop-EvoFlowKillPortListenerRoots -ListenPid $listenPid
            }
        }
    } catch {
        # ignore
    }
}

function Stop-EvoFlowPortsSweep {
    <#
      多轮清扫：每轮只跑 1 次 netstat（按端口集合），避免重复全表扫描。
      每轮末尾再用 Get-NetTCPConnection 按端口取 OwningProcess（与 netstat 互补，避免漏掉同端口多 PID）。
    #>
    param(
        [int[]]$Ports,
        [int]$MaxRounds = 10
    )
    for ($r = 0; $r -lt $MaxRounds; $r++) {
        $map = Get-EvoFlowListeningPidsMap -PortList $Ports
        foreach ($port in $Ports) {
            foreach ($procId in @($map[$port])) {
                if ($procId -and $procId -ne 0) {
                    Stop-EvoFlowKillPortListenerRoots -ListenPid $procId
                }
            }
        }
        foreach ($port in $Ports) {
            try {
                $extra = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
                    ForEach-Object { [int]$_.OwningProcess } | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
                foreach ($procId in $extra) {
                    Stop-EvoFlowKillPortListenerRoots -ListenPid $procId
                }
            } catch { }
        }
        $map2 = Get-EvoFlowListeningPidsMap -PortList $Ports
        $still = $false
        foreach ($port in $Ports) {
            if (@($map2[$port]).Count -gt 0) {
                $still = $true
                break
            }
        }
        if (-not $still) { break }
        Start-Sleep -Milliseconds 200
    }
}

function Stop-EvoFlowBruteKillPortListeners {
    <#
      仅依赖 Get-NetTCPConnection，多轮杀 Listen 的 OwningProcess（reload 子进程反复拉起时用）。
    #>
    param(
        [int[]]$Ports,
        [int]$MaxRounds = 25,
        [int]$SleepMs = 300
    )
    for ($r = 0; $r -lt $MaxRounds; $r++) {
        $any = $false
        foreach ($port in $Ports) {
            try {
                $pids = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
                    ForEach-Object { [int]$_.OwningProcess } | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
                foreach ($procId in $pids) {
                    $any = $true
                    Stop-EvoFlowKillPortListenerRoots -ListenPid $procId
                }
            } catch { }
        }
        if (-not $any) { break }
        Start-Sleep -Milliseconds $SleepMs
    }
}

function Wait-EvoFlowPortsClosed {
    param(
        [int[]]$Ports,
        [int]$TimeoutSec = 8
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $m = Get-EvoFlowListeningPidsMap -PortList $Ports
        $open = $false
        foreach ($pt in $Ports) {
            if (@($m[$pt]).Count -gt 0) {
                $open = $true
                break
            }
        }
        if (-not $open) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return $false
}

function Wait-EvoFlowPortClosed {
    param(
        [int] $Port,
        [int] $TimeoutSec = 8
    )
    return Wait-EvoFlowPortsClosed -Ports @($Port) -TimeoutSec $TimeoutSec
}

function Wait-EvoFlowPortReady {
    param(
        [int] $Port,
        [int] $TimeoutSec = 60
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $ok = Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -WarningAction SilentlyContinue
            if ($ok.TcpTestSucceeded) {
                return $true
            }
        } catch {
            # ignore
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Stop-EvoFlowCimKillByCommandLineRegex {
    param(
        [string]$RegexPattern,
        [int]$MaxRounds = 3,
        [int]$CimTimeoutSec = 4
    )
    $procNames = @('python.exe', 'pythonw.exe', 'powershell.exe', 'pwsh.exe', 'node.exe')
    for ($r = 0; $r -lt $MaxRounds; $r++) {
        $hits = @()
        foreach ($pn in $procNames) {
            try {
                $matched = Get-CimInstance Win32_Process -Filter ("Name = '{0}'" -f $pn) -OperationTimeoutSec $CimTimeoutSec -ErrorAction SilentlyContinue |
                    Where-Object { $_.CommandLine -and ($_.CommandLine -match $RegexPattern) } |
                    Select-Object ProcessId, Name, CommandLine
                if ($matched) {
                    $hits += @($matched)
                }
            } catch { }
        }
        if (-not $hits -or $hits.Count -eq 0) { break }
        foreach ($p in $hits) {
            $id = [int]$p.ProcessId
            if ($id -gt 0) {
                Stop-EvoFlowProcessTree -ProcessId $id
            }
        }
        Start-Sleep -Milliseconds 250
    }
}

function Stop-EvoFlowAllGatewayUvicornProcesses {
    <#
      多次重启会在 8012 上堆积多个 uvicorn。含 --reload 时需配合端口清扫杀父进程。
      匹配「-m uvicorn … app.gateway.app:app」与「uvicorn 在前」两种命令行，避免 CIM 扫不到。
    #>
    $port = [int]$script:DFGatewayPort
    if ($port -le 0) { $port = 8012 }
    Stop-EvoFlowCimKillByCommandLineRegex -RegexPattern '(?i)app\.gateway\.app:app' -MaxRounds 8
    Stop-EvoFlowCimKillByCommandLineRegex -RegexPattern ('(?i)app\.gateway\.app:app.*--port\s*{0}\b' -f $port) -MaxRounds 5
}

function Stop-EvoFlowAllLangGraphCliProcesses {
    <#
      start-backend: python -m langgraph_cli dev（仅扫相关进程名，避免全表 CIM）。
    #>
    Stop-EvoFlowCimKillByCommandLineRegex -RegexPattern '-m\s+langgraph_cli\s+dev|langgraph_cli(\.exe)?\s+dev' -MaxRounds 6
}

function Stop-EvoFlowBackend {
    Write-Host ""
    Write-Host "==> Stopping backend: Gateway (:$script:DFGatewayPort, LangGraph in-process)" -ForegroundColor Yellow

    $pidFile = $script:DFBackendConsolePidFile
    $stateFile = $script:DFBackendLastStartStateFile
    $statePorts = @()
    $stateConsolePids = @()
    if (Test-Path -LiteralPath $stateFile) {
        try {
            $raw = Get-Content -LiteralPath $stateFile -Raw -ErrorAction SilentlyContinue
            if (-not [string]::IsNullOrWhiteSpace($raw)) {
                $st = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
                $gwp = 0
                $gpid = 0
                try { if ($st -and $st.ports -and $st.ports.gateway) { $gwp = [int]$st.ports.gateway } } catch { }
                if ($gwp -gt 0) { $statePorts += $gwp }
                try { if ($st -and $st.consolePids -and $st.consolePids.gateway) { $gpid = [int]$st.consolePids.gateway } } catch { }
                if ($gpid -gt 0) { $stateConsolePids += $gpid }
            }
        } catch {
            # ignore corrupted state file
        }
    }

    if ($stateConsolePids.Count -gt 0) {
        Write-Host "  Stopping console sessions from last-start state file..." -ForegroundColor DarkGray
        foreach ($consolePid in $stateConsolePids | Sort-Object -Unique) {
            Stop-EvoFlowProcessTree -ProcessId $consolePid
        }
    }
    if (Test-Path -LiteralPath $pidFile) {
        Write-Host "  Stopping console sessions from PID file (same as closing the two EvoFlow windows)..." -ForegroundColor DarkGray
        foreach ($line in @(Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue)) {
            if ($line -match '^\s*langgraph_ps_pid=(\d+)\s*$') {
                Stop-EvoFlowProcessTree -ProcessId ([int]$Matches[1])
            }
            elseif ($line -match '^\s*gateway_ps_pid=(\d+)\s*$') {
                Stop-EvoFlowProcessTree -ProcessId ([int]$Matches[1])
            }
        }
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "  No PID file (windows were closed already or old run)." -ForegroundColor DarkGray
    }
    # 无论是否读过 PID 文件都要做：taskkill 偶发未清干净、或 Gateway 是以前手动起的孤儿进程
    Write-Host "  Command-line sweep (python/pwsh: app.gateway uvicorn)..." -ForegroundColor DarkGray
    Stop-EvoFlowAllGatewayUvicornProcesses

    $portsToSweep = @($script:DFGatewayPort)
    foreach ($p in $statePorts) {
        if ($p -gt 0 -and ($portsToSweep -notcontains $p)) { $portsToSweep += $p }
    }
    if ($env:EVOFLOW_STOP_EXTRA_PORTS) {
        foreach ($part in $env:EVOFLOW_STOP_EXTRA_PORTS.Split(',')) {
            $px = 0
            if ([int]::TryParse($part.Trim(), [ref]$px) -and $px -gt 0) {
                if ($portsToSweep -notcontains $px) {
                    $portsToSweep += $px
                }
            }
        }
    }

    Write-Host "  Port sweep (orphans / old hidden runs): $($portsToSweep -join ', ')..." -ForegroundColor DarkGray
    Stop-EvoFlowPortsSweep -Ports $portsToSweep -MaxRounds 12
    $null = Wait-EvoFlowPortsClosed -Ports $portsToSweep -TimeoutSec 5

    $left = @()
    $finalMap = Get-EvoFlowListeningPidsMap -PortList $portsToSweep
    foreach ($p in $portsToSweep) {
        $rest = @($finalMap[$p])
        if ($rest.Count -gt 0) {
            $left += "port $p -> PID(s) $($rest -join ', ')"
        }
    }
    if ($left.Count -gt 0) {
        Write-Host "  Second pass: brute NetTCP listener cleanup (reload / stacked uvicorn)..." -ForegroundColor DarkGray
        Stop-EvoFlowBruteKillPortListeners -Ports $portsToSweep -MaxRounds 25 -SleepMs 300
        $null = Wait-EvoFlowPortsClosed -Ports $portsToSweep -TimeoutSec 6
        $left = @()
        $finalMap = Get-EvoFlowListeningPidsMap -PortList $portsToSweep
        foreach ($p in $portsToSweep) {
            $rest = @($finalMap[$p])
            if ($rest.Count -gt 0) {
                $left += "port $p -> PID(s) $($rest -join ', ')"
            }
        }
    }
    if ($left.Count -gt 0) {
        Write-Warning "Some listener PIDs remain (other apps or need Admin). Details:"
        foreach ($x in $left) {
            Write-Warning ('  {0}' -f $x)
        }
        Write-Host '    Tip: set env EVOFLOW_STOP_EXTRA_PORTS=2026 for extra ports (e.g. dev-api Gateway).' -ForegroundColor DarkYellow
    } else {
        Write-Host "    Done. Ports free (or were already free)." -ForegroundColor DarkGray
    }

    # State file is only for best-effort stop; keep it for postmortem unless explicitly cleaned by user.
}

function Read-EvoFlowInternalEventsSecret {
    $secret = $env:INTERNAL_EVENTS_SECRET
    if (-not [string]::IsNullOrWhiteSpace($secret)) {
        return $secret
    }
    foreach ($p in @(
            (Join-Path $script:DFBackendDir ".env"),
            (Join-Path $script:DFRepoRoot ".env")
        )) {
        if (-not (Test-Path $p)) { continue }
        $m = Select-String -Path $p -Pattern '^INTERNAL_EVENTS_SECRET\s*=' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) {
            return ($m.Line -split '=', 2)[1].Trim()
        }
    }
    return $null
}

function Read-EvoFlowNJobsPerWorker {
    $v = $env:N_JOBS_PER_WORKER
    if (-not [string]::IsNullOrWhiteSpace($v)) {
        return $v.Trim()
    }
    foreach ($p in @(
            (Join-Path $script:DFBackendDir ".env"),
            (Join-Path $script:DFRepoRoot ".env")
        )) {
        if (-not (Test-Path $p)) { continue }
        $m = Select-String -Path $p -Pattern '^\s*N_JOBS_PER_WORKER\s*=' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) {
            return ($m.Line -split '=', 2)[1].Trim()
        }
    }
    return "10"
}

function Resolve-EvoFlowDevDeerFlowHome {
    <#
      Auto-load EvoPanel's "用户工作空间" for local dev backend (8012/2024),
      so dev backend reads/writes the same data root as the desktop app.

      Priority:
        1) ~/.evoflow/evopanel.json userWorkspaceRoot -> <root>/data
           (EVOFLOW_HOME leaf; Python normalizes base_dir to <root>)
        2) EVOFLOW_HOME env (if user explicitly set it)
        3) $null (do not override)
    #>
    $fromEnv = $env:EVOFLOW_HOME
    if (-not [string]::IsNullOrWhiteSpace($fromEnv)) {
        return $fromEnv.Trim()
    }

    try {
        $panelCfg = Join-Path $HOME ".evoflow\evopanel.json"
        if (-not (Test-Path $panelCfg)) { return $null }

        $raw = Get-Content -LiteralPath $panelCfg -Raw -ErrorAction SilentlyContinue
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }

        $j = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
        $root = [string]$j.userWorkspaceRoot
        if ([string]::IsNullOrWhiteSpace($root)) { return $null }

        $root = $root.Trim().TrimEnd('\', '/')
        if ($root -match '(?i)[/\\]data$') {
            return $root
        }
        if ($root -match '(?i)[/\\]workspace[/\\]data$') {
            return $root
        }
        if ($root -match '(?i)[/\\]workspace$') {
            $parent = Split-Path -Parent $root
            if ($parent) {
                return (Join-Path $parent "data")
            }
        }
        return (Join-Path $root "data")
    } catch {
        return $null
    }
}

function Start-EvoFlowBackend {
    $pyExe = Join-Path $script:DFBackendDir ".venv\Scripts\python.exe"
    if (-not (Test-Path $pyExe)) {
        throw "Python venv not found: $pyExe (run: cd backend; uv sync)"
    }

    New-Item -ItemType Directory -Force -Path $script:DFLogsDir | Out-Null

    # 端口冲突时自动回退到同一开发端口段，避免与安装版/其他进程打架。
    $preferredGatewayPort = 8012
    try { $preferredGatewayPort = [int]$script:DFGatewayPort } catch { $preferredGatewayPort = 8012 }

    # Default dev cluster (8012–8035). Isolated stacks (e.g. dev-stack-isolated.bat: 8070)
    # fall back near EVOFLOW_GATEWAY_PORT.
    $gwLow = 8012
    $gwHigh = 8035
    if ($preferredGatewayPort -lt $gwLow -or $preferredGatewayPort -gt $gwHigh) {
        $gwLow = [Math]::Max(1024, $preferredGatewayPort)
        $gwHigh = [Math]::Min(65535, $preferredGatewayPort + 40)
    }

    $resolvedGatewayPort = Resolve-EvoFlowPort -Preferred $preferredGatewayPort -RangeStart $gwLow -RangeEnd $gwHigh
    if (-not $resolvedGatewayPort) { $resolvedGatewayPort = 8012 }

    $script:DFGatewayPort = $resolvedGatewayPort
    $gatewayPortInt = [int]$script:DFGatewayPort
    Write-Host "  Preferred port: Gateway=$preferredGatewayPort" -ForegroundColor DarkGray
    Write-Host "  Selected port:  Gateway=$gatewayPortInt (LangGraph in-process)" -ForegroundColor DarkGray

    $langgraphStateDir = Join-Path $script:DFBackendDir ".langgraph_api"
    if (Test-Path $langgraphStateDir) {
        Get-ChildItem -Path $langgraphStateDir -Filter "*.tmp" -File -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }

    $internalEventsSecret = Read-EvoFlowInternalEventsSecret
    $nJobsPerWorker = Read-EvoFlowNJobsPerWorker
    Write-Host "  N_JOBS_PER_WORKER (LangGraph in-process): $nJobsPerWorker" -ForegroundColor DarkGray

    $venvScripts = Join-Path $script:DFBackendDir ".venv\Scripts"
    $evoflowExe = Join-Path $venvScripts "evoflow.exe"
    if (-not (Test-Path -LiteralPath $evoflowExe)) {
        Write-Warning "evoflow CLI not found at $evoflowExe — run: cd backend; uv sync"
    }
    else {
        Write-Host "  evoflow CLI (dev): $evoflowExe" -ForegroundColor DarkGray
    }

    $gatewayBase = "http://127.0.0.1:$($script:DFGatewayPort)"
    $pythonPathValue = "$($script:DFBackendDir);$($script:DFBackendDir)\packages\harness"

    # Auto-read EvoPanel desktop workspace root and apply to dev backend.
    $devDeerFlowHome = Resolve-EvoFlowDevDeerFlowHome
    $configYaml = Join-Path $script:DFRepoRoot "config.yaml"
    $fixedEnv = ""
    if (-not [string]::IsNullOrWhiteSpace($devDeerFlowHome)) {
        $escapedHome = ($devDeerFlowHome -replace "'", "''")
        $fixedEnv += "`$env:EVOFLOW_HOME='$escapedHome'; "
        $lgApiDir = Join-Path $devDeerFlowHome ".langgraph_api"
        New-Item -ItemType Directory -Force -Path $lgApiDir | Out-Null
        $lgDb = Join-Path $lgApiDir "langgraph.db"
        $lgDbUri = "sqlite:///" + ($lgDb -replace '\\', '/')
        $escapedDbUri = ($lgDbUri -replace "'", "''")
        $fixedEnv += "`$env:DATABASE_URI='$escapedDbUri'; "
        $fixedEnv += "`$env:REDIS_URI='fake'; "
        $fixedEnv += "`$env:LANGGRAPH_DISABLE_FILE_PERSISTENCE='false'; "
        Write-Host "  EVOFLOW_HOME (dev backend): $devDeerFlowHome" -ForegroundColor DarkGray
        Write-Host "  LangGraph DATABASE_URI (in-process): $lgDbUri" -ForegroundColor DarkGray
    }
    if (Test-Path $configYaml) {
        $escapedCfg = ($configYaml -replace "'", "''")
        $fixedEnv += "`$env:EVOFLOW_CONFIG_PATH='$escapedCfg'; "
        Write-Host "  EVOFLOW_CONFIG_PATH (dev backend): $configYaml" -ForegroundColor DarkGray
    }
    if (-not [string]::IsNullOrWhiteSpace($env:EVOFLOW_STRESS_VENDOR_BASE_URL)) {
        $escapedStress = ($env:EVOFLOW_STRESS_VENDOR_BASE_URL.Trim() -replace "'", "''")
        $fixedEnv += "`$env:EVOFLOW_STRESS_VENDOR_BASE_URL='$escapedStress'; "
        Write-Host "  EVOFLOW_STRESS_VENDOR_BASE_URL (dev): $($env:EVOFLOW_STRESS_VENDOR_BASE_URL.Trim())" -ForegroundColor DarkYellow
    }

    # inmem LangGraph queue idle poll (Gateway patches Runs.next; default 20 in app.py).
    if (-not [string]::IsNullOrWhiteSpace($env:EVOFLOW_LG_QUEUE_POLL_MS)) {
        $escapedPoll = ($env:EVOFLOW_LG_QUEUE_POLL_MS.Trim() -replace "'", "''")
        $fixedEnv += "`$env:EVOFLOW_LG_QUEUE_POLL_MS='$escapedPoll'; "
        Write-Host "  EVOFLOW_LG_QUEUE_POLL_MS (dev): $($env:EVOFLOW_LG_QUEUE_POLL_MS.Trim())" -ForegroundColor DarkYellow
    }
    # 后台 Mission State 分析器（额外调模型写 intent/mission）。未设置时显式关；要开则先设 EVOFLOW_MISSION_STATE_ENABLED=1 再启动。
    if ([string]::IsNullOrWhiteSpace($env:EVOFLOW_MISSION_STATE_ENABLED)) {
        $fixedEnv += "`$env:EVOFLOW_MISSION_STATE_ENABLED='true'; "
        Write-Host "  EVOFLOW_MISSION_STATE_ENABLED (dev): true" -ForegroundColor DarkGray
    }
    else {
        Write-Host "  EVOFLOW_MISSION_STATE_ENABLED (from your shell): $($env:EVOFLOW_MISSION_STATE_ENABLED)" -ForegroundColor DarkGray
    }

    $gatewayEventsEnv = "`$env:EVOFLOW_GATEWAY_URL='$gatewayBase'; "
    # Single-process: LangGraph is mounted at /api/langgraph inside Gateway.
    $gatewayEventsEnv += "`$env:EVOFLOW_LANGGRAPH_URL='$gatewayBase/api/langgraph'; "
    $gatewayEventsEnv += "`$env:EVOFLOW_CHANNELS_LANGGRAPH_URL='$gatewayBase/api/langgraph'; "
    # LangGraph + httpx/OpenAI: on Windows, ProactorEventLoop + isolated job loops can
    # raise "RuntimeError: Event loop is closed" during stream aclose. Default isolated
    # loops off on Windows; graph load also re-forces false if backend/.env sets true.
    $bgIso = $env:BG_JOB_ISOLATED_LOOPS
    if ([string]::IsNullOrWhiteSpace($bgIso)) {
        if ($IsWindows -or $env:OS -match 'Windows') {
            $bgIso = "false"
        }
        else {
            $bgIso = "true"
        }
    }
    $gatewayEventsEnv += "`$env:BG_JOB_ISOLATED_LOOPS='$bgIso'; "
    if (-not [string]::IsNullOrWhiteSpace($internalEventsSecret)) {
        $escaped = ($internalEventsSecret -replace "'", "''")
        $gatewayEventsEnv += "`$env:INTERNAL_EVENTS_SECRET='$escaped'; "
    }

    $gwTitle = "EvoFlow Gateway :$gatewayPortInt [LangGraph in-process] [close window = stop]"

    # LangGraph CLI may print UTF-8 / symbols; default GBK consoles throw UnicodeEncodeError and look like a stuck black window.
    # PYTHONUNBUFFERED surfaces early logs while the agent graph imports (can take 30–90s on cold start).
    $winConsoleUtf8 = @'
try { chcp 65001 | Out-Null } catch { }
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
'@
    $winConsoleUtf8 = $winConsoleUtf8 -replace "`r`n", "; "

    $corsParts = New-Object System.Collections.Generic.List[string]
    foreach ($wp in $script:DFEvoPanelWebPorts) {
        [void]$corsParts.Add("http://localhost:$wp")
        [void]$corsParts.Add("http://127.0.0.1:$wp")
    }
    foreach ($extra in @("http://tauri.localhost", "tauri://localhost")) {
        if ($corsParts -notcontains $extra) { [void]$corsParts.Add($extra) }
    }
    $cors = ($corsParts -join ",")
    $gatewayInternalEventsEnv = "`$env:CORS_ORIGINS='$cors'; "
    # Agent terminal 需要能直接运行 evoflow（evoflow-admin 技能）；dev 未打包时走 venv Scripts。
    $escapedScripts = ($venvScripts -replace "'", "''")
    $gatewayInternalEventsEnv += "`$env:PATH='$escapedScripts;' + `$env:PATH; "
    $gatewayInternalEventsEnv += "`$env:EVOFLOW_CLI_DIR='$escapedScripts'; "
    # IM ChannelManager calls Gateway (/api/models, etc.); keep same base URL as this uvicorn process.
    $gatewayInternalEventsEnv += "`$env:EVOFLOW_CHANNELS_GATEWAY_URL='$gatewayBase'; "
    if (-not [string]::IsNullOrWhiteSpace($internalEventsSecret)) {
        $escaped = ($internalEventsSecret -replace "'", "''")
        $gatewayInternalEventsEnv += "`$env:INTERNAL_EVENTS_SECRET='$escaped'; "
    }
    # Per-thread model/tool debug UI (Gateway). Respect pre-set EVOFLOW_DEBUG_TRACE_UI=0 to keep off.
    if ([string]::IsNullOrWhiteSpace($env:EVOFLOW_DEBUG_TRACE_UI)) {
        $gatewayInternalEventsEnv += "`$env:EVOFLOW_DEBUG_TRACE_UI='1'; "
    }

    Write-Host ""
    Write-Host "==> Opening Gateway window (:$($script:DFGatewayPort)) — LangGraph runs in-process" -ForegroundColor Cyan
    Write-Host "    CORS_ORIGINS (desktop web): $cors" -ForegroundColor DarkGray
    $gwCmd = "$winConsoleUtf8; `$Host.UI.RawUI.WindowTitle = '$gwTitle'; cd '$($script:DFBackendDir)'; `$env:PYTHONPATH='$pythonPathValue'; `$env:PYTHONUTF8='1'; `$env:PYTHONIOENCODING='utf-8'; `$env:PYTHONUNBUFFERED='1'; $fixedEnv $gatewayInternalEventsEnv & '$pyExe' -u -m uvicorn app.gateway.app:app --host 0.0.0.0 --port $gatewayPortInt"
    $gateway = Start-Process powershell.exe -ArgumentList @(
        "-NoProfile",
        "-NoExit",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        $gwCmd
    ) -WindowStyle Normal -PassThru

    @(
        "gateway_ps_pid=$($gateway.Id)"
    ) | Set-Content -LiteralPath $script:DFBackendConsolePidFile -Encoding utf8

    Write-Host ""
    Write-Host "==> Waiting for Gateway port (this window stays open)..." -ForegroundColor Cyan
    $okGw = Wait-EvoFlowPortReady -Port $script:DFGatewayPort -TimeoutSec 120

    # Persist last-start runtime state for easier stopping next time (auto port selection, reload workers, etc.)
    try {
        $netGw = @(netstat -ano 2>$null | Select-String -Pattern (":$($script:DFGatewayPort)\s") -SimpleMatch | ForEach-Object { $_.Line })
        $state = @{
            startedAt = (Get-Date).ToString("o")
            ports = @{
                gateway = [int]$script:DFGatewayPort
            }
            consolePids = @{
                gateway = [int]$gateway.Id
            }
            portReady = @{
                gateway = [bool]$okGw
            }
            netstat = @{
                gateway = $netGw
            }
        }
        ($state | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $script:DFBackendLastStartStateFile -Encoding utf8
    } catch {
        # ignore state persistence failures
    }

    Write-Host ""
    Write-Host "Backend startup result:" -ForegroundColor Green
    Write-Host "  Gateway   ($($script:DFGatewayPort)): $okGw (LangGraph in-process)"
    Write-Host "  会话调试（提示词/工具/响应摘要）: http://127.0.0.1:$($script:DFGatewayPort)/api/debug/agent-trace" -ForegroundColor DarkCyan
    Write-Host ""
    Write-Host "Console host PID (also in $($script:DFBackendConsolePidFile)):" -ForegroundColor DarkGray
    Write-Host "  Gateway window PID=$($gateway.Id)"
    Write-Host ""
    Write-Host "Stop: close the Gateway window, OR run stop-backend.ps1" -ForegroundColor Yellow
    Write-Host "Optional file logs still work if you redirect yourself; default is live console only." -ForegroundColor DarkGray
    Write-Host "Desktop web (Tauri devUrl): http://localhost:$($script:DFEvoPanelWebPorts[0]) | start separately: scripts\windows\start-evopanel-web.ps1" -ForegroundColor DarkYellow
}

function Stop-EvoFlowEvoPanelWeb {
    Write-Host ""
    Write-Host "==> Stopping EvoPanel dev listeners (ports $($script:DFEvoPanelWebPorts -join ', '))" -ForegroundColor Yellow
    foreach ($p in $script:DFEvoPanelWebPorts) {
        Stop-EvoFlowPortProcess -Port $p
        $null = Wait-EvoFlowPortClosed -Port $p -TimeoutSec 15
    }
    Write-Host "    Done. (若 Vite 落在 1422+，请用任务管理器结束 node 或再执行一次带 -ExtraPorts)" -ForegroundColor DarkGray
}

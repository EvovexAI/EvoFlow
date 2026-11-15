# 【fullstack-dev · 2026-11-15 · 第13轮】新增：自验证看门狗（安装→拉起→回捞 Agent）
#   为什么：dev-self-release.ps1 触发后，NSIS 会用 taskkill /F /T 打掉桌面父进程树 +
#   安装目录下 python/bash/node（installer-hooks.nsh EvpKillRunningAppProcesses /
#   kill-install-orphans.ps1），发起方 Agent 必然死在安装中途。本脚本只由 Task
#   Scheduler 启动（父进程 svchost，不在被杀树内；宿主 powershell.exe 也不在杀名单），
#   因此能活过安装，把客户端拉回来并 wake 对应岗位续跑验证。
#   用法：不要手敲。由 dev-self-release.ps1 注册计划任务调用；参数走 state 文件，
#   不走命令行 —— 命令行里出现安装目录路径会被 kill-install-orphans 的 CommandLine
#   匹配扫杀（脚本自身豁免，但 wake 子进程会带 goal 文本，故 goal 不落 CLI）。
<#
.SYNOPSIS
  EvoFlow 自验证看门狗：静默安装 setup.exe → 等 Gateway ready → 拉起客户端 → wake 岗位。
.DESCRIPTION
  步骤与判据（每步都写日志，失败即停并把 exit code 记进日志）：
    1. 读 state.json（由 dev-self-release.ps1 写入）
    2. setup.exe /S 静默安装（安装器自己会 taskkill 掉正在跑的 EvoFlow）
    3. Start-Process 安装目录下的 evoflow.exe
    4. 轮询 backend-runtime.json：status=ready 且 (pid != 旧 pid 或 generation > 旧 generation)
       且 GET {baseUrl}/health 返回 2xx —— 三个条件同时满足才算就绪
    4b. 再轮询 employees list 直到目标 agent_code 在册（/health≠名册就绪，第13轮实测教训）
    5. evoflow employees wake <agent> --task-id --resume-round 把岗位叫醒续跑
    6. finally 里删除本计划任务，不留残余
.NOTES
  日志：<repo>\outputs\selfverify\watchdog.log（被叫醒的 Agent 结案前先读它）
#>
[CmdletBinding()]
param(
  [string] $StateFile = "",
  [switch] $DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
if ([string]::IsNullOrWhiteSpace($StateFile)) {
  $StateFile = Join-Path $RepoRoot "outputs\selfverify\state.json"
}
$OutDir = Split-Path -Parent $StateFile
$LogFile = Join-Path $OutDir "watchdog.log"
$ResultFile = Join-Path $OutDir "watchdog-result.json"

function Write-Log {
  param([string] $Message, [string] $Level = "INFO")
  $line = "[{0}] [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
  try {
    if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  } catch { }
  Write-Host $line
}

function Read-JsonFile {
  param([string] $Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
  } catch {
    Write-Log "JSON 解析失败: $Path ($_)" "WARN"
    return $null
  }
}

function Get-GatewayRuntime {
  param([string] $HomeOverride)
  $candidates = @()
  if (-not [string]::IsNullOrWhiteSpace($HomeOverride)) { $candidates += (Join-Path $HomeOverride "backend-runtime.json") }
  $cfg = $env:EVOFLOW_CONFIG_DIR
  $prof = $env:EVOFLOW_PROFILE
  if (-not $cfg) { $cfg = Join-Path $env:USERPROFILE ".evoflow" }
  if (-not $prof) { $prof = "default" }
  $candidates += (Join-Path $cfg "profiles\$prof\backend-runtime.json")
  $candidates += (Join-Path $cfg "backend-runtime.json")
  foreach ($p in $candidates) {
    $data = Read-JsonFile $p
    if ($data) { return @{ path = $p; data = $data } }
  }
  return $null
}

function Test-GatewayHealthy {
  param([string] $BaseUrl)
  if ([string]::IsNullOrWhiteSpace($BaseUrl)) { return $false }
  try {
    $resp = Invoke-WebRequest -Uri "$($BaseUrl.TrimEnd('/'))/health" -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
    return ([int]$resp.StatusCode -ge 200 -and [int]$resp.StatusCode -lt 300)
  } catch { return $false }
}

# ── 0. 读 state ────────────────────────────────────────────────────────────
$state = Read-JsonFile $StateFile
if (-not $state) {
  Write-Log "state 缺失，无法继续: $StateFile" "ERROR"
  exit 2
}
$InstallDir  = [string]$state.installDir
$SetupExe    = [string]$state.setupExe
$AgentCode   = [string]$state.agentCode
$TaskId      = [string]$state.taskId
$Goal        = [string]$state.goal
$RoundId     = [string]$state.roundId
$Cli         = [string]$state.cliExe
$RuntimeHome = [string]$state.evoflowHome
$TaskName    = [string]$state.taskName
$InstallArgs = @($state.installArgs)
if ($InstallArgs.Count -eq 0) { $InstallArgs = @("/S") }
$InstallTimeout = [int]$state.installTimeoutSec; if ($InstallTimeout -le 0) { $InstallTimeout = 1800 }
$ReadyTimeout   = [int]$state.readyTimeoutSec;   if ($ReadyTimeout   -le 0) { $ReadyTimeout   = 240 }
$WakeAttempts   = [int]$state.wakeAttempts;       if ($WakeAttempts   -le 0) { $WakeAttempts   = 6 }
$OldPid         = $state.oldGatewayPid
$OldGeneration  = $state.oldGeneration

Write-Log "===== 看门狗启动 pid=$PID repo=$RepoRoot dryrun=$($DryRun.IsPresent) ====="
Write-Log "安装目录=$InstallDir 安装包=$SetupExe 岗位=$AgentCode Task=$TaskId"

$exitCode = 0
$stage = "init"
try {
  if (-not (Test-Path -LiteralPath $SetupExe)) { throw "安装包不存在: $SetupExe" }
  if ([string]::IsNullOrWhiteSpace($InstallDir) -or -not (Test-Path -LiteralPath $InstallDir)) { throw "安装目录不存在: $InstallDir" }
  $installedExe = Join-Path $InstallDir "evoflow.exe"

  # ── 1. 静默安装（安装器内部 taskkill 会打掉旧桌面+gateway+孤儿进程）──
  $stage = "install"
  if ($DryRun) {
    Write-Log "[dryrun] 跳过实际安装: $SetupExe $($InstallArgs -join ' ')" "WARN"
  } else {
    Write-Log "开始静默安装（超时 ${InstallTimeout}s）: $SetupExe $($InstallArgs -join ' ')"
    $p = Start-Process -FilePath $SetupExe -ArgumentList $InstallArgs -PassThru -Wait
    Write-Log "安装进程退出 code=$($p.ExitCode)"
    if ($null -ne $p.ExitCode -and $p.ExitCode -ne 0) { throw "安装失败 exit=$($p.ExitCode)（可能需要提权：见 README「UAC」一节）" }
  }

  # ── 2. 拉起客户端 ────────────────────────────────────────────────────
  $stage = "launch"
  if (-not (Test-Path -LiteralPath $installedExe)) { throw "安装后找不到主程序: $installedExe" }
  # 【fullstack-dev · 2026-11-15 · 第13轮】修接线缺陷：直接拉起的是**打包 sidecar 后端**，
  # 被叫醒的 Agent 验到的会是安装包里旧 python 代码，本轮仓库改动根本没载入（等于白装）。
  # state.backendDir 非空时按 run-installed-with-dev-gateway.ps1 的做法指回仓库源码；
  # Start-Process 子进程继承本进程环境变量，故在此设置即可生效。
  $backendDir = [string]$state.backendDir
  if ($backendDir -and (Test-Path -LiteralPath (Join-Path $backendDir "packages\harness\evoflow"))) {
    $env:EVOFLOW_BACKEND_DIR = $backendDir
    $env:EVOFLOW_USE_PACKAGED_SIDECAR = "0"
    Remove-Item Env:EVOPANEL_BACKEND_EXE_PATH -ErrorAction SilentlyContinue
    Write-Log "以后端源码运行: EVOFLOW_BACKEND_DIR=$backendDir（验的是仓库改动，不是打包件）"
  } else {
    Write-Log "未给 backendDir：将跑安装包自带后端，只能验前端产物与 Rust 侧改动" "WARN"
  }
  if ($DryRun) {
    Write-Log "[dryrun] 跳过拉起: $installedExe" "WARN"
  } else {
    Write-Log "拉起客户端: $installedExe"
    Start-Process -FilePath $installedExe -WorkingDirectory (Split-Path -Parent $installedExe) | Out-Null
  }

  # ── 3. 等 Gateway 就绪（三条件：status ready + 换代 + /health 2xx）──────
  $stage = "wait-gateway"
  $deadline = (Get-Date).AddSeconds($ReadyTimeout)
  $baseUrl = ""
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $rt = Get-GatewayRuntime $RuntimeHome
    if (-not $rt) { continue }
    $d = $rt.data
    $baseUrl = [string]$d.baseUrl
    if ([string]::IsNullOrWhiteSpace($baseUrl) -and $d.port) { $baseUrl = "http://127.0.0.1:$($d.port)" }
    $swapped = ($d.status -eq "ready") -and (
      ($OldPid -and [string]$d.pid -ne [string]$OldPid) -or
      ($null -ne $OldGeneration -and [int]$d.generation -gt [int]$OldGeneration) -or
      (-not $OldPid -and -not $OldGeneration)
    )
    if ($swapped -and (Test-GatewayHealthy $baseUrl)) { $ready = $true; break }
    Write-Log "等待 Gateway: status=$($d.status) pid=$($d.pid) gen=$($d.generation) health=$($baseUrl -ne '' -and (Test-GatewayHealthy $baseUrl))"
  }
  if (-not $ready) { throw "Gateway 在 ${ReadyTimeout}s 内未就绪（baseUrl=$baseUrl）" }
  Write-Log "Gateway 已就绪: $baseUrl"

  # ── 4. 回捞岗位（goal 走 state，不进命令行，避免被 CommandLine 规则扫杀）──
  $stage = "wake"
  if (-not (Test-Path -LiteralPath $Cli)) { throw "CLI 不存在: $Cli" }
  $env:EVOFLOW_GATEWAY_URL = $baseUrl
  $env:EVOFLOW_GATEWAY_PORT = ([int](([Uri]$baseUrl).Port))
  # 【fullstack-dev · 2026-11-15 · 第14轮】钉死 CLI 的数据目录（EVOFLOW_HOME）。
  # 为什么：employees list / wake 读的是**本地 SQLite**（ProactiveRepository.list_roles →
  # get_db()），根本不走 Gateway HTTP —— 所以「/health 通了」和「名册查得到」是两回事，
  # 第13轮 wake 连败 6 次报 "No employee matching 'fullstack-dev'" 就是这么来的。
  # 真因（第14轮只读实测证死，非推测）：本机**用户级持久**环境变量
  #   [Environment]::GetEnvironmentVariable('EVOFLOW_HOME','User') = C:\Users\admin\.evoflow-dev
  # 而计划任务（Task Scheduler）继承的正是注册表里的用户级值，不是我 dev shell 里那份
  # 进程级 EVOFLOW_HOME=…\profiles\default。两个库内容不同：
  #   .evoflow-dev/data/app/evoflow.db        → 17 个岗位，**无 fullstack-dev**
  #   profiles/default/data/app/evoflow.db    → 22 个岗位，含 fullstack-dev
  # 故看门狗在计划任务下跑 CLI 时读到 .evoflow-dev 那份旧库，名册里查无此岗；
  # 我事后在 dev shell 里跑同一条命令自然查得到 22 个岗位 —— 当时那个矛盾就是这么产生的。
  # 对照实验（同一 CLI，只换 EVOFLOW_HOME）：指向 .evoflow-dev → grep -c fullstack-dev = 0；
  # 指向 profiles\default → ≥1。修法即用登记端从 backend-runtime.json 同目录读到的权威
  # evoflowHome 显式覆盖，不给继承值留机会。
  if (-not [string]::IsNullOrWhiteSpace($RuntimeHome)) {
    $env:EVOFLOW_HOME = $RuntimeHome
    Write-Log "CLI 数据目录钉为 EVOFLOW_HOME=$RuntimeHome"
  }
  # 【fullstack-dev · 2026-11-15 · 第13轮】修两处：① 原先传了不存在的 --state-file 开关
  # （照抄会直接 exit≠0）；② goal 若含安装目录路径，会被 kill-install-orphans 的
  # CommandLine 匹配连带杀掉承载它的 python.exe，故此处剥掉安装目录字串。
  $safeGoal = $Goal
  if ($safeGoal -and $InstallDir) { $safeGoal = $safeGoal.Replace($InstallDir, "<install-dir>") }
  $wakeArgs = @("employees", "wake", $AgentCode, "--from", "user", "--priority", "high", "--resume-round")
  if ($TaskId)    { $wakeArgs += @("--task-id", $TaskId) }
  if ($safeGoal)  { $wakeArgs += @("--goal", $safeGoal) }
  if ($RoundId)   { $wakeArgs += @("--round-id", $RoundId) }
  # 【fullstack-dev · 2026-11-15 · 第14轮】wake 前先等目标岗位真的在册，再投 wake；失败按递增退避重试。
  # 更正我上一轮的归因：原判据「/health 返 200 = 可投递」确实错（list/wake 读本地 SQLite，
  # 不走 HTTP），但「名册尚未装载完」这个解释也错——真因见上方 EVOFLOW_HOME 那段（继承了
  # .evoflow-dev 旧库，该库根本不含 fullstack-dev，等多久都不会出现）。
  # 所以本闸门**必须和上面的 EVOFLOW_HOME 覆盖配套**才有效；单独留着它只会在旧库上白等
  # rosterTimeout 秒再 throw。保留理由：防御 home 正确、但 gateway 刚起、名册确有延迟的场景。
  $stage = "wait-roster"
  $rosterTimeout = [int]$state.rosterTimeoutSec; if ($rosterTimeout -le 0) { $rosterTimeout = 300 }
  $needle = '"agent_code": "' + $AgentCode + '"'
  $needleCompact = '"agent_code":"' + $AgentCode + '"'
  $rosterOk = $false
  $rd = (Get-Date).AddSeconds($rosterTimeout)
  while ((Get-Date) -lt $rd) {
    if ($DryRun) { $rosterOk = $true; break }
    try {
      $list = & $Cli employees list --compact 2>&1 | Out-String
      if ($list.Contains($needle) -or $list.Contains($needleCompact)) { $rosterOk = $true; Write-Log "岗位名册已就绪（含 $AgentCode）"; break }
      Write-Log "名册尚未含 $AgentCode，继续等（$($list.Length) 字节）"
    } catch { Write-Log "employees list 异常: $_" "WARN" }
    Start-Sleep -Seconds 10
  }
  if (-not $rosterOk) { throw "岗位名册在 ${rosterTimeout}s 内未载入 $AgentCode —— 未做 wake，请检查 gateway 启动日志" }

  $stage = "wake"
  $ok = $false
  $backoff = 10
  for ($i = 1; $i -le $WakeAttempts; $i++) {
    if ($DryRun) { Write-Log "[dryrun] $Cli $($wakeArgs -join ' ')" "WARN"; $ok = $true; break }
    Write-Log "wake 第 $i/$WakeAttempts 次: $Cli $($wakeArgs -join ' ')"
    try {
      $out = & $Cli @wakeArgs 2>&1 | Out-String
      Add-Content -LiteralPath $LogFile -Value $out -Encoding UTF8
      if ($LASTEXITCODE -eq 0) { $ok = $true; Write-Log "wake 成功"; break }
      # 名册竞态类错误值得再等；参数/权限类错误重投百次也不会好，立即止损。
      if ($out -match "No employee matching|not found|not active") {
        Write-Log "wake 命中名册/状态类错误，${backoff}s 后重试" "WARN"
      } else {
        Write-Log "wake 返回 exit=$LASTEXITCODE（非名册类，重试无意义）" "ERROR"; break
      }
    } catch {
      Write-Log "wake 异常: $_" "WARN"
    }
    Start-Sleep -Seconds $backoff
    if ($backoff -lt 60) { $backoff = $backoff + 15 }
  }
  if (-not $ok) { throw "wake 连续 $WakeAttempts 次失败，请手动执行: $Cli employees wake $AgentCode --task-id $TaskId --resume-round" }
}
catch {
  $exitCode = 1
  Write-Log "[$stage] 失败: $_" "ERROR"
}
finally {
  $summary = @{ stage = $stage; ok = ($exitCode -eq 0); exitCode = $exitCode; baseUrl = $baseUrl; agentCode = $AgentCode; taskId = $TaskId; at = (Get-Date).ToString("o") } | ConvertTo-Json -Compress
  try {
    if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    Set-Content -LiteralPath $ResultFile -Value $summary -Encoding UTF8
  } catch { }
  # ── 5. 自删计划任务，不留残余 ────────────────────────────────────────
  if ($TaskName) {
    try {
      schtasks.exe /Delete /TN $TaskName /F 2>&1 | Out-Null
      Write-Log "已删除计划任务: $TaskName"
    } catch { Write-Log "删除计划任务失败（可手动 schtasks /Delete /TN `"$TaskName`" /F）" "WARN" }
  }
  Write-Log "===== 看门狗结束 exit=$exitCode stage=$stage ====="
}
exit $exitCode

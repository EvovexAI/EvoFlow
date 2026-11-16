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
  [switch] $DryRun,
  # 【self-evolution-bot · 2026-11-15 · 第16轮】补声明：第15轮写自检模式时只加了下面的
  # 使用点（$skipInstall/$skipLaunch 共 5 处）却没加 param，导致命令行传 -SkipInstall 直接报
  # 「找不到参数」、脚本里 [bool]$SkipInstall 恒为 False —— 自检模式实际只能靠手改 state.json
  # 才进得去，等于第15轮宣称的"一键自检"从未真机可用（本轮 grep param 块才发现）。
  [switch] $SkipInstall,
  [switch] $SkipLaunch,
  # 【self-evolution-bot · 2026-11-16 · 第19轮】新增：只装只拉、不唤醒。
  # 为什么：用户要「构建重启但不要唤醒」—— 装完把客户端拉起来就该收工，
  # 叫醒 Agent 反而会在用户没要的时候插一轮对话。与前两个开关同理必须在此声明，
  # 否则命令行传参会被判「找不到参数」（第15轮就栽过这个接线漏项）。
  [switch] $SkipWake
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

# 【fullstack-dev · 2026-11-15 · 第16轮】新增"投递面"探测，因为 /health 判不了 wake 能不能投出去
# 第15轮真机实测：13:37:56 三条件就绪 + 13:38:00 名册在册 + 13:38:04 wake 却拿 HTTP 503。
# 根因：/health 在 startup_gate 的 _STARTUP_EXEMPT_PREFIXES 里（永不被拦），而 wake 走的
# /api/proactive 在 _EXTENDED_ROUTE_PREFIXES 里，extended_routers_registered 要到 app.py:280
# 那个 post-ready 后台任务才置 True —— 所以"客户端已就绪"与"投递面可通"之间有一段确定性空窗。
# 判据必须探真正被闸门管的端点，不能只借 /health 代替。返回 @{code; body}，body 用于认错误码。
function Get-DeliveryGateStatus {
  param([string] $BaseUrl)
  if ([string]::IsNullOrWhiteSpace($BaseUrl)) { return @{ code = 0; body = '' } }
  try {
    $resp = Invoke-WebRequest -Uri "$($BaseUrl.TrimEnd('/'))/api/proactive/status" -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
    return @{ code = [int]$resp.StatusCode; body = '' }
  } catch {
    # PS 5.1 对非 2xx 抛异常。取状态码从 Exception.Response；取响应体**必须**先读 ErrorDetails.Message ——
    # 实测（第16轮探针 probe-body.ps1）$res.GetResponseStream() 此时已被 PowerShell 消耗、ReadToEnd 返空串，
    # 只有 ErrorDetails.Message 里才是真体 {"error":"loading_extended",...}。连接被拒时 Response 为 null，
    # 走 code=0 分支（探测异常，继续等），不会被误判成"闸门放行"。
    $sc = 0
    $body = ''
    $res = $null
    try { $res = $_.Exception.Response } catch { $res = $null }
    if ($null -ne $res) {
      try { $sc = [int]$res.StatusCode } catch { $sc = 0 }
      try { $body = [string]$_.ErrorDetails.Message } catch { $body = '' }
      if ([string]::IsNullOrWhiteSpace($body)) {
        try {
          $sr = New-Object System.IO.StreamReader($res.GetResponseStream())
          $body = [string]$sr.ReadToEnd()
          $sr.Dispose()
        } catch { $body = '' }
      }
    }
    return @{ code = $sc; body = $body }
  }
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
# 【self-evolution-bot · 2026-11-17 · 第28轮】把唤醒投回用户正看着的那一屏。
#   只有登记端传了 -SessionKey 才有值；空 = 原行为（task/duty 自动分桶），不受影响。
$SessionKey  = [string]$state.sessionKey
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

# 【fullstack-dev · 2026-11-15 · 第15轮】必须在 try 之前定：finally 靠它决定"要不要删计划任务"，
# 若在 try 内才赋值，一旦在安装前抛错（如安装包缺失），finally 读到 null 就当自己是真跑，
# 会把尚未触发的真安装任务 EvoFlow-SelfVerify-Watchdog 删掉。state 与命令行开关取并集。
$skipInstall = [bool]$SkipInstall -or [bool]$state.skipInstall
$skipLaunch  = [bool]$SkipLaunch  -or [bool]$state.skipLaunch
# 【self-evolution-bot · 2026-11-16 · 第19轮】新增 $skipWake：只装只拉、不叫醒 Agent。
# 取 state 与命令行开关并集，与上面两个同口径。
$skipWake    = [bool]$SkipWake    -or [bool]$state.skipWake

$exitCode = 0
$stage = "init"
$wakeOutcome = "not-attempted"
try {
  if (-not (Test-Path -LiteralPath $SetupExe)) { throw "安装包不存在: $SetupExe" }
  if ([string]::IsNullOrWhiteSpace($InstallDir) -or -not (Test-Path -LiteralPath $InstallDir)) { throw "安装目录不存在: $InstallDir" }
  $installedExe = Join-Path $InstallDir "evoflow.exe"

  # ── 1. 静默安装（安装器内部 taskkill 会打掉旧桌面+gateway+孤儿进程）──
  $stage = "install"
  if ($DryRun) {
    Write-Log "[dryrun] 跳过实际安装: $SetupExe $($InstallArgs -join ' ')" "WARN"
  } elseif ($skipInstall) {
    # 【fullstack-dev · 2026-11-15 · 第15轮】自检模式：用户已重启客户端时，再装一次只为验 wake
    # 不划算且会二次断线。此路径只验后半段（就绪/名册/wake），不销毁现场。
    Write-Log "[selftest] skipInstall=1，跳过安装（仅验就绪/名册/wake）" "WARN"
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
  } elseif ($skipLaunch) {
    # 自检模式下客户端已由用户在跑，再 Start-Process 会双开并抢 sidecar.lock。
    Write-Log "[selftest] skipLaunch=1，跳过拉起（沿用当前实例）" "WARN"
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
  # 真因是**两层叠加**（第14轮只归对第一层，第16轮复算补齐；勿再照抄旧注释）：
  # ① 本机**用户级持久**环境变量（实测 Machine 级为空）
  #     [Environment]::GetEnvironmentVariable('EVOFLOW_HOME','User') = C:\Users\admin\.evoflow-dev
  #   计划任务继承的正是注册表里这份用户级值，不是我 dev shell 里的进程级 profiles\default。
  #   第16轮矩阵复算（同一 CLI 同一时刻只换 HOME，见 evoflow-home-probe.ps1）：
  #     .evoflow-dev   → n=17，不含本岗
  #     profiles\default → n=23，含 self-evolution-bot
  #     不设 HOME（CLI 默认）→ n=23，同上
  #     %USERPROFILE%\.evoflow（裸目录）→ n=1，另一份近空库（新发现的陷阱，本次故障非它引起）
  #   （更正：本注释原写"22 岗位含 fullstack-dev"，数与岗位名都不对。）
  # ② 旧码 fullstack-dev 在**两个库里都不存在**——本岗 11-15 16:01 改名 self-evolution-bot，
  #   名册里那个 case-fullstack-dev 是另一个不相干的岗。所以只钉 home 不改岗位码，照样六连败。
  # 故"事后在 dev shell 跑同一条命令查得到"并不矛盾：两个进程读的不是同一个库。
  # 修法：用登记端**实证挑库**后写进 state 的 evoflowHome 显式覆盖，不给继承值留机会；
  #   登记端挑不到认这个岗的库就直接拒绝登记，不等 30 秒后让看门狗白跑。
  if (-not [string]::IsNullOrWhiteSpace($RuntimeHome)) {
    $env:EVOFLOW_HOME = $RuntimeHome
    Write-Log "CLI 数据目录钉为 EVOFLOW_HOME=$RuntimeHome"
  }
  # 【fullstack-dev · 2026-11-15 · 第13轮】修两处：① 原先传了不存在的 --state-file 开关
  # （照抄会直接 exit≠0）；② goal 若含安装目录路径，会被 kill-install-orphans 的
  # CommandLine 匹配连带杀掉承载它的 python.exe，故此处剥掉安装目录字串。
  $safeGoal = $Goal
  if ($safeGoal -and $InstallDir) { $safeGoal = $safeGoal.Replace($InstallDir, "<install-dir>") }
  # 【fullstack-dev · 2026-11-15 · 第15轮】--resume-round 只在真有 TaskId 时带：无 task 可续时
  # 它是空转参数，且会把"续哪一轮"的判定推给一个不存在的单据（本次实跑就不带 task-id）。
  $wakeArgs = @("employees", "wake", $AgentCode, "--from", "user", "--priority", "high")
  if ($TaskId)    { $wakeArgs += @("--task-id", $TaskId, "--resume-round") }
  if ($safeGoal)  { $wakeArgs += @("--goal", $safeGoal) }
  if ($RoundId)   { $wakeArgs += @("--round-id", $RoundId) }
  # 【self-evolution-bot · 2026-11-17 · 第28轮】带 -SessionKey 时把唤醒投回用户那一屏；
  #   不带保持原行为（自动分桶），旧闭环不受影响。
  if ($SessionKey) { $wakeArgs += @("--session-key", $SessionKey) }
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

  # 【fullstack-dev · 2026-11-15 · 第16轮】新增 4c：wake 前等"投递面"通（第15轮实测的 503 空窗）
  # 名册在册只证明 CLI 读对了库，不证明 Gateway 的 /api/proactive 已挂载完；503 是可重试态，
  # 但原逻辑把它当"非名册类错误"立即止损，等于把一段几百毫秒的加载窗口判成永久失败。
  $stage = "wait-delivery-gate"
  $gateTimeout = [int]$state.deliveryGateTimeoutSec; if ($gateTimeout -le 0) { $gateTimeout = 120 }
  $gateOk = $false
  $gd = (Get-Date).AddSeconds($gateTimeout)
  while ((Get-Date) -lt $gd) {
    if ($DryRun) { $gateOk = $true; break }
    $g = Get-DeliveryGateStatus $baseUrl
    if ($g.code -ge 200 -and $g.code -lt 300) { $gateOk = $true; Write-Log "投递面已就绪（/api/proactive/status=$($g.code)）"; break }
    if ($g.code -eq 503) {
      # 体是 {"error":"loading_extended"|"starting_up"|"warming_up",...}；解析失败只降级成 unknown，
      # 绝不为多打一行日志把闸门本身弄崩（body 可能是空串，ConvertFrom-Json 会抛）
      $gateCode = 'unknown'
      try {
        if (-not [string]::IsNullOrWhiteSpace($g.body)) {
          $bj = $g.body | ConvertFrom-Json
          if ($bj.error) { $gateCode = [string]$bj.error }
        }
      } catch { $gateCode = 'unparsed' }
      Write-Log "投递面仍在加载（503 error=$gateCode），5s 后重探" "WARN"
    } elseif ($g.code -eq 0) {
      Write-Log "投递面探测异常（无响应/连接失败），5s 后重探" "WARN"
    } else {
      Write-Log "投递面返回非预期码=$($g.code)，不再等待，交给 wake 自己判" "WARN"
      $gateOk = $true
      break
    }
    Start-Sleep -Seconds 5
  }
  if (-not $gateOk) { throw "投递面在 ${gateTimeout}s 内未就绪（/api/proactive/status 持续 503）—— 未做 wake，扩展路由可能加载失败，请查 gateway 日志" }

  $stage = "wake"
  # 【self-evolution-bot · 2026-11-16 · 第19轮】新增 $skipWake 短路：只装只拉、不叫醒。
  # 放在 for 循环之前，且把分型写成 "skipped-by-flag" —— 绝不能停在初值 not-attempted，
  # 否则读 result.json 的人分不清「没走到 wake」和「我主动跳过了」。
  if ($skipWake) {
    Write-Log "[skipWake] 已指定跳过 wake —— 客户端已拉起，不再叫醒 $AgentCode（本次不算投递验证）" "WARN"
    $wakeOutcome = "skipped-by-flag"
    $ok = $true
  }
  $backoff = 10
  for ($i = 1; $i -le $WakeAttempts; $i++) {
    if ($skipWake) { break }
    # 【self-evolution-bot · 2026-11-15 · 第16轮】dryrun 也要把分型写清楚：原先只置 $ok=$true、
    # 让 wakeOutcome 停在初值 not-attempted，读的人还得自己猜。改成显式 "dryrun-not-attempted"，
    # 与真投递的 delivered / busy-wiring-proven / skipped-already-done 一眼区分。
    if ($DryRun) { Write-Log "[dryrun] $Cli $($wakeArgs -join ' ')" "WARN"; $wakeOutcome = "dryrun-not-attempted"; $ok = $true; break }
    Write-Log "wake 第 $i/$WakeAttempts 次: $Cli $($wakeArgs -join ' ')"
    try {
      $out = & $Cli @wakeArgs 2>&1 | Out-String
      Add-Content -LiteralPath $LogFile -Value $out -Encoding UTF8
      # 【fullstack-dev · 2026-11-15 · 第15轮】exit=0 ≠ 真被叫醒，必须分型，否则静默假阳性：
      #   skipped=true → 所引 Task 已结案，done-guard 直接跳过（什么都没投递，却 exit=0）
      #   busy         → 岗位寻址成功、请求已到达，只是当轮在忙 —— 接线算通，投递未证
      if ($LASTEXITCODE -eq 0) {
        if ($out -match '"skipped"\s*:\s*true') {
          $wakeOutcome = "skipped-already-done"
          Write-Log "wake 返回 skipped=true（所引 Task 已结案，未真正投递）—— 判 inconclusive，勿记成功" "WARN"; break
        }
        $wakeOutcome = "delivered"; $ok = $true; Write-Log "wake 成功（已投递）"; break
      }
      if ($out -match "busy") {
        # 自检场景下本岗正在跑，busy 是预期结果；它证明 名册→寻址→dispatch 全通。
        $wakeOutcome = "busy-wiring-proven"
        Write-Log "wake 命中 busy（岗位已寻到、请求已到达；本岗正在跑，属预期）—— 接线判通" "WARN"; break
      }
      # 只有真·名册类错误才值得重试；其余（参数/权限/读错库）重投百次也不会好，立即止损。
      # 【fullstack-dev · 2026-11-15 · 第16轮】503 加入可重试集：上面的投递面闸门已能挡掉绝大多数，
      # 这里兜的是闸门通过后才开始加载、或加载面抖动回 503 的残差。真机实测 503 是可自愈态。
      if ($out -match "No employee matching") {
        Write-Log "wake 报查无此岗，${backoff}s 后重试（若持续 = 数据目录仍指错库）" "WARN"
      } elseif ($out -match "HTTP 50[234]|loading_extended|starting_up|warming_up|retry") {
        Write-Log "wake 命中 Gateway 可重试态（503/加载窗口），${backoff}s 后重试" "WARN"
      } else {
        $wakeOutcome = "failed"
        Write-Log "wake 返回 exit=$LASTEXITCODE（非名册类，重试无意义）" "ERROR"; break
      }
    } catch {
      Write-Log "wake 异常: $_" "WARN"
    }
    Start-Sleep -Seconds $backoff
    if ($backoff -lt 60) { $backoff = $backoff + 15 }
  }
  # 【self-evolution-bot · 2026-11-15 · 第16轮】报错文案要照分型说，别一律"连续 N 次失败"：
  # 本轮实测 skipped-already-done 走 break 只跑了 1 次，却打出"失败 6 次"，把"锚点是已结案的单"
  # 这个真因盖掉了，误导排查方向。
  $why = if ($wakeOutcome -eq "skipped-already-done") { "所引 Task 已结案 → done-guard 跳过，未投递（换一个未结案的任务 id）" }
         elseif ($wakeOutcome -eq "failed") { "非名册类错误，重投无意义（看 watchdog.log 尾部原文）" }
         else { "连续 $WakeAttempts 次未通" }
  if (-not $ok) { throw "wake 未成功（outcome=$wakeOutcome）：$why。可手动执行: $Cli employees wake $AgentCode --task-id $TaskId --resume-round" }
}
catch {
  $exitCode = 1
  Write-Log "[$stage] 失败: $_" "ERROR"
}
finally {
  # 【self-evolution-bot · 2026-11-15 · 第16轮】补接线：第15轮加了 $wakeOutcome 分型（5 处赋值）
  # 却没写进本文件，被叫醒的岗位读 result 仍只看到 ok=true，分不清是 delivered / busy / skipped ——
  # 正是我记过的「只测函数不测接线」同类漏项。另加 selftest：让读的人一眼知道这轮 ok=true 只证明
  # 了后半段（就绪/名册/投递面/wake），没证明静默安装与拉起。
  $summary = @{ stage = $stage; ok = ($exitCode -eq 0); exitCode = $exitCode; baseUrl = $baseUrl; agentCode = $AgentCode; taskId = $TaskId; wakeOutcome = $wakeOutcome; selftest = [bool]($skipInstall -or $skipLaunch); skipWake = [bool]$skipWake; at = (Get-Date).ToString("o") } | ConvertTo-Json -Compress
  try {
    if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    Set-Content -LiteralPath $ResultFile -Value $summary -Encoding UTF8
  } catch { }
  # ── 5. 自删计划任务，不留残余 ────────────────────────────────────────
  # 【fullstack-dev · 2026-11-15 · 第15轮】自检模式下绝不能走这段：任务名与真跑共用
  # EvoFlow-SelfVerify-Watchdog，一次 selftest 就会把尚未触发的真安装任务删掉。
  if ($TaskName -and -not ($skipInstall -or $skipLaunch)) {
    try {
      schtasks.exe /Delete /TN $TaskName /F 2>&1 | Out-Null
      Write-Log "已删除计划任务: $TaskName"
    } catch { Write-Log "删除计划任务失败（可手动 schtasks /Delete /TN `"$TaskName`" /F）" "WARN" }
  } elseif ($TaskName) {
    Write-Log "[selftest] 保留计划任务 $TaskName（自检不删任务）"
  }
  Write-Log "===== 看门狗结束 exit=$exitCode stage=$stage ====="
}
exit $exitCode

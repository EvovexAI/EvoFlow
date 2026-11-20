# 【fullstack-dev · 2026-11-15 · 第13轮】新增：改码→打包→自安装→自拉起→自唤醒 一键触发端
#   为什么：Agent 自己跑安装必然被 NSIS 的 taskkill /F /T（installer-hooks.nsh
#   EvpKillRunningAppProcesses）连进程树一起杀掉，导致"装完拉起 + 找回对话"无人执行。
#   本脚本只负责**登记一次性计划任务**然后立刻返回；真正的安装/拉起/唤醒由
#   selfverify-watchdog.ps1 在 Task Scheduler 下运行（父进程 svchost，不在杀树内，
#   宿主 powershell.exe 不在 kill-install-orphans 的 python/bash/node 名单内）。
#   用法见同目录 README「本地自验证闭环」一节。
<#
.SYNOPSIS
  一键：（可选）构建 setup.exe → 登记看门狗 → 本进程立刻退出。
.EXAMPLE
  # 常规「装完自己接着验」：只安装+拉起，不唤醒任何人（**本岗默认用法**）
  .\dev-self-verify.ps1 -SkipWake
.EXAMPLE
  # 先构建再安装，同样不唤醒
  .\dev-self-verify.ps1 -Build -SkipWake
.EXAMPLE
  # 只有发版流水线这类跨进程接力才用 -TaskId，且必须同时显式 -AllowWake
  .\dev-self-verify.ps1 -TaskId Task_xxx -AllowWake -Goal "验证 1.3.28 会话标题不再截断"
.NOTES
  【self-evolution-bot · 2026-11-20 · 第99轮 · 模型:deepseek-v4.1-flash-1017】
  用户 2026-11-20 当面定的硬禁令：**验证不许「新开一单 + 唤醒自己」**。
  原话：「不是让你在新开一个任务，然后让他去唤醒，然后去继续去验证……当前哪个对话处理的
  需要去验证的，还是在这个对话上面去推。我不想要唤醒这个方式。」
  所以：需要重启/重装的，用 `-SkipWake`（装完拉起就收工，我自己在当前对话里接着验），
  不要再为了「装完回来复验」去建锚点单再 wake。`-TaskId` 仅保留给发版流水线等
  确有「跨进程接力」需求的场景，不要拿它做本轮验收。
#>
[CmdletBinding()]
param(
  [switch] $Build,
  [switch] $InstallNpmDeps,
  [string] $SetupExe = "",
  [string] $InstallDir = "D:\app\EvoFlow",
  # 【fullstack-dev · 2026-11-15 · 第15轮】本岗 agent_code 已于 16:01 改名（见
  # craft/soul与系统提示词的四处存储与生效时机.md），旧码在名册里查无此岗；默认值不跟着改，
  # 每轮闭环都会在第 4 步 wake 静默失败 —— 第13轮六连败就是这个原因。
  [string] $AgentCode = "self-evolution-bot",
  [string] $TaskId = "",
  [string] $RoundId = "",
  # 【self-evolution-bot · 2026-11-17 · 第28轮】把唤醒投回「用户正看着的那一屏」。
  #   为什么加：原来 wake 只能在 task/duty 两个桶里落会话（resolve_work_session_key 只产这两支），
  #   装完机叫醒我只会另起一个值班对话，用户那句「续不上当前对话」就是这个。
  #   后端第17轮已把 pinned_session_key 接进 engine/runner，本轮补齐接口/wake/CLI 三处接线；
  #   本参数把键从登记端一路落到看门狗的 wake 命令里，闭环才算真能回到同一屏。
  #   取值形如 proactive:<agent_code>:chat:<stamp>；空 = 原行为（自动分桶），不传零影响。
  [string] $SessionKey = "",
  [string] $Goal = "",
  [string] $CliExe = "",
  # 【fullstack-dev · 2026-11-15 · 第13轮】新增：拉起时指回仓库源码后端。不这么做，重装后跑的是
  # 打包 sidecar，被叫醒的 Agent 验到的是安装包里旧 python 代码，本轮改动根本没载入。
  # 传 -BackendDir "" 才切回"验打包件"模式（用于验 Rust / NSIS 侧改动）。
  [string] $BackendDir = "REPO_BACKEND",
  [int]    $DelaySec = 30,
  [int]    $InstallTimeoutSec = 1800,
  [int]    $ReadyTimeoutSec = 240,
  # 【fullstack-dev · 2026-11-15 · 第14轮】新增：看门狗 wake 前先轮询 employees list，此为等待上限。
  # 注意：第13轮 wake 连败 6 次的真因**不是**名册延迟，而是计划任务继承了用户级
  # EVOFLOW_HOME=…\.evoflow-dev（旧库、无 fullstack-dev）；看门狗已显式覆盖该值。
  # 本参数只在 home 正确的前提下才有意义（见 selfverify-watchdog.ps1 同名注释）。
  [int]    $RosterTimeoutSec = 300,
  [int]    $WakeAttempts = 6,
  # 【self-evolution-bot · 2026-11-16 · 第19轮】透传给看门狗：装完拉起就收工，不叫醒岗位。
  # 用途：用户只要「重建+重启」、不想被 Agent 插一轮对话时用。
  # 注意这不是自检模式 —— 安装与拉起照常做，只跳过最后一步 wake。
  [switch] $SkipWake,
  # 【self-evolution-bot · 2026-11-20 · 第99轮 · 模型:deepseek-v4.1-flash-1017】
  # 改了什么：新增显式放行开关；传 -TaskId 但没同时传它，脚本直接 throw，不再默默走 wake。
  # 为什么：用户当面否掉「新开一单 + 唤醒自己」这条验证方式（见 .NOTES）。
  #   光在文档里写禁令不够——本脚本的默认用法就是建锚点单再 wake，光是"存在这条路"，
  #   下一轮我又会照着 EXAMPLE 走回去。把默认改成拦、要接力得显式说明理由。
  [switch] $AllowWake,
  [switch] $DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$OutDir    = Join-Path $RepoRoot "outputs\selfverify"
$StateFile = Join-Path $OutDir "state.json"
$Watchdog  = Join-Path $PSScriptRoot "selfverify-watchdog.ps1"
$TaskName  = "EvoFlow-SelfVerify-Watchdog"
$NsisDir   = Join-Path $RepoRoot "evopanel\src-tauri\target\release\bundle\nsis"

function Say([string] $m, [string] $c = "Cyan") { Write-Host "[self-verify] $m" -ForegroundColor $c }
function Ensure-Dir([string] $p) { if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null } }
# 【self-evolution-bot · 2026-11-16 · 第20轮】抽出 CLI 定位，供「构建前验锚点单」与第 3 步共用同一判据。
function Resolve-Cli {
  foreach ($c in @((Join-Path $RepoRoot "backend\.venv\Scripts\evoflow.exe"),
                   (Join-Path $InstallDir "binaries\evoflow-gateway\tools\evoflow\evoflow.exe"))) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  $w = Get-Command evoflow -ErrorAction SilentlyContinue
  if ($w) { return $w.Source }
  return ""
}

# ── 0. 构建前先验 wake 锚点单未结案（这一步必须排在 -Build 之前）────────────
# 【self-evolution-bot · 2026-11-20 · 第99轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：在下面的锚点校验之前加一道默认拦截 —— 传了 -TaskId 但没传 -AllowWake 就 throw。
# 为什么：用户 2026-11-20 当面否掉「新开一单 + 唤醒自己」的验证方式。本脚本原来的默认用法
#   恰恰就是那条路（.EXAMPLE 第一条即 -TaskId），只在资产里写禁令拦不住下一轮的我。
#   判据：默认拒绝 > 文档提醒。真要跨进程接力（发版流水线）必须显式 -AllowWake 并写明理由。
if ($TaskId -and -not $AllowWake) {
  throw ("-TaskId 已弃用于本岗验收。用户 2026-11-20 定：验证必须在**当前正在处理的对话**里继续做，" +
         "不许新开一单再靠 wake 把自己叫回来。要「装完自己接着验」请用：.\dev-self-verify.ps1 -Build -SkipWake。" +
         "只有确有跨进程接力需求（如发版流水线）才同时传 -AllowWake -TaskId，并在调用处写明为什么不能在本轮验完。")
}
# 【self-evolution-bot · 2026-11-16 · 第20轮】改了什么：登记前用 tasks get 查锚点单状态，
# 已结案/查不到就当场 throw，既不构建也不注册计划任务。
# 为什么：`wake --task-id` 指向已结案单时，看门狗第 4 步 done-guard 返回 skipped=true、exit=0
# 但不投递 → 这一整轮**构建（数分钟）+ 静默安装 + 拉起 + 我断线**全部白跑，
# 只在 watchdog-result.json 留一行 ok=false / stage=wake。
# 第20轮实测：锚点单 2611162002_08d9 已在 20:10 被我提前结案，20:21 登记闭环，20:23:37 撞 done-guard。
# 判据：终态三值（completed/failed/cancelled）一律拒；查不到状态也拒 —— 宁可不跑，不可白跑一轮重启。
# 位置理由：放在 -Build 之前，否则构建已跑完才发现白跑。
if ($TaskId) {
  $taskCli = Resolve-Cli
  if ([string]::IsNullOrWhiteSpace($taskCli)) {
    throw "无法定位 evoflow CLI，不能校验 wake 锚点单 $TaskId（-CliExe 可指定）。"
  }
  $taskStatus = ""
  try {
    $tj = & $taskCli tasks get $TaskId --compact 2>&1 | Out-String
    if ($tj -match '"status"\s*:\s*"([^"]+)"') { $taskStatus = $Matches[1] }
  } catch { $taskStatus = "" }
  if ([string]::IsNullOrWhiteSpace($taskStatus)) {
    throw "无法确认 wake 锚点单 $TaskId 的状态（tasks get 无返回/非 JSON）。wake 需要未结案单，请核对单号，或不传 -TaskId（此时只装机重启、不叫醒）。"
  }
  if ($taskStatus -in @("completed", "failed", "cancelled")) {
    throw "wake 锚点单 $TaskId 已结案（status=$taskStatus）→ 看门狗 wake 必被 done-guard 跳过，整轮构建+安装+重启将白跑。请先新建一张未结案单，或去掉 -TaskId（只装机重启、不叫醒）。"
  }
  Say "wake 锚点单 $TaskId 状态=$taskStatus（未结案，可投递）" "Green"
} elseif (-not $SkipWake) {
  # 【self-evolution-bot · 2026-11-20 · 第99轮 · 模型:deepseek-v4.1-flash-1017】
  # 改了什么：这句原来写「要续轮请传未结案单号」，等于把用户否掉的路径当默认推荐。
  # 改成提示本岗该用的用法，不再怂恿去建锚点单。
  Say "未传 -TaskId：本岗默认就是这种用法（装完拉起即返回，验在当前对话里自己继续）。若只装机不拉起，再加 -SkipWake" "Green"
}

Ensure-Dir $OutDir

if (-not (Test-Path -LiteralPath $Watchdog)) { throw "看门狗脚本缺失: $Watchdog" }
if (-not (Test-Path -LiteralPath $InstallDir)) { throw "安装目录不存在: $InstallDir（-InstallDir 可覆盖）" }

# 【self-evolution-bot · 2026-11-16 · 第28轮】修：-DryRun 的提前返回原本写在状态组装之后
#   （本文件后面的 `if ($DryRun) { ... return }`），而构建在下面第 1 段就真跑了 —— 也就是说
#   「空跑」照样跑满十分钟 npm/Rust 构建。本轮我连做三次空跑，叠出 3 个并发 build:desktop:win
#   进程互相覆写 target 目录（进程表实测 68064/95800/71096 三条同时存在），才发现这个副作用。
#   空跑的定义是"看清将要发生什么"，不该产生任何副作用 —— 故把 Build 在构建段之前摘掉。
if ($DryRun -and $Build) {
  Say "[dryrun] -Build 已跳过：空跑不产生副作用（真要构建请去掉 -DryRun）" "Yellow"
  $Build = $false
}

# ── 1. 可选构建 ────────────────────────────────────────────────────────────
if ($Build) {
  Say "开始构建桌面安装包（npm run build:desktop:win，数分钟）…"
  # 走 local-publish.ps1 而非 build-desktop-installer.bat：后者结尾有 pause，
  # 非交互环境下会把调用方挂住。
  $ps1 = Join-Path $PSScriptRoot "local-publish.ps1"
  $buildArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ps1, "-BuildDesktopInstaller")
  if ($InstallNpmDeps) { $buildArgs += "-InstallNpmDeps" }
  $env:EVOFLOW_SKIP_UPDATER_SIGN = "1"
  Push-Location $RepoRoot
  try {
    & powershell.exe @buildArgs
    if ($LASTEXITCODE -ne 0) { throw "构建失败 exit=$LASTEXITCODE（前置：Node/Rust/uv，见 scripts\maintainer\windows\README.md）" }
  } finally { Pop-Location }
  Say "构建完成" "Green"
}

# ── 2. 定位安装包 ──────────────────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($SetupExe)) {
  $hit = Get-ChildItem -LiteralPath $NsisDir -Filter "*_x64-setup.exe" -File -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTimeDescending | Select-Object -First 1
  if (-not $hit) { throw "未找到安装包（$NsisDir）。先加 -Build，或手动指定 -SetupExe。" }
  $SetupExe = $hit.FullName
}
if (-not (Test-Path -LiteralPath $SetupExe)) { throw "安装包不存在: $SetupExe" }
Say "安装包: $SetupExe  修改时间 $((Get-Item -LiteralPath $SetupExe).LastWriteTime)"

# ── 3. 解析 CLI（看门狗要用它 wake 岗位）───────────────────────────────────
# 【self-evolution-bot · 2026-11-16 · 第20轮】改为复用 Resolve-Cli，两处判据只留一份。
if ([string]::IsNullOrWhiteSpace($CliExe)) { $CliExe = Resolve-Cli }
if ([string]::IsNullOrWhiteSpace($CliExe) -or -not (Test-Path -LiteralPath $CliExe)) {
  throw "无法定位 evoflow CLI（-CliExe 指定）。看门狗需要它来唤醒岗位。"
}
Say "CLI: $CliExe"

# ── 4. 用名册实证挑 CLI 数据目录，再抓旧 Gateway 指纹 ─────────────────────
# 【self-evolution-bot · 2026-11-15 · 第16轮】真因收口：不再盲信继承来的 EVOFLOW_HOME。
# 为什么：本机**用户级**持久 EVOFLOW_HOME=C:\Users\admin\.evoflow-dev（实测 Machine 级为空），
# 计划任务继承注册表里那份用户级值，而该库只有 17 个岗位、不含本岗 —— 这就是第13轮 wake 六连败
# "No employee matching 'fullstack-dev'" 的一半机制。
# 本轮矩阵实测（outputs\selfverify\probe-home-matrix.ps1，同一 CLI 同一时刻，只换 EVOFLOW_HOME）：
#   HOME=.evoflow-dev      → n=17  self-evolution-bot=False
#   HOME=profiles\default  → n=23  self-evolution-bot=True
#   不设 HOME（CLI 默认）   → n=23  self-evolution-bot=True
# 另一半机制：fullstack-dev 在**两个库里都不存在**（本岗 16:01 改名 self-evolution-bot；名册里另
# 有个不相干的 case-fullstack-dev），所以旧报错是"错库 + 错岗位码"两层叠加。第14轮那句"真因是
# 名册装载延迟"、以及"另一份库有 22 个含 fullstack-dev"均已被本轮证伪，勿再照抄。
# 因此判据不写死路径：改成拿 employees list 实证"哪个库认这个 agent_code"，挑中才写进 state
# 交给看门狗 —— 换机器 / 换 profile / 再次改岗名都不用改脚本。
# 附带证伪一条：evoflow CLI **没有 --profile 参数**（全局只有 --config，见 evoflow --help），
# 任何 "employees list --compact --profile default" 都会被 argparse 判为 unrecognized arguments
# 而返回空名册 —— 用这种方式做的"名册校验"永远查不到，等于没校验。
$oldPid = $null; $oldGen = $null
$runtimeHome = $env:EVOFLOW_HOME
$cfg = if ($env:EVOFLOW_CONFIG_DIR) { $env:EVOFLOW_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".evoflow" }
$prof = if ($env:EVOFLOW_PROFILE) { $env:EVOFLOW_PROFILE } else { "default" }
if (-not $runtimeHome) { $runtimeHome = Join-Path $cfg "profiles\$prof" }
$homeCandidates = @($runtimeHome, (Join-Path $cfg "profiles\$prof")) | Where-Object { $_ } | Select-Object -Unique
$needle = 'agent_code":"' + $AgentCode + '"'
$homeVerified = ""
foreach ($hp in $homeCandidates) {
  if (-not (Test-Path -LiteralPath $hp)) { continue }
  try {
    $env:EVOFLOW_HOME = $hp
    $ls = & $CliExe employees list --compact 2>&1 | Out-String
    if ($ls -like "*$needle*") { $homeVerified = $hp; break }
    Say "该库名册里没有 $AgentCode，换下一个候选: $hp" "Yellow"
  } catch { Say "查名册失败（$hp）: $($_.Exception.Message)" "Yellow" }
}
if (-not $homeVerified) {
  throw "候选数据目录的名册里都查不到岗位 $AgentCode：$($homeCandidates -join ' | ')。请先确认该岗位已雇佣（evoflow employees list），否则看门狗 wake 必定失败。"
}
if ($homeVerified -ne $runtimeHome) { Say "数据目录改用 $homeVerified（继承值 $runtimeHome 不认这个岗）" "Green" }
$runtimeHome = $homeVerified
$env:EVOFLOW_HOME = $runtimeHome
Say "CLI 数据目录: $runtimeHome（名册已实证含 $AgentCode）"
$rtCandidates = @()
if ($runtimeHome) { $rtCandidates += (Join-Path $runtimeHome "backend-runtime.json") }
$rtCandidates += (Join-Path $cfg "profiles\$prof\backend-runtime.json")
foreach ($rp in $rtCandidates) {
  if (-not (Test-Path -LiteralPath $rp)) { continue }
  try {
    $j = Get-Content -LiteralPath $rp -Raw -Encoding UTF8 | ConvertFrom-Json
    $oldPid = $j.pid; $oldGen = $j.generation
    Say "旧 Gateway: pid=$oldPid generation=$oldGen baseUrl=$($j.baseUrl)"
    break
  } catch { Say "读取 runtime json 失败: $($_.Exception.Message)" "Yellow" }
}
if (-not $oldPid) { Say "未取到旧 Gateway pid（首次运行？看门狗将只校验 /health）" "Yellow" }

# ── 5. goal 兜底文案 ───────────────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($Goal)) {
  $Goal = "本地自验证闭环：客户端已用新安装包重装并重启（安装包 $(Split-Path -Leaf $SetupExe)）。" +
          "请读 outputs\selfverify\watchdog.log 与 watchdog-result.json 确认安装/唤醒各阶段结果，" +
          "然后在当前运行环境实测本轮改动是否生效（先验接线再验分支），按验收步骤逐条给结论并结案。"
}

# ── 6. 解析后端目录 + 写 state ─────────────────────────────────────────────
# 【fullstack-dev · 2026-11-15 · 第13轮】REPO_BACKEND 哨兵 → 仓库 backend 绝对路径；
# 无效路径直接置空并提示，避免看门狗那边拿个假目录当真理仍跑打包件。
$resolvedBackend = $BackendDir
if ($resolvedBackend -eq "REPO_BACKEND") { $resolvedBackend = Join-Path $RepoRoot "backend" }
if ($resolvedBackend) {
  if (-not (Test-Path -LiteralPath (Join-Path $resolvedBackend "packages\harness\evoflow"))) {
    Say "backendDir 无效（缺 packages\harness\evoflow）: $resolvedBackend → 改跑打包后端" "Yellow"
    $resolvedBackend = ""
  } else {
    Say "后端源码: $resolvedBackend（重启后载入的是仓库改动，非安装包内旧代码）"
  }
} else {
  Say "backendDir 为空 → 将运行安装包自带后端（只适合验 Rust/前端产物改动）" "Yellow"
}
$state = [ordered]@{
  installDir        = $InstallDir
  setupExe          = $SetupExe
  agentCode         = $AgentCode
  taskId            = $TaskId
  roundId           = $RoundId
  # 【第28轮】透传给看门狗：wake 时带上 --session-key，投回用户正看着的那一屏
  sessionKey        = $SessionKey
  goal              = $Goal
  cliExe            = $CliExe
  evoflowHome       = $runtimeHome
  taskName          = $TaskName
  installArgs       = @("/S")
  installTimeoutSec = $InstallTimeoutSec
  readyTimeoutSec   = $ReadyTimeoutSec
  rosterTimeoutSec  = $RosterTimeoutSec
  wakeAttempts      = $WakeAttempts
  # 【self-evolution-bot · 2026-11-16 · 第19轮】只在显式给了 -SkipWake 时才写这个键，
  # 不写 false —— 看门狗读的是 $state.skipWake，缺键与 false 同效，但少一行噪声。
  skipWake          = [bool]$SkipWake
  oldGatewayPid     = $oldPid
  oldGeneration     = $oldGen
  repoRoot          = $RepoRoot
  backendDir        = $resolvedBackend
  createdAt         = (Get-Date).ToString("o")
}
if ($DryRun) {
  Say "[dryrun] 将写入 $StateFile" "Yellow"
  $state | ConvertTo-Json -Depth 4 | Write-Host
  Say "[dryrun] 将注册计划任务 $TaskName，$DelaySec 秒后运行 $Watchdog" "Yellow"
  return
}
$state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFile -Encoding UTF8
Say "state 已写入: $StateFile"

# ── 7. 注册一次性计划任务（关键：脱离本进程树，才能在杀死我之后继续）────────
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Watchdog`" -StateFile `"$StateFile`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds($DelaySec)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Say "计划任务已注册: $TaskName（$DelaySec 秒后触发，任务宿主=svchost，不会随本机进程树被杀）" "Green"

Say ""
Say "===== 接下来会发生什么（重要）=====" "Yellow"
Say "1) $DelaySec 秒后看门狗启动，静默安装 $SetupExe"
Say "2) 安装器会强制结束 EvoFlow 桌面 + Gateway + 本仓相关 python/bash/node —— 也就是**我会当场断线**，本轮回复到此为止"
Say "3) 装完自动拉起 $(Join-Path $InstallDir 'evoflow.exe')，等 backend-runtime.json 换代且 /health 通过"
# 【self-evolution-bot · 2026-11-20 · 第99轮 · 模型:deepseek-v4.1-flash-1017】第4步原来无条件
# 声称「把我叫醒」，可 -SkipWake / 未传 -TaskId 时根本不 wake —— 文案与行为不一致会让下一轮的
# 我照这句话去等一次不会到来的唤醒。改成按实际分支打印。
if ($SkipWake -or -not $TaskId -or -not $AllowWake) {
  Say "4) 不唤醒任何人（本轮验证由我在当前对话里继续做）：装完拉起即收工"
} else {
  Say "4) 用 '$CliExe employees wake $AgentCode --task-id $TaskId --resume-round' 叫醒岗位续轮"
}
Say "日志: $OutDir\watchdog.log    结果: $OutDir\watchdog-result.json"
Say "取消（在安装开始前）: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"

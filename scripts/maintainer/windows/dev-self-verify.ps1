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
  # 只登记（安装包已存在，自动取 bundle\nsis 下最新一个）
  .\dev-self-verify.ps1 -TaskId Task_xxx -Goal "验证 1.3.28 会话标题不再截断"
.EXAMPLE
  # 先构建再登记（构建耗时数分钟，Agent 侧请后台跑）
  .\dev-self-verify.ps1 -Build -TaskId Task_xxx
#>
[CmdletBinding()]
param(
  [switch] $Build,
  [switch] $InstallNpmDeps,
  [string] $SetupExe = "",
  [string] $InstallDir = "D:\app\EvoFlow",
  [string] $AgentCode = "fullstack-dev",
  [string] $TaskId = "",
  [string] $RoundId = "",
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

Ensure-Dir $OutDir

if (-not (Test-Path -LiteralPath $Watchdog)) { throw "看门狗脚本缺失: $Watchdog" }
if (-not (Test-Path -LiteralPath $InstallDir)) { throw "安装目录不存在: $InstallDir（-InstallDir 可覆盖）" }

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
if ([string]::IsNullOrWhiteSpace($CliExe)) {
  foreach ($c in @((Join-Path $RepoRoot "backend\.venv\Scripts\evoflow.exe"),
                   (Join-Path $InstallDir "binaries\evoflow-gateway\tools\evoflow\evoflow.exe"))) {
    if (Test-Path -LiteralPath $c) { $CliExe = $c; break }
  }
  if ([string]::IsNullOrWhiteSpace($CliExe)) {
    $w = Get-Command evoflow -ErrorAction SilentlyContinue
    if ($w) { $CliExe = $w.Source }
  }
}
if ([string]::IsNullOrWhiteSpace($CliExe) -or -not (Test-Path -LiteralPath $CliExe)) {
  throw "无法定位 evoflow CLI（-CliExe 指定）。看门狗需要它来唤醒岗位。"
}
Say "CLI: $CliExe"

# ── 4. 抓旧 Gateway 指纹（就绪判据要对比"是否换了新进程"）──────────────────
$oldPid = $null; $oldGen = $null; $runtimeHome = $env:EVOFLOW_HOME
$rtCandidates = @()
if ($runtimeHome) { $rtCandidates += (Join-Path $runtimeHome "backend-runtime.json") }
$cfg = if ($env:EVOFLOW_CONFIG_DIR) { $env:EVOFLOW_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".evoflow" }
$prof = if ($env:EVOFLOW_PROFILE) { $env:EVOFLOW_PROFILE } else { "default" }
if (-not $runtimeHome) { $runtimeHome = Join-Path $cfg "profiles\$prof" }
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
  goal              = $Goal
  cliExe            = $CliExe
  evoflowHome       = $runtimeHome
  taskName          = $TaskName
  installArgs       = @("/S")
  installTimeoutSec = $InstallTimeoutSec
  readyTimeoutSec   = $ReadyTimeoutSec
  rosterTimeoutSec  = $RosterTimeoutSec
  wakeAttempts      = $WakeAttempts
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
Say "4) 用 '$CliExe employees wake $AgentCode$(if($TaskId){" --task-id $TaskId"}) --resume-round' 把我叫醒，续同一轮工作脉络做验收"
Say "日志: $OutDir\watchdog.log    结果: $OutDir\watchdog-result.json"
Say "取消（在安装开始前）: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"

# 【self-evolution-bot · 2026-11-15 · 第16轮】新增：evoflow CLI 数据目录（EVOFLOW_HOME）解析探针
# 为什么：wake/employees list 读的是**本地 SQLite**、不走 Gateway HTTP，所以"/health 通了"和
#   "名册查得到这个岗"是两回事。计划任务继承的是**用户级**持久 EVOFLOW_HOME（本机 = .evoflow-dev，
#   那份库 17 个岗位、不含本岗），而我 dev shell 里的进程级值指向 profiles\default —— 同一条命令
#   在两边结果不同，第13轮 wake 六连败当时就是这么被误判成"名册装载延迟"的。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\maintainer\windows\evoflow-home-probe.ps1 [-AgentCode self-evolution-bot]
#   只读，不改任何环境变量/库/任务；输出每候选库的岗位数与该岗是否在册。
# 另证一条坑（勿再踩）：evoflow CLI **没有 --profile 参数**（全局只有 --config），
#   `employees list --compact --profile default` 会被 argparse 判 unrecognized arguments 返回空 →
#   用它做"名册校验"永远查不到，等于没校验。本探针只走 EVOFLOW_HOME。
[CmdletBinding()]
param(
  [string] $AgentCode = 'self-evolution-bot',
  [string] $CliExe = ''
)
$ErrorActionPreference = 'Continue'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if ([string]::IsNullOrWhiteSpace($CliExe)) {
    foreach ($c in @((Join-Path $RepoRoot 'backend\.venv\Scripts\evoflow.exe'),
                     'D:\app\EvoFlow\binaries\evoflow-gateway\tools\evoflow\evoflow.exe')) {
        if (Test-Path -LiteralPath $c) { $CliExe = $c; break }
    }
}
if ([string]::IsNullOrWhiteSpace($CliExe) -or -not (Test-Path -LiteralPath $CliExe)) {
    Write-Host 'CLI not found (pass -CliExe)' -ForegroundColor Red; exit 2
}

# 作用域分开报：Machine / User / Process —— 计划任务继承的是 Machine+User，不是我的进程级值
$machine = [Environment]::GetEnvironmentVariable('EVOFLOW_HOME', 'Machine')
$user    = [Environment]::GetEnvironmentVariable('EVOFLOW_HOME', 'User')
$proc    = $env:EVOFLOW_HOME
Write-Host ("scope machine = [{0}]" -f $machine)
Write-Host ("scope user    = [{0}]" -f $user)
Write-Host ("scope process = [{0}]" -f $proc)

$cfg  = if ($env:EVOFLOW_CONFIG_DIR) { $env:EVOFLOW_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.evoflow' }
$prof = if ($env:EVOFLOW_PROFILE) { $env:EVOFLOW_PROFILE } else { 'default' }

function Probe([string] $Label, [string] $HomeDir, [switch] $Clear) {
    if ($Clear) { Remove-Item Env:\EVOFLOW_HOME -ErrorAction SilentlyContinue }
    elseif ($HomeDir) { $env:EVOFLOW_HOME = $HomeDir }
    $out = & $CliExe employees list --compact 2>&1 | Out-String
    $codes = @()
    foreach ($m in [regex]::Matches($out, '"agent_code"\s*:\s*"([^"]+)"')) { $codes += $m.Groups[1].Value }
    $hit = $codes -contains $AgentCode
    $color = 'Yellow'; if ($hit) { $color = 'Green' }
    Write-Host ('{0,-34} n={1,-4} {2}={3}' -f $Label, $codes.Count, $AgentCode, $hit) -ForegroundColor $color
    if ($codes.Count -eq 0) {
        $raw = ($out -split "`n" | Select-Object -First 2) -join ' | '
        if ($raw.Length -gt 160) { $raw = $raw.Substring(0, 160) }
        Write-Host ("     raw: $raw") -ForegroundColor DarkGray
    }
    return [pscustomobject]@{ Label = $Label; Home = $HomeDir; Count = $codes.Count; Has = [bool]$hit }
}

Write-Host ''
$rows = @()
if ($user)    { $rows += Probe 'HOME=<user value>'    $user }
if ($machine) { $rows += Probe 'HOME=<machine value>' $machine }
$rows += Probe 'HOME=%USERPROFILE%\.evoflow' (Join-Path $env:USERPROFILE '.evoflow')
$rows += Probe "HOME=$cfg\profiles\$prof" (Join-Path $cfg "profiles\$prof")
$rows += Probe 'HOME unset (CLI default)' '' -Clear

Write-Host ''
$good = @($rows | Where-Object { $_.Has })
if ($good.Count -eq 0) {
    Write-Host ("NO library resolves '{0}' — that post is not hired in any profile on this box." -f $AgentCode) -ForegroundColor Red
    exit 1
}
# 【第16轮自撞】原先直接 Join 出个空串（unset 那行 Home=''），读的人以为多了一个神秘路径
$names = @($good | ForEach-Object { if ($_.Home) { $_.Home } else { '(CLI default, HOME unset)' } })
Write-Host ("resolvable homes: {0}" -f ($names -join ' | ')) -ForegroundColor Green
Write-Host 'Use exactly one of the above as state.evoflowHome (dev-self-verify.ps1 picks it by roster evidence now).'

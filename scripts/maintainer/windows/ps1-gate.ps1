# 【self-evolution-bot · 2026-11-15 · 第16轮】新增：本地自验证闭环脚本的**接线**门禁
# 为什么：第15轮我"加了自检模式"，实际只写了 5 处使用点、漏了 param 声明 —— 命令行传
#   -SkipInstall 直接报"找不到参数"，自检模式从未真机可用；同轮加的 $wakeOutcome 分型有 5 处
#   赋值却一处都没写进 watchdog-result.json，被叫醒的岗位读到的仍是分不清 delivered/busy/skipped
#   的 ok=true。这类缺陷**语法门禁照不出来**（errs=0 全绿），只有断言"使用点↔声明↔落盘"对得上才照得出。
# 本脚本 = outputs 里三份一次性门禁（check-gate / gate15 / gate-check）的合并替代，用完即删它们。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\maintainer\windows\ps1-gate.ps1
#   退出码 0 = 全绿；非 0 = 有 FAIL，勿交接。
[CmdletBinding()]
param([switch] $Quiet)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$targets = @('selfverify-watchdog.ps1', 'dev-self-verify.ps1')
# 【self-evolution-bot · 2026-11-15 · 第16轮】改成**自动扫全目录**，不再靠手写数组：原先 $extra 写死
# 两个文件名，新增 .ps1 若忘了登记就**静默不过门禁**（门禁自身留了个洞）。本目录所有 .ps1 一律查 BOM+语法；
# 第 2 节那些"接线"断言只针对 $targets 这两个闭环脚本。
$allPs1 = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File | ForEach-Object { $_.Name }) | Sort-Object
$extra = @($allPs1 | Where-Object { $targets -notcontains $_ })

$script:fail = 0
function Chk([string] $name, [bool] $cond, [string] $detail = '') {
    if ($cond) { if (-not $Quiet) { Write-Host "[OK]   $name" } }
    else { $script:fail = 1; Write-Host "[FAIL] $name  $detail" -ForegroundColor Red }
}

# ── 1. 语法 + BOM
# 【self-evolution-bot · 2026-11-15 · 第16轮】BOM 判据收紧为"**含非 ASCII 才强制**"。
# 为什么改：本门禁第一版写死"所有 .ps1 都要 BOM"，自动扫全目录后立刻把
#   run-installed-with-dev-gateway.ps1（实测非 ASCII 行数 = 0、无 BOM、parse 通过）判成 FAIL。
#   GBK 误解码只发生在**文件里有非 ASCII 字节**时，纯 ASCII 加 BOM 无用、不加也没事 ——
#   一条会误报的规则比没有规则更糟（下一个人会为了消红去改无关文件）。实测分布：本目录 11 个 .ps1，
#   9 个含非 ASCII（全部已带 BOM），2 个纯 ASCII（一个带一个不带，都正常）。
foreach ($f in ($targets + $extra)) {
    $p = Join-Path $dir $f
    $b = [IO.File]::ReadAllBytes($p)
    $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
    $body = [Text.Encoding]::UTF8.GetString($b)
    $nonAscii = (@([char[]] $body | Where-Object { [int]$_ -gt 127 })).Count
    $bomNeeded = ($nonAscii -gt 0)
    $bomMsg = "非ASCII=$nonAscii 需BOM=$bomNeeded 实有BOM=$hasBom"
    Chk "$f BOM" (($bomNeeded -and $hasBom) -or (-not $bomNeeded)) $bomMsg
    if ($hasBom -and -not $bomNeeded -and -not $Quiet) { Write-Host "       note: 纯 ASCII，BOM 可有可无" -ForegroundColor DarkGray }
    $tok = $null; $err = $null
    [void][Management.Automation.Language.Parser]::ParseFile($p, [ref] $tok, [ref] $err)
    Chk "$f parse" ($err.Count -eq 0) "errs=$($err.Count)"
    foreach ($e in $err) { Write-Host "     L$($e.Extent.StartLineNumber): $($e.Message)" -ForegroundColor Red }
    if (-not $Quiet) { Write-Host "       tokens=$($tok.Count)" -ForegroundColor DarkGray }
}

# README 是文档，带 BOM 会在 markdown 渲染出 U+FEFF，必须为 False
$rd = Join-Path $dir 'README.md'
if (Test-Path -LiteralPath $rd) {
    $rb = [IO.File]::ReadAllBytes($rd)
    # 【第16轮自撞】原先写成 `Chk '...' -not (...)`：命令参数位上的 -not 会被 PowerShell 当
    # **参数名**去解析（不是取反），条件根本没执行 → README 明明无 BOM 仍报 FAIL。取反必须先落变量。
    $rdHasBom = ($rb.Length -ge 3 -and $rb[0] -eq 0xEF -and $rb[1] -eq 0xBB -and $rb[2] -eq 0xBF)
    $rdOk = -not $rdHasBom
    Chk 'README.md 无 BOM' $rdOk
}

$wdRaw = (Get-Content -LiteralPath (Join-Path $dir 'selfverify-watchdog.ps1') -Encoding UTF8)
$tvRaw = (Get-Content -LiteralPath (Join-Path $dir 'dev-self-verify.ps1') -Encoding UTF8)

# 【self-evolution-bot · 2026-11-15 · 第16轮】断言前先剥注释。为什么：本门禁自己第一次跑就撞上——
# "无写死 --profile" 命中了我写在**注释里**的那句证伪说明，把没毛病的脚本判成 FAIL。同理，正向断言
# （"含 wait-roster 阶段"、"EVOFLOW_HOME = $RuntimeHome"）也能被注释糊弄过去 → 注释里提一句就算"通过"，
# 那这条门禁等于没有。剥法：整行注释丢空、行尾注释截掉（naive：字符串里带 " #" 会被截，本仓这三个脚本没有）。
function Get-CodeText($lines) {
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($ln in @($lines)) {
        $t = $ln.TrimStart()
        if ($t.StartsWith('#')) { $out.Add(''); continue }
        $m = [regex]::Match($ln, '(?<=\s)#')
        if ($m.Success) { $out.Add($ln.Substring(0, $m.Index)) } else { $out.Add($ln) }
    }
    $out -join "`n"
}
$wd = Get-CodeText $wdRaw
$tv = Get-CodeText $tvRaw

# ── 2. 接线断言：被用的变量/参数必须有声明，算出来的值必须真的落盘
$wdParamBlock = ([regex]::Match($wd, '(?s)param\((.*?)\r?\n\)\r?\n')).Groups[1].Value

Chk 'watchdog: -SkipInstall/-SkipLaunch 已在 param 声明' (
    $wdParamBlock -match '\[switch\]\s*\$SkipInstall' -and $wdParamBlock -match '\[switch\]\s*\$SkipLaunch'
) '只在正文使用=命令行传不进来自检模式'
Chk 'watchdog: 自检开关确实被分支使用' (
    ([regex]::Matches($wd, '\$skipInstall|\$skipLaunch')).Count -ge 4
)

# wakeOutcome 既要有赋值，也要进 result.json —— 否则分型等于没做
$woAssign = ([regex]::Matches($wd, '\$wakeOutcome\s*=')).Count
Chk "watchdog: wakeOutcome 有赋值 (n=$woAssign)" ($woAssign -ge 5)
Chk 'watchdog: wakeOutcome 写进 watchdog-result.json' (
    ($wd -match 'summary\s*=\s*@.\{[^}]*wakeOutcome\s*=' -or $wd -match '\$summary\s*=.*wakeOutcome')
) '被叫醒的岗位读不到分型 → 静默假阳性'
Chk 'watchdog: selftest 标记写进 result.json' ($wd -match '\$summary\s*=.*selftest')

# 数据目录必须显式覆盖继承值，且值来自 state（不是写死路径）
Chk 'watchdog: EVOFLOW_HOME 用 state 权威值覆盖' ($wd -match '\$env:EVOFLOW_HOME\s*=\s*\$RuntimeHome')
Chk 'watchdog: RuntimeHome 取自 state.evoflowHome' ($wd -match '\$RuntimeHome\s*=\s*\[string\]\$state\.evoflowHome')
# 三道闸门齐备：换代/名册/投递面（缺任一道第13~16轮都实测断过）
foreach ($g in @('wait-roster', 'wait-delivery-gate')) { Chk "watchdog: 含 $g 阶段" ($wd -match $g) }
Chk 'watchdog: 投递面探的是 /api/proactive/status（不是被豁免的 /health）' ($wd -match '/api/proactive/status')

# 触发端：必须实证挑库（拿名册验岗位存在），并把结果写进 state 交给看门狗
Chk 'trigger: 用 employees list 实证数据目录' ($tv -match 'employees.*list.*--compact' -and $tv -match 'homeVerified')
Chk 'trigger: 挑中的库写进 state.evoflowHome' ($tv -match 'evoflowHome\s*=\s*\$runtimeHome')
Chk 'trigger: 默认岗位码是本岗现用码' ($tv -match '\$AgentCode\s*=\s*"self-evolution-bot"')
Chk 'trigger: 无写死 --profile（CLI 全局只有 --config，写了会被 argparse 拒）' ($tv -notmatch '--profile')
Chk 'watchdog: 无写死 --profile' ($wd -notmatch '--profile')

if ($script:fail -eq 0) { Write-Host 'GATE_PASS=1' -ForegroundColor Green } else { Write-Host 'GATE_PASS=0' -ForegroundColor Red }
exit $script:fail

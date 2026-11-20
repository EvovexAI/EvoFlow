# Maintainer Windows scripts

Local desktop release helpers for this public repo (`EvovexAI/EvoFlow`). Contributor day-to-day: `../windows/` and `../../README.md`.

**升版本清单（VERSION / 三份说明 / tag）见仓库根 [RELEASE.md](../../../RELEASE.md)。** 下文是 Windows 本地打包与上传。

## Must-have for a public desktop release

1. 按 [RELEASE.md](../../../RELEASE.md) 完成版本同步 + `CHANGELOG` + `PRODUCT-NOTES-x.y.z.md` + `latest.json` changelog。
2. Copy `local-publish.env.example` → `local-publish.env` (gitignored). Set `GITHUB_TOKEN` if `gh` is not available.
3. One-shot:

```powershell
Set-Location <repo-root>
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintainer\windows\release-evopanel-public.ps1 `
  -Version 1.0.2 `
  -ProductNotesPath .\scripts\maintainer\windows\release-notes\PRODUCT-NOTES-1.0.2.md `
  -PushGitTag
```

**双击只打安装包（不上传）**：[`build-desktop-installer.bat`](./build-desktop-installer.bat)  
（等价于下面的 `-BuildDesktopInstaller`；可选参数 `-InstallNpmDeps`。）  
默认 `EVOFLOW_SKIP_UPDATER_SIGN=1`，避免本机 `updater-signing.key` 弹出 Password 卡住；正式发版仍走 CI 签名。

## 本地自验证闭环（Agent 自己改码 → 自己重装 → **在当前对话里**接着验收）

【self-evolution-bot · 2026-11-20 · 第99轮 · 模型:deepseek-v4.1-flash-1017】**硬禁令**（用户当面定）：
验证不许「新开一单 + 唤醒自己」。需要重装/重启这类自己做不了的动作，用 `-SkipWake` 让看门狗
只装只拉，装完**我自己在当前正在处理的对话里继续验**；不要为此建锚点单再 `employees wake` 把自己叫回来。
脚本已改成：传 `-TaskId` 而不传 `-AllowWake` 直接 throw（默认拦，不靠文档提醒）。

【fullstack-dev · 2026-11-15 · 第13轮】新增 `dev-self-verify.ps1` + `selfverify-watchdog.ps1`。

**为什么需要两个脚本**：NSIS 安装器（`windows/installer-hooks.nsh` 的
`EvpKillRunningAppProcesses`）会 `taskkill /F /T` 桌面父进程树，`kill-install-orphans.ps1`
还会按「CommandLine 含安装目录」扫杀 python/bash/node。Agent 的 gateway + bash 正在这张网里，
所以**发起方必死在安装中途**，"装完拉起"没人做。解法：把后续步骤交给
Task Scheduler 拉起的一次性任务（宿主 `svchost` → `powershell.exe`，既不在进程树内，也不在杀名单内）。

```powershell
# 1) 先空跑看清将要发生什么（不注册任务、不安装）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintainer\windows\dev-self-verify.ps1 `
  -DryRun -SkipWake

# 2) 实测（本岗默认用法）：构建安装包 + 30 秒后"重装→拉起"，**不唤醒任何人**
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintainer\windows\dev-self-verify.ps1 `
  -Build -SkipWake

# 3) 反悔（只在 DelaySec 窗口内有效）
Unregister-ScheduledTask -TaskName EvoFlow-SelfVerify-Watchdog -Confirm:$false

# 4) 【第16轮】自检模式：客户端已经起来了、只想验后半段（就绪→名册→投递面→wake），
#    不重装、不双开抢 sidecar.lock —— 用户已手动重启时用这条，别浪费时间再装一遍
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintainer\windows\selfverify-watchdog.ps1 `
  -SkipInstall -SkipLaunch

# 5) 【第16轮】排查 wake 报"查无此岗"：先看哪个数据目录认这个岗（只读，不改环境）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintainer\windows\evoflow-home-probe.ps1 `
  -AgentCode self-evolution-bot
```

> 仍保留 wake 能力，但只给**确有跨进程接力需求**的场景（如发版流水线上的无人值守验收）：
> `-TaskId Task_xxx -AllowWake -Goal "..."`，并在调用处写明为什么不能在本轮对话里验完。

| 参数 | 默认 | 说明 |
|---|---|---|
| `-Build` | 关 | 先跑 `local-publish.ps1 -BuildDesktopInstaller`（复用 `-InstallNpmDeps`）；不加则取 `bundle\nsis` 下最新 setup.exe |
| `-TaskId` / `-RoundId` | 空 | **本岗验收不要传**（用户 2026-11-20 定：验证在当前对话里继续做）。仅发版流水线这类跨进程接力用，且必须同时传 `-AllowWake`，否则脚本直接 throw |
| `-AllowWake` | 关 | 显式放行 wake 的开关。只传 `-TaskId` 不传它 → 当场报错退出，不会默默走唤醒 |
| `-SkipWake` | 关 | 只装只拉、不叫醒任何人。**本岗需要重装时用这个**（配 `-Build -SkipWake`） |
| `-InstallDir` | `D:\app\EvoFlow` | 被安装目录；安装器按此路径扫杀孤儿进程 |
| `-DelaySec` | 30 | 留给你收尾/落盘的时间窗；此间可 `Unregister-ScheduledTask -TaskName EvoFlow-SelfVerify-Watchdog -Confirm:$false` 取消 |
| `-ReadyTimeoutSec` | 240 | 等 `backend-runtime.json` 换代（pid 变或 generation 变大）**且** `GET /health` 通过 |
| `-WakeAttempts` | 6 | wake 失败重试次数（退避递增 10→25→40…封顶 60s；仅名册/状态类错误重试） |
| `-RosterTimeoutSec` | 300 | **wake 前等目标岗位在册的上限**。它只防"gateway 刚起、名册有延迟"这一种；真因若是数据目录指错库 / 岗位码已改名（第13、16轮实测），**等多久都没用** —— 所以触发端改为登记时就实证挑库，不认这个岗就直接拒 |
| `-AgentCode` | `self-evolution-bot` | 要叫醒的岗位。**岗位改名后这里必须跟着改**，否则闭环前 3 步全绿、第 4 步永远 `No employee matching` |
| `-SkipInstall` / `-SkipLaunch` | 关 | **看门狗**的参数：跳过安装 / 跳过拉起，只验后半段（自检模式）。`dev-self-verify.ps1` 不认这两个，别往触发端传 |
| `-StateFile` | `outputs\selfverify\state.json` | **看门狗**可指定别的 state；路径含安装目录时注意别进命令行 |

`-TaskId` 若真要用于跨进程接力，它必须指向一张**还没结案**的单：CLI 的 done-guard 对已结案单返回 `skipped=true`（`exit=0` 但没投递），
第16轮实测就是这样白跑一轮 —— 要验 wake 先建单或复用未结单。（本岗日常验收不走这条路，见上方硬禁令。）

看门狗**只从 `outputs\selfverify\state.json` 读路径与 goal**，安装目录字串不进命令行，
否则会被 `kill-install-orphans.ps1` 的 CommandLine 匹配连带杀掉（goal 里若含安装目录也会被剥成 `<install-dir>`）。
每步结果落 `outputs\selfverify\watchdog.log` 与 `watchdog-result.json`，醒来的 Agent 先读这两个文件再验收。

**`watchdog-result.json` 的 `wakeOutcome` 取值**（第15轮定分型、第16轮才真正接进文件）——
`exit=0` / `ok=true` 单独看**不足以**说明被叫醒，必须辨型：

| 值 | 含义 | 该怎么办 |
|---|---|---|
| `delivered` | 真投递成功 | 正常，等这轮醒来 |
| `skipped-already-done` | `--task-id` 引的是**已结案**的单，done-guard 直接跳过（`ok=true` 但什么都没投） | 换一张未结案的单号；这不是 bug |
| `busy-wiring-proven` | 岗位寻址通、请求已到达，只是当轮在忙 | 接线判通，投递未证 |
| `dryrun-not-attempted` | `-DryRun`，只打印命令没真投 | 别记成功 |
| `failed` / `not-attempted` | 非名册类错误 / 压根没走到 wake | 看 `watchdog.log` 尾部原文 |

同文件还有 `selftest: true/false` —— 为真表示这轮是自检模式，**没证明静默安装与拉起**，只有四步全过的
非 selftest 轮次才算端到端闭环通。自检模式下**不会删计划任务**（任务名与真跑共用，一次 selftest 会把
尚未触发的真任务误删）。

**门禁**：本目录 `.ps1` 一律过 `ps1-gate.ps1`（BOM/语法 + 上述接线断言，共 30 余项，`GATE_PASS=1` 才算过）。
BOM 判据是「**含非 ASCII 才强制**」——纯 ASCII 脚本无 BOM 也安全，写死"一律要有"会误报（第16轮自撞过）。

**实测结论**：
| 轮次 | 安装 | 拉起 | Gateway 换代 | wake |
|---|---|---|---|---|
| 第13轮 07:45（gen 319→320） | ✅ | ✅ | ✅ `/health` 200 | ❌ 连投 6 次 `No employee matching 'fullstack-dev'` |
| 第15轮 13:35（gen 327→328） | ✅ | ✅ | ✅ 三条件+名册在册 | ❌ `dispatch failed HTTP 503`（投递面空窗） |
| 第16轮 19:11（gen 331→332） | ✅ | ✅ | ✅ | ❌ 用的是改名前的旧岗位码 |
| **第16轮 19:17 自检模式** | 跳过 | 跳过 | ✅ | ✅ **`wakeOutcome=delivered`，exit=0**（14s 内四步全过） |

**wake 失败的真因是两层叠加**（第14轮只归对一半、第16轮复算补齐）：
1. **读错数据目录**。`evoflow employees list / wake` 读的是**本地 SQLite**（`ProactiveRepository.list_roles`
   → `get_db()`），**不走 Gateway HTTP**，所以「`/health` 通」与「名册查得到岗位」毫不相干。
   本机**用户级**持久 `EVOFLOW_HOME = C:\Users\admin\.evoflow-dev`（实测机器级为空），Task Scheduler 取注册表
   用户级值、不取 Agent dev shell 的进程级值 → 看门狗读的是那份旧库。第16轮矩阵实测（同一 CLI 同一时刻只换 HOME，
   见 `evoflow-home-probe.ps1`）：`.evoflow-dev` → **17 岗不含本岗**；`profiles\default` → **23 岗含本岗**；
   **不设 HOME 走 CLI 默认也是 23**。另有一份陷阱：`%USERPROFILE%\.evoflow`（裸目录）是 **1 岗近空库**。
2. **岗位码本身已失效**。`fullstack-dev` 在本机**两个库里都不存在**（11-15 16:01 改名为 `self-evolution-bot`；
   名册里那个不相干的 `case-fullstack-dev` 是另一个岗）。所以只修第 1 层、码不改，照样六连败。

**修法（都已落脚本，纯脚本不需重启）**：
- 触发端 `dev-self-verify.ps1` 第 4 步**不再盲信继承值**：拿 `employees list` 实证「哪个库认这个 `agent_code`」，
  挑中才写进 `state.evoflowHome`；候选全不认则**登记阶段就 throw**，不等 30 秒后让看门狗白跑一趟。
  判据不写死路径 → 换机器 / 换 profile / 再次改岗名都不用改脚本。
- 看门狗用 `state.evoflowHome` 显式覆盖 `$env:EVOFLOW_HOME`；`wait-roster`（`-RosterTimeoutSec`）与
  `wait-delivery-gate`（探 `/api/proactive/status`，**不是**被 startup_gate 豁免的 `/health`）只有在 home 钉对后才有意义。
- **`evoflow` CLI 没有 `--profile` 参数**（全局只有 `--config`）。写成 `employees list --compact --profile default`
  会被 argparse 判 `unrecognized arguments` 返空 —— 用它做名册校验等于没校验，两脚本已加门禁禁止此写法。
**已知边界**：① 静默安装 `/S` 若命中需提权的写入路径会失败（看门狗 exit=1 并记日志），本机默认装到 `D:\app` 不需要；
② 只改后端 python 时代价太大——那种改动用 `run-installed-with-dev-gateway.ps1` 直接让已装客户端连仓库源码，重启 gateway 即可，不必走本闭环；
③ wake 目前只能**另起一个值班对话**，回不到发起时的原对话（`dispatch_task_fire_and_forget` 无 `session_key` 形参，会话键在 `runner._process_role` 现算）；
   原对话的键已存在 Tasks `source_ref` 里，要续回去需把 session_key 透传下去 —— 属运行时代码改动，另行处理。

Or piece-wise via `local-publish.ps1`:

```powershell
.\scripts\maintainer\windows\local-publish.ps1 -BuildDesktopInstaller
.\scripts\maintainer\windows\local-publish.ps1 -CreatePublicGhRelease
.\scripts\maintainer\windows\local-publish.ps1 -All
```

`-All` = BuildDesktopInstaller then CreatePublicGhRelease.

## CI-used scripts

| Script | Role |
|--------|------|
| `republish-public-release.ps1` | Upload Release assets + public `update/latest.json` |
| `push-public-latest-json.ps1` | Refresh draft + push `update/latest.json` to GitHub **and Gitee** (CI + repair) |
| `upload-release-assets-only.ps1` | Windows asset upload (called by republish) |
| `prune-public-github-releases.ps1` | Keep newest N public releases |
| `public-release-body.txt` | Footer under PRODUCT-NOTES in Release body |

Updater draft: `../update/latest.json`（安装包未就绪前不要往公仓塞假 `update/`）。  
现行：GitHub Actions 打包装 GitHub Releases；清单推双仓；客户端 **优先 Gitee** 检查更新，下载用 ghfast 镜像。
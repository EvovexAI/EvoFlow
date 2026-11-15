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

## 本地自验证闭环（Agent 自己改码 → 自己重装 → 自己醒来验收）

【fullstack-dev · 2026-11-15 · 第13轮】新增 `dev-self-verify.ps1` + `selfverify-watchdog.ps1`。

**为什么需要两个脚本**：NSIS 安装器（`windows/installer-hooks.nsh` 的
`EvpKillRunningAppProcesses`）会 `taskkill /F /T` 桌面父进程树，`kill-install-orphans.ps1`
还会按「CommandLine 含安装目录」扫杀 python/bash/node。Agent 的 gateway + bash 正在这张网里，
所以**发起方必死在安装中途**，"装完拉起 + 找回对话"没人做。解法：把后续步骤交给
Task Scheduler 拉起的一次性任务（宿主 `svchost` → `powershell.exe`，既不在进程树内，也不在杀名单内）。

```powershell
# 1) 先空跑看清将要发生什么（不注册任务、不安装）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintainer\windows\dev-self-verify.ps1 `
  -DryRun -TaskId Task_xxx

# 2) 实测：构建安装包 + 30 秒后开始"重装→拉起→唤醒"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintainer\windows\dev-self-verify.ps1 `
  -Build -TaskId Task_xxx -Goal "验证 xxx 改动已生效"
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `-Build` | 关 | 先跑 `local-publish.ps1 -BuildDesktopInstaller`（复用 `-InstallNpmDeps`）；不加则取 `bundle\nsis` 下最新 setup.exe |
| `-TaskId` / `-RoundId` | 空 | 透传给 `evoflow employees wake --resume-round`，用于**续同一轮工作脉络**（不给就只按 agent_code 叫醒） |
| `-InstallDir` | `D:\app\EvoFlow` | 被安装目录；安装器按此路径扫杀孤儿进程 |
| `-DelaySec` | 30 | 留给你收尾/落盘的时间窗；此间可 `Unregister-ScheduledTask -TaskName EvoFlow-SelfVerify-Watchdog -Confirm:$false` 取消 |
| `-ReadyTimeoutSec` | 240 | 等 `backend-runtime.json` 换代（pid 变或 generation 变大）**且** `GET /health` 通过 |
| `-WakeAttempts` | 6 | wake 失败重试次数（退避递增 10→25→40…封顶 60s；仅名册/状态类错误重试） |
| `-RosterTimeoutSec` | 300 | **wake 前等岗位名册载入的上限**（实测教训：`/health` 返 200 ≠ `employees list` 有货，直接投 wake 会连报 `No employee matching`） |

看门狗**只从 `outputs\selfverify\state.json` 读路径与 goal**，安装目录字串不进命令行，
否则会被 `kill-install-orphans.ps1` 的 CommandLine 匹配连带杀掉（goal 里若含安装目录也会被剥成 `<install-dir>`）。
每步结果落 `outputs\selfverify\watchdog.log` 与 `watchdog-result.json`，醒来的 Agent 先读这两个文件再验收。

**实测结论（2026-11-15 端到端跑通一次）**：静默安装 / 拉起 / Gateway 换代（generation 319→320、pid 换新、
`/health` 200、`EVOFLOW_BACKEND_DIR` 生效）四步全过；**首次 wake 失败** —— `/health` 通了但岗位名册未载入完，
连投 6 次 `No employee matching`。已按此加 `wait-roster` 闸门（见上表 `-RosterTimeoutSec`）。
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
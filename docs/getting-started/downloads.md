# 下载与构建产物

EvoFlow **本体**（后端 + 编排）以源码与 Docker 为主分发；**EvoPanel** 桌面端有独立仓库的正式安装包。下面按「最快拿到可运行文件」排序。

## 本地 `install.bat` 与 GitHub 上对应关系（一体包）

你在 **`evopanel/install.bat`** 里做的，等价于：

1. **`evopanel/scripts/build.ps1`**（Release）  
2. → **`build-installer-win.ps1`**：用 [`backend/packaging/windows/build-gateway-exe.ps1`](https://github.com/aiyintai/evoflow/blob/main/backend/packaging/windows/build-gateway-exe.ps1) 把 Gateway **PyInstaller** 打进 `evopanel/src-tauri/binaries/evoflow-gateway/`（内含 `skills/public` 等）  
3. → **`npm run tauri build`**：打出 **NSIS** 安装包（**一个安装程序里带前端壳 + 后端侧车**）。

在 GitHub 上复现同一套逻辑的方式：

| 场景 | 做法 |
|------|------|
| **每次合并后的临时安装包** | [EvoPanel Windows Package](https://github.com/aiyintai/evoflow/actions/workflows/evopanel-windows-package.yml) 成功运行 → **Artifacts**（与 CI 同源命令 `npm run build:desktop:win`）。 |
| **像 cc-panes 那样挂在 Release 的 Assets** | 在含上述脚本的提交上 **打 tag** `v0.1.0`（或后续 `v1.2.3` 等）并 `git push origin <tag>`，触发 [**Release Windows desktop**](https://github.com/aiyintai/evoflow/actions/workflows/release-windows-desktop.yml)，自动创建 Release 并上传 `.exe` / `.msi`、**`SHA256SUMS.txt`** 与各文件 **`.sha256`**。 |

!!! note "多平台（dmg / deb / AppImage）与代码签名"
    截图里 cc-panes 那种「多 OS + 多架构」需要在 GitHub 上为 **macOS、Linux** 各加 runner、**Tauri bundle 目标**，以及（若需消除警告）**各平台代码签名与公证**。  
    **Windows 一体包** 已有 CI/Release 流水线；**macOS/Linux 一体包** 还需补齐 **非 Windows 的 Gateway 侧车** 与 Rust 启动路径（当前侧车以 `.exe` 为主）。  
    签名、证书、GitHub Secrets 与 **「发布者显示为 aiyintai」** 的关系见 [代码签名与多平台发行](../guides/code-signing-and-releases.md)。

## EvoPanel 桌面端（推荐优先看）

跨平台安装包由 **EvoPanel 仓库** 的 Release 发布（与本仓库解耦）：

| 入口 | 链接 |
|------|------|
| **最新正式版** | [github.com/YT/evopanel/releases/latest](https://github.com/YT/evopanel/releases/latest) |
| **全部版本** | [github.com/YT/evopanel/releases](https://github.com/YT/evopanel/releases) |

安装后仍需按 [安装说明](installation.md) 准备本机的 `config.yaml`、API 密钥，并启动后端（`make dev` 或 Docker），详见 [EvoPanel 使用指南](../guides/evopanel-guide.md)。

## 本仓库（deerflow-agent / EvoFlow）的发行版

| 入口 | 说明 |
|------|------|
| [**GitHub Releases**](https://github.com/aiyintai/evoflow/releases) | 推送 **`v*`** tag 后由 [release-windows-desktop](https://github.com/aiyintai/evoflow/actions/workflows/release-windows-desktop.yml) 自动上传 **Windows 一体包** 与校验文件；亦可手动发版。 |
| [**Actions 工作流**](https://github.com/aiyintai/evoflow/actions) | 全部构建日志；PR/`main` 上的 Windows 包见下节。 |

## Windows 桌面包（CI 产物，非 Release 时）

本仓库工作流 [**EvoPanel Windows Package**](https://github.com/aiyintai/evoflow/actions/workflows/evopanel-windows-package.yml) 在 `main` 上推送涉及 `evopanel/` 或 `backend/` 的变更时会构建 **NSIS 安装包**，并以 **Artifact** 形式保留一段时间（非永久 CDN，需登录 GitHub）：

1. 打开 [上述工作流页面](https://github.com/aiyintai/evoflow/actions/workflows/evopanel-windows-package.yml)。
2. 点进最近一次 **绿色成功** 的运行记录。
3. 页面底部 **Artifacts** 中下载 `evopanel-windows-nsis`（内含 `.exe` / `.msi`，以实际产物为准）。

!!! note "与正式 Release 的区别"
    Artifacts 有过期时间，且会随每次提交变化；**长期对外分发**仍建议以 [EvoPanel Releases](https://github.com/YT/evopanel/releases) 或本仓库 [Releases](https://github.com/aiyintai/evoflow/releases) 上传的附件为准。

## 从源码构建（完整栈）

- **文档站**：仓库根目录执行 `pip install -r requirements-docs.txt` 后 `mkdocs build` 或 `make docs-build`。
- **后端 / 全栈开发**：见 [安装](installation.md)、[快速上手](quick-start.md) 与根目录 [README.md](https://github.com/aiyintai/evoflow/blob/main/README.md)。
- **EvoPanel 本地打包**：见 [evopanel/README.md](https://github.com/aiyintai/evoflow/blob/main/evopanel/README.md) 中的构建说明。

---

**最后验证**：2026-05-09；链接以 `aiyintai/evoflow`、`YT/evopanel` 为准。Release 工作流见仓库 `.github/workflows/release-windows-desktop.yml`。

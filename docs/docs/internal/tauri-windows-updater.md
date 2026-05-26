# Windows 桌面端一键更新（Tauri Updater）

EvoPanel 使用 [Tauri plugin-updater](https://v2.tauri.app/plugin/updater/)：检查 `update/latest.json`，下载已签名的 `*.nsis.zip`，静默安装并重启。

## 用户侧

- 启动约 5 秒后顶部横幅提示新版本 → **一键更新**
- **设置 → 关于 → 检查更新** → **一键更新并重启**
- 若签名包未发布，仍可使用 **下载安装包**（`latest.json` 中的 `url` 直链 exe）

## 签名密钥（仅维护者）

```powershell
cd evopanel
$env:CI = "true"
npm run tauri -- signer generate -w src-tauri/updater-signing.key --force --ci
```

- **私钥** `src-tauri/updater-signing.key`：已加入 `.gitignore`，勿提交
- **公钥** `src-tauri/updater-signing.key.pub`：内容已写入 `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`

### 本地构建

存在 `evopanel/src-tauri/updater-signing.key` 时，`build-installer-win.ps1` 会自动设置 `TAURI_SIGNING_PRIVATE_KEY_PATH`。

或手动：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "D:\path\to\evopanel\src-tauri\updater-signing.key"
cd evopanel
npm run build:desktop:win
```

产物（`target/release/bundle/nsis/`）：

- `EvoFlow_<ver>_x64-setup.exe` — 手动安装
- `EvoFlow_<ver>_x64-setup.nsis.zip` + `.sig` — 应用内一键更新

### GitHub Actions

在私有仓 **Settings → Secrets** 添加：

| Secret | 说明 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥文件**全文**（minisign 格式） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 可选；生成时若设了密码则填写 |

`Release EvoFlow Desktop`（或子工作流 `Release EvoPanel desktop (Windows)`）已注入上述变量。

## 发布清单 `update/latest.json`

Windows 发版且带 `-UpdateLatestJson` 时，`republish-public-release.ps1` 会写入：

- 原有字段：`version`、`url`（exe）、`hash`、`changelog` …
- Tauri 所需：`notes`、`pub_date`、`platforms.windows-x86_64`（`url` 指向 `.nsis.zip`，`signature` 为 `.sig` 文件内容）

公共仓地址（客户端拉取）：

`https://raw.githubusercontent.com/EvovexAI/EvoFlow/main/update/latest.json`

发版后请确认：

1. Release 上同时有 `.exe` 与 `.nsis.zip`
2. 公共仓 `latest.json` 含 `platforms.windows-x86_64`
3. 用**旧版本**安装包点「检查更新」能出现「一键更新」

## 安全说明

- 丢失私钥将无法向已安装用户推送签名更新，需重新生成密钥并换公钥（旧客户端需重装一次）。
- 建议为私钥设置密码，并在 CI 使用 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

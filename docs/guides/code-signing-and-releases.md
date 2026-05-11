# 多平台签名、公证与发行（规划与前置条件）

**结论先说**：Windows **Authenticode**、macOS **Developer ID + 公证（Notarization）**、Linux **`.deb` / `.AppImage` + GPG 验签**，都可以在 **GitHub Actions** 里做自动化；但必须由你方准备 **合法证书与 Apple 开发者账号**，并以 **GitHub Secrets** 注入 CI，**绝不能**把私钥或 p12 提交进仓库。

安装包属性里看到的 **「发布者 / Publisher」**（例如你希望显示 **aiyintai** 相关字样）来自 **证书颁发机构（CA）签发的证书主题（Subject）**，与你在 CA 下单时登记的公司/组织名一致；CI 里写字符串无法替代真实签名。

---

## 1. Windows：Authenticode（消除「未知发布者」）

| 你需要准备 | 说明 |
|------------|------|
| **代码签名证书** | 通常向 **DigiCert、Sectigo、SSL.com** 等购买 **OV/EV Code Signing**；EV 证书在新政策下常配合 **USB 令牌** 或云签名服务。 |
| **导出为 PFX** | 在受控机器上导出 `.pfx` + 密码；在 GitHub 用 Base64 整文件写入 Secret（见下）。 |

**GitHub Secrets（命名可按团队习惯调整）**

| Secret | 用途 |
|--------|------|
| `WINDOWS_CERTIFICATE` | PFX 文件的 **Base64** 全文 |
| `WINDOWS_CERTIFICATE_PASSWORD` | PFX 密码 |

**CI 中常见做法**

1. Job 在 `windows-latest`。
2. 解码 PFX 到磁盘，导入到证书存储或通过 **Tauri / `signtool`** 支持的变量指向该文件。
3. Tauri 2 打包 NSIS 前后会调用签名；官方说明见 [Sign Windows](https://v2.tauri.app/distribute/sign-windows/)（以当前 Tauri 文档为准）。

**与「aiyintai」显示的关系**：签名后用户看到的发布者 = 证书里 **O/CN** 等字段；要让名称与 **aiyintai** 一致，需在购证时以对应法律实体申请。

---

## 2. macOS：`macos-latest` + DMG + 公证

| 你需要准备 | 说明 |
|------------|------|
| **Apple Developer Program** | 付费会员；取得 **Team ID**。 |
| **Developer ID Application** 证书 | 在 Apple Developer 创建并导出 **带私钥的 .p12**（仅团队内安全保管）。 |
| **App 专用密码** | Apple ID 账户 → 安全 → **App-Specific Password**，供 `notarytool` 上传公证。 |

**GitHub Secrets（常见组合）**

| Secret | 用途 |
|--------|------|
| `APPLE_CERTIFICATE` | **Base64** 的 `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | p12 密码 |
| `APPLE_TEAM_ID` | 10 位 Team ID |
| `APPLE_ID` | 用于公证的 Apple ID 邮箱 |
| `APPLE_PASSWORD` | 上述 **App 专用密码**（不是 Apple ID 登录密码） |

**CI 流程要点**

1. 必须在 **`macos-latest`（或更高）** runner 上执行 `tauri build` 打出 **DMG / .app**。
2. 签名：按 [Sign macOS](https://v2.tauri.app/distribute/sign-macos/) 配置环境变量或 `tauri.conf.json` 中 macOS 签名项。
3. **公证**：对 `.app` 或 `.dmg` 使用 Apple **`notarytool`** 提交，轮询通过后再 **staple**；未公证的 DMG 在较新 macOS 上可能被 **Gatekeeper** 拦截。

**注意（与本仓库现状强相关）**

- 当前 EvoPanel 侧车逻辑在 Rust 里大量假定 **`evoflow-gateway.exe`** 与 Windows 路径（见 `evopanel/src-tauri/src/commands/backend.rs`）。  
- **仅加签名、不改编译产物**：在现有代码下，**可签名的是「已经能在 macOS 上打出来的包」**；若尚未实现 **Darwin 版 Gateway 侧车** 与无 `.exe` 的启动路径，则需要 **先完成跨平台侧车与打包**，再谈 DMG + 公证。  
- PyInstaller 侧：仓库里 [`backend/packaging/windows/gateway.spec`](https://github.com/aiyintai/evoflow/blob/main/backend/packaging/windows/gateway.spec) 面向 **Windows**；macOS 需 **在 macOS runner 上** 单独维护 **Unix 版 spec/脚本**（或等价冻结依赖的打包方式）。

---

## 3. Linux：`ubuntu-latest` + `.deb` / `.AppImage` + GPG

| 你需要准备 | 说明 |
|------------|------|
| **GPG 签名密钥** | 团队维护的 **离线主密钥** + 用于签名的子密钥；**私钥仅进 Secret**。 |
| **构建环境** | `ubuntu-latest` 安装 `fakeroot`、`dpkg-dev`、Tauri 文档要求的依赖等。 |

**GitHub Secrets（示例）**

| Secret | 用途 |
|--------|------|
| `GPG_PRIVATE_KEY` | ASCII-armored 私钥块 |
| `GPG_PASSPHRASE` | 密钥口令 |

**流程要点**

1. `tauri build` 生成 `.deb` / `.AppImage`（需在 `tauri.conf.json` 或平台配置里启用对应 **bundle target**；仅在有 Linux job 时执行，见 [Tauri Linux](https://v2.tauri.app/distribute/)）。
2. 构建完成后：`gpg --detach-sign --armor xxx.deb` 生成 **`.deb.asc`**（或项目约定的 `.sig` 命名）。
3. 在 Release 页同时上传 **制品 + 签名文件**；用户用 `gpg --verify` 校验。

**同样**：Gateway 侧车若仍是 **仅 Windows 的 PyInstaller 产物**，Linux 一体包需 **Linux 版侧车** 与 Rust 启动逻辑对齐，不能单靠签名解决。

---

## 4. 与现有「仅 Windows NSIS + tag Release」工作流的关系

- 当前 [release-windows-desktop.yml](https://github.com/aiyintai/evoflow/blob/main/.github/workflows/release-windows-desktop.yml) 可在 **同一 job** 里、在 `tauri build` **之后** 增加 **签名步骤**（当上述 Windows Secrets 存在时）。
- macOS / Linux 建议 **独立 job**（`runs-on: macos-latest` / `ubuntu-latest`），必要时用 **`workflow_dispatch`** 或 **仅在有对应 Secrets 时 `if:` 启用**，避免无密钥时 CI 全红。

---

## 5. 推荐落地顺序（降低风险）

1. **Windows**：先接入 **Authenticode**（用户感知最直接），Release 里保留 `SHA256SUMS.txt`。
2. **macOS**：先能在 `macos-latest` 打出 **无公证的 DMG**（验证侧车与路径），再开 **签名 + notarytool**。
3. **Linux**：`.deb` / AppImage 二选一或都要，最后加 **GPG detach sign**。

---

## 6. 官方参考（实现时以最新文档为准）

- Tauri v2 分发总览：<https://v2.tauri.app/distribute/>
- Windows 签名：<https://v2.tauri.app/distribute/sign-windows/>
- macOS 签名：<https://v2.tauri.app/distribute/sign-macos/>
- DMG：<https://v2.tauri.app/distribute/dmg/>

---

**最后验证**：2026-05-09。证书与账号须由 **aiyintai / 贵司** 自行申请并保管；本文不包含任何密钥或购证链接以外的承诺。

## 相关文档

- [Docker 开发部署](./docker-deployment.md) — 构建与发布流程
- [生产环境部署](./production-deploy.md) — 部署配置

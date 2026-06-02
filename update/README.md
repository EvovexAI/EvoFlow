# 客户端更新清单（公开）

`latest.json` 由发布流程通过 `evopanel` 的 `npm run version:sync` 维护，并随 [sync-public](../../.github/workflows/sync-public.yml) 同步到 [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)。

EvoPanel 检查更新请求：

`https://raw.githubusercontent.com/EvovexAI/EvoFlow/main/update/latest.json`

请勿仅在私有仓库或 `evopanel/docs/update/` 单独改版本而不更新本目录。

字段说明：

- `url` / `size` / `hash` 须与 [GitHub Release](https://github.com/EvovexAI/EvoFlow/releases) 实际上传资源一致（当前为 Windows 安装包 `EvoFlow_<version>_x64-setup.exe`，不是 `web-*.zip`）。
- `releasedAt` 使用 Release 的 `published_at`（UTC ISO 8601）。
- **应用内一键更新（Windows）**：还需 `platforms.windows-x86_64.url`（`*.nsis.zip`）与 `platforms.windows-x86_64.signature`（`.sig` 全文）；由带签名的 NSIS 构建 + `-UpdateLatestJson` 自动写入。详见 [docs/internal/tauri-windows-updater.md](../docs/internal/tauri-windows-updater.md)。
- 发版后可用 `scripts/windows/sync-update-manifest.ps1 -Version <x.y.z>` 从 API 自动刷新本文件（仅 exe 字段；一键更新需完整发版流程生成 `platforms`）。

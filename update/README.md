# 客户端更新清单（公开）

`latest.json` 由发布流程通过 `evopanel` 的 `npm run version:sync` 维护，并随 [sync-public](../../.github/workflows/sync-public.yml) 同步到 [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)。

EvoPanel 检查更新请求：

`https://raw.githubusercontent.com/EvovexAI/EvoFlow/main/update/latest.json`

请勿仅在私有仓库或 `evopanel/docs/update/` 单独改版本而不更新本目录。

字段说明：

- `url` / `size` / `hash` 须与 [GitHub Release](https://github.com/EvovexAI/EvoFlow/releases) 实际上传资源一致（当前为 Windows 安装包 `EvoFlow_<version>_x64-setup.exe`，不是 `web-*.zip`）。
- `releasedAt` 使用 Release 的 `published_at`（UTC ISO 8601）。
- 发版后可用 `scripts/windows/sync-update-manifest.ps1 -Version <x.y.z>` 从 API 自动刷新本文件。

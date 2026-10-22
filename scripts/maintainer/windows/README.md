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
| `upload-release-assets-only.ps1` | Windows asset upload (called by republish) |
| `prune-public-github-releases.ps1` | Keep newest N public releases |
| `public-release-body.txt` | Footer under PRODUCT-NOTES in Release body |

Updater draft: `../update/latest.json` (never reintroduce root `update/`).
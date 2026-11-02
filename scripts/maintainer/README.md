# scripts/maintainer/

Release helpers for the public repo. Not needed for day-to-day contribute.

> **升版本先看仓库根目录 [RELEASE.md](../../RELEASE.md)**  
> （改 `VERSION`、写 CHANGELOG / PRODUCT-NOTES / `latest.json`、打 tag → GitHub Actions 打包。）

| Path | Purpose |
|------|---------|
| `windows/local-publish*` | Local NSIS / public Release helpers |
| `windows/release-evopanel-public*` | One-shot version bump + Windows public release |
| `windows/republish-public-release.ps1` | CI: upload assets + public `update/latest.json` |
| `windows/upload-release-assets-only.ps1` | Used by republish (Windows assets) |
| `windows/prune-public-github-releases.ps1` | Keep N newest public releases |
| `windows/release-notes/PRODUCT-NOTES-x.y.z.md` | Release「本版更新」正文 |
| `windows/public-release-body.txt` | Footer appended to Release body |
| `windows/push-public-latest-json.ps1` | Refresh `update/latest.json`（GitHub + Gitee；默认 ghfast 下载链） |
| `update/` | Updater draft → publish after installer ready |
| `gitee/` | Gitee 说明（现行：清单优先；独立打包未启用） |

Desktop CI（现行）：`.github/workflows/release-desktop-public.yml`  
检查更新：客户端优先 Gitee `update/latest.json`。

# scripts/maintainer/

Release helpers for the public repo. Not needed for day-to-day contribute.

| Path | Purpose |
|------|---------|
| `windows/local-publish*` | Local TOS / NSIS / public Release helpers |
| `windows/release-evopanel-public*` | One-shot version bump + Windows public release |
| `windows/republish-public-release.ps1` | CI: upload assets + public `update/latest.json` |
| `windows/upload-release-assets-only.ps1` | Used by republish (Windows assets) |
| `windows/prune-public-github-releases.ps1` | Keep N newest public releases |
| `windows/release-notes/PRODUCT-NOTES-x.y.z.md` | **Current** release body only |
| `windows/public-release-body.txt` | Footer appended to GitHub Release body |
| `update/` | Updater draft → publish after installer ready |

Desktop CI entrypoint: `.github/workflows/release-desktop-public.yml`
（Windows / macOS：`release-windows-public.yml`、`release-macos-public.yml`）。

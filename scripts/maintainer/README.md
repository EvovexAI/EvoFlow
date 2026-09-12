# scripts/maintainer/

Upstream release / public-mirror helpers. Not needed for day-to-day contribute.

| Path | Purpose |
|------|---------|
| `windows/local-publish*` | Local sync-public / TOS / NSIS / public Release |
| `windows/release-evopanel-public*` | One-shot version bump + Windows public release |
| `windows/republish-public-release.ps1` | CI: upload assets + public `update/latest.json` |
| `windows/upload-release-assets-only.ps1` | Used by republish (Windows assets) |
| `windows/prune-public-github-releases.ps1` | Keep N newest public releases |
| `windows/release-notes/PRODUCT-NOTES-x.y.z.md` | **Current** release body only |
| `windows/public-release-body.txt` | Footer appended to GitHub Release body |
| `update/` | Updater draft → public after installer ready |
| `public-sync/` | Docs strip for sync-public |

Extra one-offs (Gitee mirror, updater key setup, historical 0.x notes):  
`$EVOFLOW_PRIVATE_DOCS/scripts/` — see private-docs `scripts/README.md`.

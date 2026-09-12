# Maintainer Windows scripts

Release / public-mirror helpers. Contributor day-to-day: `../windows/` and `../../README.md`.

## Must-have for a public desktop release

1. Write `release-notes/PRODUCT-NOTES-x.y.z.md` (match `evopanel` version; public line starts at **1.0.0**).
2. Copy `local-publish.env.example` → `local-publish.env` (gitignored).
3. One-shot:

```powershell
Set-Location <repo-root>
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintainer\windows\release-evopanel-public.ps1 `
  -Version 1.0.0 `
  -ProductNotesPath .\scripts\maintainer\windows\release-notes\PRODUCT-NOTES-1.0.0.md `
  -PushGitTag
```

Or piece-wise via `local-publish.ps1` (`-SyncPublic`, `-BuildDesktopInstaller`, `-CreatePublicGhRelease`, …).

## CI-used scripts

| Script | Role |
|--------|------|
| `republish-public-release.ps1` | Upload Release assets + public `update/latest.json` |
| `upload-release-assets-only.ps1` | Windows asset upload (called by republish) |
| `prune-public-github-releases.ps1` | Keep newest N public releases |
| `public-release-body.txt` | Footer under PRODUCT-NOTES in Release body |

Updater draft: `../update/latest.json` (never reintroduce root `update/`).

## Moved out of the public source tree

Gitee mirror, updater key one-shots, historical `PRODUCT-NOTES-0.x`, artifact purge, etc.:

`$EVOFLOW_PRIVATE_DOCS/scripts/` (see private-docs `scripts/README.md`).

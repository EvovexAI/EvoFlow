# Client update manifest (maintainer draft)

Private draft for the desktop updater. **Not** part of the product source tree.

- Local draft: `scripts/maintainer/update/latest.json` (this directory)
- Public channel (clients poll this):  
  `https://raw.githubusercontent.com/EvovexAI/EvoFlow/main/update/latest.json`

`npm run version:set` bumps the draft here. After the Windows installer is uploaded, `republish-public-release.ps1 -UpdateLatestJson` writes real `hash` / `size` / `platforms` and pushes **only** to the public repo path `update/latest.json`.

Do **not** put a root `update/` directory back into the public source tree, and do **not** sync this draft via `sync-public` before the installer is ready.

Public source-available releases start at **1.0.0**; fill `changelog` / `releasedAt` on the first ship.

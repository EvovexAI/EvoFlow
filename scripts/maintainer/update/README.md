# Client update manifest (maintainer draft)

升版本总清单见仓库根 [RELEASE.md](../../../RELEASE.md)。本目录只放升级通道草稿。

Private draft for the desktop updater. **Not** part of the product source tree as the live channel.

- Local draft: `scripts/maintainer/update/latest.json` (this directory)
- Public channel (clients poll, **jsDelivr first**):  
  `https://cdn.jsdelivr.net/gh/EvovexAI/EvoFlow@main/update/latest.json`  
  fallback: `https://raw.githubusercontent.com/EvovexAI/EvoFlow/main/update/latest.json`

`npm run version:set` bumps the draft here. After the Windows installer is uploaded:

- **CI** (`release-windows-public.yml`) runs `push-public-latest-json.ps1` automatically
- Manual / repair:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/maintainer/windows/push-public-latest-json.ps1 -Tag v1.2.3
```

That writes real `hash` / `size` / optional `platforms` and pushes **only** to the public repo path `update/latest.json` (Contents API). Root `/update/` stays gitignored in working trees; the live file lives on `main` for clients.

Do **not** put a fake root `update/` into the source tree before the installer is ready.

One-click in-app update also needs a signed `*.nsis.zip` (+ `.sig`) on the Release and `TAURI_SIGNING_*` CI secrets. Without them, clients still discover the version and fall back to downloading `setup.exe`.

# Gateway sidecar (build artifact)

`tauri.conf.json` bundles this directory as a desktop resource. **Do not commit** the PyInstaller onedir here (gitignored).

## Formal installer

From repo scripts (builds the real `evoflow-gateway` binary into this folder):

- Windows: `evopanel/build.sh` / maintainer Windows pack scripts
- macOS: `evopanel/scripts/build-installer-mac.sh`

Public CI: `.github/workflows/release-*-public.yml` builds the sidecar before `tauri build`.

## Local desktop shell (`tauri dev`) without a packaged sidecar

Prefer an editable backend instead of this folder:

```bash
# terminal A — gateway already running, e.g. make dev / serve on :8012
export EVOFLOW_GATEWAY_URL=http://127.0.0.1:8012

# or point at the backend tree (venv + gateway_entry.py); shell will spawn it
export EVOFLOW_BACKEND_DIR=/path/to/EvoFlow/backend
```

Then from `evopanel/`: `npm run dev:tauri`.

An empty placeholder directory (this README + `.gitkeep`) only satisfies the Tauri resource path check; it is **not** a runnable gateway.

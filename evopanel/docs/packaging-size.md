# Desktop installer packaging size notes

Windows / macOS desktop builds ship:

1. **Tauri UI** — Vite `evopanel/dist` (includes pruned `public/kws`)
2. **Gateway sidecar** — PyInstaller onedir under `src-tauri/binaries/evoflow-gateway/`
3. **Bundled tools** — `tools/agent-browser` (Chromium), `tools/ripgrep`, optional whisper
4. **Skills seed** — `skills/public` (pruned at copy time)

## Automatic prunes (build scripts)

| Item | Approx. | Why excluded from installer |
|------|---------|-------------------------------|
| `hyperframes-animation/examples` | ~38 MB | demo assets only |
| scrubbed skill packs (`desktop-control`, …) | varies | not redistributed in public builds; also OpenClaw-brand gate |
| `evopanel-dist` inside sidecar | ~70 MB | Tauri already ships UI; use `-IncludeEvopanelDist` only for headless WebUI |

Scripts:

- `backend/packaging/scripts/prune-bundled-skills.ps1` / `.sh`
- Called from `build-gateway-exe.ps1` and `build-gateway-macos.sh`

## Still large (not auto-stripped)

| Item | Approx. | Notes |
|------|---------|--------|
| `tools/agent-browser` | ~500 MB | Chromium for browser automation |
| `torch` + sentence-transformers | ~470 MB | local BGE embedding via PyInstaller `collect_all` |
| `kb-mcp` under `backend/packaging/` | ~700 MB | **not** copied into installer today |

Frontend KWS lean bundle: see `docs/kws-packaging.md`.

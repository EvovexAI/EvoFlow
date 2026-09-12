# Public sync helpers

Scripts used by optional docs/site mirroring (`sync-public.yml`, `local-publish.ps1 -SyncPublic`).
They are **not** required for shipping desktop builds from the public repo.

## Public repo builds itself

`EvovexAI/EvoFlow` should build and publish installers **in place** (see
`.github/workflows/release-windows-public.yml`):

- Trigger: `v*` tag or workflow_dispatch on the public repo
- Auth: default `github.token` (same-repo Contents/Releases)
- No private→public source sync
- No `PUBLIC_REPO_GH_TOKEN`
- Updater signing secrets are optional; without them the job still publishes `setup.exe` + checksums

Private-maintainer workflows that sync a private tree into the public mirror remain separate
and are not part of the public release path.

## Full-source mirror omissions

When (re)publishing a full source-available tree to `EvovexAI/EvoFlow`, omit at least:

| Path | Reason |
| --- | --- |
| `skills/public/website-to-video/` | Not shipped on the public mirror |
| `evopanel/public/kws/*.{onnx,wasm}` | Large binaries; use `npm run kws:ensure` |
| Large `evopanel/public/assets/liquid-glass/*` demo images | Clone size |
| `evopanel/src-tauri/binaries/evoflow-gateway/*` (except `.gitkeep` / README) | Built by CI / pack scripts; keep placeholder dir only |

**Do not omit** `backend/packages/harness/evoflow/uploads/` — Gateway/Client import it; missing it breaks source builds.

Adding or updating `.github/workflows/**` via API/`gh` requires a credential with the GitHub
**`workflow`** scope (one-time). After workflows exist on the public repo, day-to-day releases
only need normal Actions permissions on that repo.

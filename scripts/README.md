# scripts/

Contributor helpers for building, checking, and running EvoFlow.

| Script | Purpose |
|--------|---------|
| `configure.py` / `config-upgrade.sh` | Local config |
| `check.py` / `ci-local.sh` | Sanity / local CI |
| `docker.sh` / `serve.sh` / `start-daemon.sh` / `deploy.sh` | Run or self-host |
| `build-sandbox-helpers.sh` | Optional sandbox helper (Unix) |
| `preflight-build-check.py` | Desktop build gate (CI) |
| `docs/export_gateway_openapi.py` | OpenAPI regen |
| `fill_codebasewiki_batch.py` | Fill/refresh `.codebasewiki` module fact docs from path-map |
| `git-hooks/` + `setup-git-hooks.sh` | Hooks |
| `windows/*` | Windows isolated dev stack |
| `run-github-checks-local.bat` / `run-with-git-bash.cmd` | Windows → `ci-local.sh` |

Maintainer release tooling: `scripts/maintainer/` (CI + publishers only).

# Backend contributing

This tree is part of the **EvoFlow** monorepo. Start with the root guides:

- [../CONTRIBUTING.md](../CONTRIBUTING.md) — setup, branches, PR checklist
- [../CLA.md](../CLA.md) — contributor license agreement
- [../LICENSE](../LICENSE) — PolyForm Noncommercial 1.0.0

## Layout

| Path | Role |
|------|------|
| `backend/` | Python FastAPI Gateway (this package) |
| `../evopanel/` | Web UI + Tauri desktop shell |
| `../skills/` | Bundled / public skills |

## Data Directory (Development vs Production)

The gateway stores all data (database, config, logs, threads, etc.) in a single root directory.

### Default Locations

| Environment | Data Directory |
|-------------|----------------|
| **Production** | `~/.evoflow` |
| **Development** | `~/.evoflow-dev` (recommended) |

### Using Separate Development Data Directory

To keep your production data separate from development experiments:

```powershell
# Windows PowerShell - set permanently
[System.Environment]::SetEnvironmentVariable("EVOFLOW_HOME", "$env:USERPROFILE\.evoflow-dev", "User")
```

```bash
# Linux/macOS - add to ~/.bashrc or ~/.zshrc
export EVOFLOW_HOME=~/.evoflow-dev
```

Or use the convenience script at `scripts/set-evoflow-dev-env.ps1`.

### Directory Resolution Priority

1. `Paths(base_dir)` constructor argument
2. `EVOFLOW_HOME` environment variable
3. Local fallback: `backend/.evoflow` (only when in backend directory)
4. Default: `~/.evoflow`

### Migration from Existing .evoflow

If you want to migrate existing data to a new dev directory:

```powershell
# 1. Copy existing data
Copy-Item -Path $env:USERPROFILE\.evoflow -Destination $env:USERPROFILE\.evoflow-dev -Recurse -Force

# 2. Set the environment variable
[System.Environment]::SetEnvironmentVariable("EVOFLOW_HOME", "$env:USERPROFILE\.evoflow-dev", "User")

# 3. Restart the gateway - it will now use the dev directory
```

## Local Gateway

From the repo root (or this directory, depending on your venv layout):

```bash
# typical monorepo flow — see root CONTRIBUTING for the canonical commands
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Config and secrets live under the user’s EvoFlow data dir (e.g. `~/.evoflow/`), not hard-coded in source.

## Pull requests

1. Keep changes scoped; match existing style in the modules you touch.
2. Prefer small, reviewable PRs over large renames unless coordinated.
3. Do not commit secrets, API keys, or local `*.env` files.

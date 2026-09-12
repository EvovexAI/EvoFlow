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

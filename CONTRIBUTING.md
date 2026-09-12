# Contributing to EvoFlow

Thank you for contributing. This guide is the **source-of-truth** for: environment setup, branch workflow, required checks, and how PRs get merged.

> **Note:** [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow) ships documentation, desktop releases, and the full application source under the [PolyForm Noncommercial License 1.0.0](LICENSE). Follow the workflow below. Contributions are licensed under that same license.

> **贡献者许可（CLA）：** 提交 Pull Request 前，请阅读并同意 [CLA.md](CLA.md)。提交贡献即视为你已接受该协议：你将贡献的著作权与专利权永久、免费、可再许可地授予版权人（景银泰/EvovexAI），版权人可用本项目当前或未来的任何许可（含商用）使用你的贡献。

Also read: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · [SUPPORT.md](SUPPORT.md) · [SECURITY.md](SECURITY.md) · [AUTHORS.md](AUTHORS.md)

---

## What we want most

1. Bug fixes (crashes, wrong behavior, data loss)
2. Docs and translations under `docs/user/`
3. Skills (`skills/public/…`) that are broadly useful
4. Cross-platform fixes (Windows / macOS / Linux / WSL)
5. Security hardening
6. Core runtime / gateway changes — only with clear design and tests

Prefer a **Skill** or MCP adapter over growing core tools when possible.

---

## Branch & pull workflow

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b feat/short-description    # or fix/… docs/…
```

| Branch | Use |
| --- | --- |
| `main` | Protected release line — PR only |
| `feat/*` | Features |
| `fix/*` | Bug fixes |
| `docs/*` | Documentation only |

**Keep PRs focused:** one logical change per PR. Rebase (or merge) onto latest `main` before requesting review.

```bash
git fetch origin
git rebase origin/main
# fix conflicts, then:
git push -u origin HEAD
```

Open a Pull Request against `main`. Fill the PR template. Wait for CI (below) to go green.

**Commit messages:** Conventional Commits — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.

---

## Required checks before you push

Mirror what CI runs. Prefer the umbrella script when possible:

```bash
# From repo root (Git Bash / WSL / macOS / Linux)
make ci-local
# or: bash scripts/ci-local.sh
```

Minimum by area:

| Area | Command |
| --- | --- |
| Backend format / lint | `cd backend && make format` (ruff) |
| Backend unit tests | `cd backend && uv run pytest` |
| EvoPanel | `cd evopanel && pnpm typecheck` (and `pnpm test` if you touched UI logic) |
| Docs | `make docs-build` if you changed `docs/` or `mkdocs.yml` |

CI workflows (must stay green on the PR):

- [.github/workflows/lint-check.yml](.github/workflows/lint-check.yml)
- [.github/workflows/backend-unit-tests.yml](.github/workflows/backend-unit-tests.yml)
- [.github/workflows/docs.yml](.github/workflows/docs.yml) when docs change

Do **not** commit: `.evoflow/`, secrets, `local-publish.env`, smoke leftovers, or `backend/outputs/`.

---

## Development environment

Two options. **Docker is recommended.**

### Option 1: Docker (recommended)

**Prerequisites:** Docker Desktop / Engine; pnpm optional (cache).

```bash
cp config.example.yaml config.yaml
# Optional runtime tweaks only — do NOT put models / API keys here.
# After start: Settings → Models in the UI (SQLite).

make docker-init    # first time: images + deps
make docker-start   # http://localhost:2026
```

| URL | Service |
| --- | --- |
| http://localhost:2026 | Unified nginx entry |
| Gateway / LangGraph | Proxied under `/api/*` |

```bash
make docker-stop
make docker-logs
make docker-logs-gateway
```

<details>
<summary>Linux: Docker permission denied</summary>

Add your user to the `docker` group, then re-login:

```bash
sudo usermod -aG docker $USER
# log out / in, then:
docker ps
make docker-start
```

</details>

### Option 2: Local processes

```bash
make check      # Node 22+, pnpm, uv, nginx
make install
make dev        # nginx on :2026
# Then open the UI → Settings → Models (not config.yaml)
```

Or start pieces manually:

```bash
# Terminal 1 — LangGraph :2024
cd backend && make dev

# Terminal 2 — Gateway :8001
cd backend && make gateway

# Terminal 3 — EvoPanel (often :1420)
cd evopanel && pnpm dev

# Terminal 4 — nginx
make nginx
```

Windows helpers: `scripts/windows/start-dev-stack.ps1` (see [scripts/windows/README.md](scripts/windows/README.md)).

---

## Project map (where to change things)

```text
EvoFlow/
├── backend/app/           # Gateway, channels, product routes
├── backend/packages/harness/evoflow/   # Runtime / tools / memory / sandbox
├── evopanel/              # Desktop control plane (Tauri + React)
├── skills/public/         # Bundled SKILL.md packages
├── docs/user/             # Public user documentation (MkDocs)
├── scripts/               # Contributor check / docker / serve
└── scripts/maintainer/    # Upstream release / mirror (maintainers only)
```

**Boundary:** `evoflow.*` must not import `app.*`. App may import `evoflow`.

Chinese contributor guide: [docs/contribute/](docs/contribute/index.md) (repo map, branching, add-skill). Harness tips: [backend/AGENTS.md](backend/AGENTS.md). Maintainers: [MAINTAINERS.md](MAINTAINERS.md).

---

## Documentation PRs

- Edit files under `docs/user/` (and `docs/index.md` / `mkdocs.yml` if navigation changes).
- Run `make docs-build` locally.
- Prefer Chinese for user-facing docs unless the page is already English-first.

---

## Skills PRs

- Add under `skills/public/<name>/` with a valid `SKILL.md`.
- Keep secrets out of skill files; document required env vars instead.
- See user docs: [添加技能](docs/user/tutorials/add-skill.md).

---

## Code style

- **Python:** `ruff` via `cd backend && make format`
- **TypeScript (EvoPanel):** `pnpm typecheck`; tests when UI logic changes
- CI rejects unformatted Python

---

## Review & merge

- At least one maintainer review for `main`
- Squash merge preferred for feature branches
- Do not force-push `main`
- Release packaging / public-mirror sync is **maintainer-only** (`scripts/maintainer/`)

---

## Need help?

- [SUPPORT.md](SUPPORT.md) — where to ask
- [GitHub Issues](https://github.com/EvovexAI/EvoFlow/issues)
- [GitHub Discussions](https://github.com/EvovexAI/EvoFlow/discussions)
- User docs: [docs/index.md](docs/index.md)

## License

By contributing, you agree your contributions are licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE), and that the copyright holder may use them in commercial offerings under separate terms.

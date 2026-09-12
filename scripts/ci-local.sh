#!/usr/bin/env bash
# Run the same checks as GitHub Actions (Unit Tests, Lint Check, Docs). Typical use: pre-commit hook or manual run before commit.
# Does NOT run "Sync to Public Repository" (requires secrets / SSH to another clone).
#
# Usage (from repo root):
#   make setup-git-hooks    # once per clone — then `git commit` runs pre-commit (default: ci-local --quick)
#   ./scripts/ci-local.sh
#   ./scripts/ci-local.sh --no-docs     # skip MkDocs + OpenAPI (still runs full tests + evopanel)
#   ./scripts/ci-local.sh --quick       # pre-commit: backend lint + tsc when evopanel deps present
#   make ci-local                        # Windows: uses Git Bash via scripts/run-with-git-bash.cmd
#
# Prerequisites: uv, Node 22 + npm, Python 3.12 with pip (for MkDocs when docs enabled).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_DOCS=false
QUICK=false
for arg in "$@"; do
  case "$arg" in
    --no-docs) SKIP_DOCS=true ;;
    --quick) QUICK=true; SKIP_DOCS=true ;;
    -h|--help)
      echo "Usage: $0 [--no-docs] [--quick]"
      echo "  Mirrors .github/workflows: backend-unit-tests.yml, lint-check.yml, docs.yml"
      echo "  --no-docs  Skip OpenAPI regen + git diff + mkdocs strict build"
      echo "  --quick    Backend uv sync + lint + evopanel tsc --noEmit (skipped if typescript not installed locally)"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
else
  PYTHON=python
fi

# EvoPanel: GitHub uses npm ci. On Windows, npm ci often fails with EPERM unlink on
# node_modules/@esbuild/win32-x64/esbuild.exe (IDE, dev server, or AV holds the file).
_evopanel_npm_ci_or_install() {
  (
    cd "$ROOT/evopanel" || exit 1
    if npm ci; then
      return 0
    fi
    local rc=$?
    local os
    os="$(uname -s 2>/dev/null || true)"
    if [[ "$os" == MINGW* ]] || [[ "$os" == MSYS_NT* ]] || [[ "$os" == CYGWIN_NT* ]]; then
      echo "npm ci failed (exit $rc). On Windows EPERM unlink on esbuild.exe is common." >&2
      echo "Close evopanel dev servers / other terminals using node_modules, then retry." >&2
      echo "Falling back to: npm install (does not fully wipe node_modules first)..." >&2
      npm install
      return $?
    fi
    return "$rc"
  )
}

echo "=========================================="
echo "  CI local: backend (uv sync --group dev)"
echo "=========================================="
(cd backend && uv sync --group dev)

if [[ "$QUICK" == true ]]; then
  echo ""
  echo "=========================================="
  echo "  CI local: --quick (backend lint + optional evopanel tsc)"
  echo "=========================================="
  export RUFF_CACHE_DIR="${TMPDIR:-${TEMP:-/tmp}}/ruff-cache-evoflow"
  mkdir -p "$RUFF_CACHE_DIR" 2>/dev/null || true
  (cd backend && make lint)
  # Prefer direct node+tsc (reliable on Git Bash / Windows); skip if deps missing (avoid blocking commit on broken npm ci).
  _tsc_js="evopanel/node_modules/typescript/bin/tsc"
  if [[ -f "$_tsc_js" ]]; then
    (cd evopanel && node ./node_modules/typescript/bin/tsc --noEmit)
  else
    echo "ci-local --quick: skipped evopanel tsc (missing $_tsc_js). Run: cd evopanel && npm ci" >&2
  fi
  echo ""
  echo "=========================================="
  echo "  CI local: --quick checks passed."
  echo "  Full CI: ./scripts/ci-local.sh   or   make ci-local"
  echo "=========================================="
  exit 0
fi

echo ""
echo "=========================================="
echo "  CI local: Unit Tests (backend-unit-tests.yml)"
echo "=========================================="
(cd backend && make test)

echo ""
echo "=========================================="
echo "  CI local: Lint backend (lint-check.yml)"
echo "=========================================="
(cd backend && make lint)

echo ""
echo "=========================================="
echo "  CI local: Lint EvoPanel (lint-check.yml)"
echo "=========================================="
(
  cd "$ROOT/evopanel" || exit 1
  _evopanel_npm_ci_or_install || exit $?
  npm run typecheck && npm run test && npm run build
)

if [[ "$SKIP_DOCS" == true ]]; then
  echo ""
  echo "Skipping Docs workflow (--no-docs)."
else
  echo ""
  echo "=========================================="
  echo "  CI local: Docs (docs.yml)"
  echo "=========================================="
  (cd backend && PYTHONPATH=. uv run python ../scripts/docs/export_gateway_openapi.py)
  echo "Installing MkDocs dependencies..."
  "$PYTHON" -m pip install -q -r requirements-docs.txt
  echo "MkDocs strict build..."
  "$PYTHON" -m mkdocs build --strict
fi

echo ""
echo "=========================================="
echo "  CI local: all checks passed."
echo "=========================================="
echo "Not run here: Sync to Public Repository (needs PUBLIC_REPO_SSH_KEY on CI)."

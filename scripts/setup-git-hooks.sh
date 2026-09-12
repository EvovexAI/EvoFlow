#!/usr/bin/env bash
# One-time per clone: point Git at versioned hooks so `git commit` runs pre-commit without copying files.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git config core.hooksPath scripts/git-hooks

# Help Unix Git actually exec hook + ci-local (Windows Git often ignores +x for .sh)
chmod +x "$ROOT/scripts/git-hooks/pre-commit" "$ROOT/scripts/ci-local.sh" 2>/dev/null || true

echo "OK: this repo now uses hooks from scripts/git-hooks/"
echo "    $(git config core.hooksPath)"
echo "pre-commit: ci-local --quick (backend lint + evopanel tsc when deps installed)."
echo "Full CI (tests + evopanel test/build + docs): make ci-local"

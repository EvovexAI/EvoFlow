#!/usr/bin/env bash
set -euo pipefail

FORCE=0
if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
KB_ROOT="$BACKEND_DIR/packaging/kb-mcp"
PKG_JSON="$KB_ROOT/package.json"
OHS_JS="$KB_ROOT/node_modules/obsidian-hybrid-search/dist/src/server.js"
WRITE_JS="$KB_ROOT/node_modules/obsidian-mcp-server/dist/index.js"

if [[ ! -f "$PKG_JSON" ]]; then
  echo "[kb-mcp] missing $PKG_JSON" >&2
  exit 1
fi

if [[ -f "$OHS_JS" && -f "$WRITE_JS" && "$FORCE" -eq 0 ]]; then
  echo "[kb-mcp] already installed under $KB_ROOT (use --force to refresh)"
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[kb-mcp] npm not found. Install Node.js 18+ and retry." >&2
  exit 1
fi

echo "[kb-mcp] npm install in $KB_ROOT"
(
  cd "$KB_ROOT"
  npm install --no-fund --no-audit
)

if [[ ! -f "$OHS_JS" ]]; then
  echo "[kb-mcp] OHS entry missing after install: $OHS_JS" >&2
  exit 1
fi
if [[ ! -f "$WRITE_JS" ]]; then
  echo "[kb-mcp] write MCP entry missing after install: $WRITE_JS" >&2
  exit 1
fi

echo "[kb-mcp] ready: $KB_ROOT"

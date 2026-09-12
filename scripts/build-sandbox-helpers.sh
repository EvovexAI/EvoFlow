#!/usr/bin/env bash
# DEV ONLY — build Linux OS sandbox helper from open-source crates.
# EvoFlow does NOT treat runtime CLI as a product upstream.
set -euo pipefail

echo "WARN: DEV ONLY sandbox helper build (not a runtime product dependency)." >&2

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX_HELPER_SRC="${EVOFLOW_SANDBOX_HELPER_SRC:-${EVOFLOW_CODEX_RS:-$ROOT/../codex/codex-rs}}"
OUT="${EVOFLOW_SANDBOX_HELPER_DIR:-$HOME/.evoflow/sandbox-helpers}"

if [[ ! -d "$SANDBOX_HELPER_SRC" ]]; then
  echo "Sandbox crate sources not found at $SANDBOX_HELPER_SRC (set EVOFLOW_SANDBOX_HELPER_SRC)." >&2
  exit 1
fi

mkdir -p "$OUT"
uname_s="$(uname -s)"

case "$uname_s" in
  Linux)
    (cd "$SANDBOX_HELPER_SRC" && cargo build -p codex-linux-sandbox --release)
    # Neutral runtime name
    cp -f "$SANDBOX_HELPER_SRC/target/release/codex-linux-sandbox" "$OUT/evoflow-linux-sandbox"
    cp -f "$SANDBOX_HELPER_SRC/target/release/codex-linux-sandbox" "$OUT/codex-linux-sandbox"
    chmod +x "$OUT/evoflow-linux-sandbox" "$OUT/codex-linux-sandbox"
    echo "Installed (dev): $OUT/evoflow-linux-sandbox"
    ;;
  Darwin)
    echo "macOS: Seatbelt policy generation not packaged; host stays passthrough until crate embed."
    echo "Staging dir: $OUT"
    ;;
  *)
    echo "Unsupported uname=$uname_s — on Windows use scripts/windows/build-sandbox-helpers.ps1" >&2
    exit 1
    ;;
esac

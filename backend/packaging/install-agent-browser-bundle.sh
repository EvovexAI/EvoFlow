#!/usr/bin/env bash
# Install agent-browser CLI into packaging/agent-browser-bundle (shared by gateway builds).
# Chromium is NOT prebundled by default (~400MB); the desktop app downloads it on first
# browser tool use. Pass --include-chromium or EVOFLOW_BUNDLE_CHROMIUM=1 for offline/dev.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
AB_ROOT="${BACKEND_DIR}/packaging/agent-browser-bundle"
BROWSERS_ROOT="${AB_ROOT}/browsers"

INCLUDE_CHROMIUM=0
for arg in "$@"; do
  case "$arg" in
    --include-chromium|-IncludeChromium) INCLUDE_CHROMIUM=1 ;;
  esac
done
case "${EVOFLOW_BUNDLE_CHROMIUM:-}" in
  1|true|TRUE|yes|YES|on|ON) INCLUDE_CHROMIUM=1 ;;
esac

echo "[agent-browser-bundle] target: ${AB_ROOT}"
rm -rf "${AB_ROOT}"
mkdir -p "${AB_ROOT}"

cd "${AB_ROOT}"
cat > package.json <<'EOF'
{
  "name": "evoflow-agent-browser-bundle",
  "private": true,
  "dependencies": {
    "agent-browser": "latest"
  }
}
EOF

echo "[agent-browser-bundle] npm install agent-browser"
npm install --omit=dev

export PATH="${AB_ROOT}/node_modules/.bin:${PATH}"

if [[ "${INCLUDE_CHROMIUM}" == "1" ]]; then
  echo "[agent-browser-bundle] agent-browser install (Chromium -> ~/.agent-browser/browsers)"
  agent-browser install

  USER_BROWSERS="${HOME}/.agent-browser/browsers"
  if [[ ! -d "${USER_BROWSERS}" ]]; then
    echo "[agent-browser-bundle] ERROR: browsers dir missing after install: ${USER_BROWSERS}" >&2
    exit 1
  fi
  rm -rf "${BROWSERS_ROOT}"
  cp -R "${USER_BROWSERS}" "${BROWSERS_ROOT}"
  echo "[agent-browser-bundle] copied Chromium -> ${BROWSERS_ROOT}"
else
  echo "[agent-browser-bundle] skip Chromium (runtime on-demand). Use --include-chromium or EVOFLOW_BUNDLE_CHROMIUM=1 to prebundle."
fi

echo "[agent-browser-bundle] done"

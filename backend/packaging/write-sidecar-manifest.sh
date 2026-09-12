#!/usr/bin/env bash
# Write sidecar-manifest.json next to the PyInstaller gateway tree.
# Desktop startup pins panel_version to CARGO_PKG_VERSION.
set -euo pipefail

GATEWAY_DIR="${1:?usage: write-sidecar-manifest.sh <gateway-dir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# This script lives at backend/packaging/, so .. = backend, ../.. = repo root.
# (The Windows twin lives at backend/packaging/windows/ and needs ../.. for backend.)
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${BACKEND_DIR}/.." && pwd)"
GATEWAY_ABS="$(cd "${GATEWAY_DIR}" && pwd)"

VER_FILE="${REPO_ROOT}/evopanel/VERSION"
if [[ ! -f "${VER_FILE}" ]]; then
  echo "[sidecar-manifest] ERROR: missing ${VER_FILE}" >&2
  exit 1
fi
PANEL_VERSION="$(tr -d '[:space:]' < "${VER_FILE}")"
if [[ -z "${PANEL_VERSION}" ]]; then
  echo "[sidecar-manifest] ERROR: empty evopanel/VERSION" >&2
  exit 1
fi

EXE=""
for cand in "${GATEWAY_ABS}/evoflow-gateway" "${GATEWAY_ABS}/evoflow-gateway.exe"; do
  if [[ -f "${cand}" ]]; then
    EXE="${cand}"
    break
  fi
done

EXE_SHA=""
if [[ -n "${EXE}" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    EXE_SHA="$(sha256sum "${EXE}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    EXE_SHA="$(shasum -a 256 "${EXE}" | awk '{print $1}')"
  fi
fi

BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT="${GATEWAY_ABS}/sidecar-manifest.json"
cat > "${OUT}" <<EOF
{"schema":1,"product":"evoflow-gateway","panel_version":"${PANEL_VERSION}","built_at":"${BUILT_AT}","exe_sha256":"${EXE_SHA}"}
EOF
echo "[sidecar-manifest] wrote ${OUT} (panel_version=${PANEL_VERSION})"

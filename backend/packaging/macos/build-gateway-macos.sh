#!/usr/bin/env bash
# Build PyInstaller one-folder gateway for macOS (same spec as Windows; output is evoflow-gateway binary + deps).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${BACKEND_DIR}/.." && pwd)"
DEFAULT_OUT="${REPO_ROOT}/evopanel/src-tauri/binaries/evoflow-gateway"
OUTPUT_PATH="${1:-$DEFAULT_OUT}"

echo "[gateway-build-macos] backend dir: ${BACKEND_DIR}"
echo "[gateway-build-macos] output: ${OUTPUT_PATH}"

cd "${BACKEND_DIR}"
bash "${BACKEND_DIR}/packaging/install-agent-browser-bundle.sh"
bash "${BACKEND_DIR}/packaging/install-ripgrep-bundle.sh"

AB_BUNDLE="${BACKEND_DIR}/packaging/agent-browser-bundle"
echo "[gateway-build-macos] clearing quarantine xattrs on agent-browser bundle"
xattr -cr "${AB_BUNDLE}" 2>/dev/null || true

uv run pyinstaller --noconfirm --clean "packaging/windows/gateway.spec"

DIST_DIR="${BACKEND_DIR}/dist/evoflow-gateway"
if [[ ! -d "${DIST_DIR}" ]]; then
  echo "[gateway-build-macos] ERROR: PyInstaller output missing: ${DIST_DIR}"
  exit 1
fi

rm -rf "${OUTPUT_PATH}"
mkdir -p "${OUTPUT_PATH}"
cp -R "${DIST_DIR}/." "${OUTPUT_PATH}/"

AB_TARGET="${OUTPUT_PATH}/tools/agent-browser"
if [[ -d "${AB_BUNDLE}" ]]; then
  mkdir -p "${OUTPUT_PATH}/tools"
  rm -rf "${AB_TARGET}"
  case "${EVOFLOW_BUNDLE_CHROMIUM:-}" in
    1|true|TRUE|yes|YES|on|ON)
      ditto "${AB_BUNDLE}" "${AB_TARGET}"
      # Keep only newest chrome-* if multiple accumulated.
      if [[ -d "${AB_TARGET}/browsers" ]]; then
        mapfile -t chrome_dirs < <(find "${AB_TARGET}/browsers" -maxdepth 1 -type d -name 'chrome-*' | sort -r)
        if [[ "${#chrome_dirs[@]}" -gt 1 ]]; then
          for ((i = 1; i < ${#chrome_dirs[@]}; i++)); do
            echo "[gateway-build-macos] dropping older Chromium: ${chrome_dirs[$i]}"
            rm -rf "${chrome_dirs[$i]}"
          done
        fi
      fi
      ;;
    *)
      mkdir -p "${AB_TARGET}"
      # Copy everything except browsers/
      shopt -s dotglob nullglob
      for item in "${AB_BUNDLE}"/*; do
        base="$(basename "${item}")"
        if [[ "${base}" == "browsers" ]]; then
          continue
        fi
        cp -R "${item}" "${AB_TARGET}/${base}"
      done
      shopt -u dotglob nullglob
      echo "[gateway-build-macos] bundled agent-browser CLI only (Chromium excluded)"
      ;;
  esac
  echo "[gateway-build-macos] bundled agent-browser -> ${AB_TARGET}"
fi

if [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]]; then
  RG_SUBDIR="macos-arm64"
else
  RG_SUBDIR="macos-x64"
fi
RG_BUNDLE="${BACKEND_DIR}/packaging/ripgrep-bundle/${RG_SUBDIR}"
RG_TARGET="${OUTPUT_PATH}/tools/ripgrep"
if [[ -f "${RG_BUNDLE}/rg" ]]; then
  mkdir -p "${RG_TARGET}"
  cp "${RG_BUNDLE}/rg" "${RG_TARGET}/rg"
  chmod +x "${RG_TARGET}/rg"
  if [[ -f "${RG_BUNDLE}/COPYING" ]]; then
    cp "${RG_BUNDLE}/COPYING" "${RG_TARGET}/COPYING"
  fi
  echo "[gateway-build-macos] bundled ripgrep -> ${RG_TARGET}"
else
  echo "[gateway-build-macos] ripgrep bundle missing, skip: ${RG_BUNDLE}"
fi

CLI_TARGET="${OUTPUT_PATH}/tools/evoflow"
mkdir -p "${CLI_TARGET}"
cp "${BACKEND_DIR}/packaging/scripts/evoflow.sh" "${CLI_TARGET}/evoflow"
chmod +x "${CLI_TARGET}/evoflow" 2>/dev/null || true
echo "[gateway-build-macos] bundled evoflow CLI -> ${CLI_TARGET}"

SKILLS_ROOT="${REPO_ROOT}/skills"
PUBLIC_SKILLS="${SKILLS_ROOT}/public"
SKILLS_TARGET="${OUTPUT_PATH}/skills"
if [[ -d "${PUBLIC_SKILLS}" ]]; then
  rm -rf "${SKILLS_TARGET}"
  mkdir -p "${SKILLS_TARGET}"
  cp -R "${PUBLIC_SKILLS}" "${SKILLS_TARGET}/public"
  echo "[gateway-build-macos] bundled skills/public -> ${SKILLS_TARGET}/public"
  bash "${BACKEND_DIR}/packaging/scripts/prune-bundled-skills.sh" "${SKILLS_TARGET}/public"
else
  echo "[gateway-build-macos] skills/public not found, skip: ${PUBLIC_SKILLS}"
fi

chmod +x "${OUTPUT_PATH}/evoflow-gateway" 2>/dev/null || true
bash "${BACKEND_DIR}/packaging/assert-lean-gateway-bundle.sh" "${OUTPUT_PATH}"

# Guard: models router must be importable from the frozen bundle (v0.5.4 macOS 503).
MODELS_HIT="$(
  find "${OUTPUT_PATH}" \( -name 'models.py' -o -name 'models.pyc' -o -path '*/routers/models*' \) 2>/dev/null | head -n 5 || true
)"
if [[ -z "${MODELS_HIT}" ]]; then
  echo "[gateway-build-macos] ERROR: app.gateway.routers.models not found in bundle (would 503 /api/models)"
  exit 1
fi
echo "[gateway-build-macos] models router present: ${MODELS_HIT%%$'\n'*}"

bash "${BACKEND_DIR}/packaging/write-sidecar-manifest.sh" "${OUTPUT_PATH}"

echo "[gateway-build-macos] done"

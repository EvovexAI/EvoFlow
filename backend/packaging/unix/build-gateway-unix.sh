#!/usr/bin/env bash
# Build PyInstaller one-folder gateway for Linux (same spec as Windows/macOS).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${BACKEND_DIR}/.." && pwd)"
DEFAULT_OUT="${REPO_ROOT}/evopanel/src-tauri/binaries/evoflow-gateway"
OUTPUT_PATH="${1:-$DEFAULT_OUT}"

echo "[gateway-build-linux] backend dir: ${BACKEND_DIR}"
echo "[gateway-build-linux] output: ${OUTPUT_PATH}"

cd "${BACKEND_DIR}"
bash "${BACKEND_DIR}/packaging/install-agent-browser-bundle.sh"
bash "${BACKEND_DIR}/packaging/install-ripgrep-bundle.sh"

uv run pyinstaller --noconfirm --clean "packaging/windows/gateway.spec"

DIST_DIR="${BACKEND_DIR}/dist/evoflow-gateway"
if [[ ! -d "${DIST_DIR}" ]]; then
  echo "[gateway-build-linux] ERROR: PyInstaller output missing: ${DIST_DIR}"
  exit 1
fi

rm -rf "${OUTPUT_PATH}"
mkdir -p "${OUTPUT_PATH}"
cp -R "${DIST_DIR}/." "${OUTPUT_PATH}/"

AB_BUNDLE="${BACKEND_DIR}/packaging/agent-browser-bundle"
AB_TARGET="${OUTPUT_PATH}/tools/agent-browser"
if [[ -d "${AB_BUNDLE}" ]]; then
  mkdir -p "${OUTPUT_PATH}/tools"
  rm -rf "${AB_TARGET}"
  case "${EVOFLOW_BUNDLE_CHROMIUM:-}" in
    1|true|TRUE|yes|YES|on|ON)
      cp -R "${AB_BUNDLE}" "${AB_TARGET}"
      ;;
    *)
      mkdir -p "${AB_TARGET}"
      shopt -s dotglob nullglob
      for item in "${AB_BUNDLE}"/*; do
        base="$(basename "${item}")"
        [[ "${base}" == "browsers" ]] && continue
        cp -R "${item}" "${AB_TARGET}/${base}"
      done
      shopt -u dotglob nullglob
      echo "[gateway-build-linux] bundled agent-browser CLI only (Chromium excluded)"
      ;;
  esac
  echo "[gateway-build-linux] bundled agent-browser -> ${AB_TARGET}"
fi

RG_SUBDIR="linux-x64"
RG_BUNDLE="${BACKEND_DIR}/packaging/ripgrep-bundle/${RG_SUBDIR}"
RG_TARGET="${OUTPUT_PATH}/tools/ripgrep"
if [[ -f "${RG_BUNDLE}/rg" ]]; then
  mkdir -p "${RG_TARGET}"
  cp "${RG_BUNDLE}/rg" "${RG_TARGET}/rg"
  chmod +x "${RG_TARGET}/rg"
  if [[ -f "${RG_BUNDLE}/COPYING" ]]; then
    cp "${RG_BUNDLE}/COPYING" "${RG_TARGET}/COPYING"
  fi
  echo "[gateway-build-linux] bundled ripgrep -> ${RG_TARGET}"
else
  echo "[gateway-build-linux] ripgrep bundle missing, skip: ${RG_BUNDLE}"
fi

CLI_TARGET="${OUTPUT_PATH}/tools/evoflow"
mkdir -p "${CLI_TARGET}"
cp "${BACKEND_DIR}/packaging/scripts/evoflow.sh" "${CLI_TARGET}/evoflow"
chmod +x "${CLI_TARGET}/evoflow" "${CLI_TARGET}/evoflow.sh" 2>/dev/null || true
echo "[gateway-build-linux] bundled evoflow CLI -> ${CLI_TARGET}"

SKILLS_ROOT="${REPO_ROOT}/skills"
PUBLIC_SKILLS="${SKILLS_ROOT}/public"
SKILLS_TARGET="${OUTPUT_PATH}/skills"
if [[ -d "${PUBLIC_SKILLS}" ]]; then
  rm -rf "${SKILLS_TARGET}"
  mkdir -p "${SKILLS_TARGET}"
  cp -R "${PUBLIC_SKILLS}" "${SKILLS_TARGET}/public"
  echo "[gateway-build-linux] bundled skills/public -> ${SKILLS_TARGET}/public"
else
  echo "[gateway-build-linux] skills/public not found, skip: ${PUBLIC_SKILLS}"
fi

chmod +x "${OUTPUT_PATH}/evoflow-gateway" 2>/dev/null || true
bash "${BACKEND_DIR}/packaging/assert-lean-gateway-bundle.sh" "${OUTPUT_PATH}"
bash "${BACKEND_DIR}/packaging/write-sidecar-manifest.sh" "${OUTPUT_PATH}"
echo "[gateway-build-linux] done"

#!/usr/bin/env bash
# Download ripgrep into packaging/ripgrep-bundle for gateway builds and local dev.
set -euo pipefail

RIPGREP_VERSION="${RIPGREP_VERSION:-14.1.1}"
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUNDLE_ROOT="${BACKEND_DIR}/packaging/ripgrep-bundle"
TEMP_ROOT="${BACKEND_DIR}/.build-temp/ripgrep-download"

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "${os}" in
    Darwin)
      if [[ "${arch}" == "arm64" || "${arch}" == "aarch64" ]]; then
        echo "macos-arm64 aarch64-apple-darwin tar.gz"
      else
        echo "macos-x64 x86_64-apple-darwin tar.gz"
      fi
      ;;
    Linux)
      echo "linux-x64 x86_64-unknown-linux-musl tar.gz"
      ;;
    *)
      echo "[ripgrep-bundle] unsupported OS: ${os}" >&2
      exit 1
      ;;
  esac
}

read -r SUBDIR TRIPLE EXT <<<"$(detect_platform)"
TARGET_DIR="${BUNDLE_ROOT}/${SUBDIR}"
RG_BIN="${TARGET_DIR}/rg"
LICENSE_FILE="${TARGET_DIR}/COPYING"

if [[ -f "${RG_BIN}" && -f "${LICENSE_FILE}" && "${FORCE}" -ne 1 ]]; then
  echo "[ripgrep-bundle] already present under ${TARGET_DIR} (use --force to refresh)"
  exit 0
fi

ARCHIVE="ripgrep-${RIPGREP_VERSION}-${TRIPLE}.${EXT}"
URL="https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${ARCHIVE}"

rm -rf "${TEMP_ROOT}"
mkdir -p "${TEMP_ROOT}" "${TARGET_DIR}"

echo "[ripgrep-bundle] downloading ${URL}"
curl -fsSL "${URL}" -o "${TEMP_ROOT}/${ARCHIVE}"

EXTRACT_DIR="${TEMP_ROOT}/extract"
mkdir -p "${EXTRACT_DIR}"
tar -xzf "${TEMP_ROOT}/${ARCHIVE}" -C "${EXTRACT_DIR}"

INNER_ROOT="$(find "${EXTRACT_DIR}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [[ -z "${INNER_ROOT}" || ! -f "${INNER_ROOT}/rg" ]]; then
  echo "[ripgrep-bundle] rg binary missing in archive" >&2
  exit 1
fi

cp "${INNER_ROOT}/rg" "${RG_BIN}"
chmod +x "${RG_BIN}"
if [[ -f "${INNER_ROOT}/COPYING" ]]; then
  cp "${INNER_ROOT}/COPYING" "${LICENSE_FILE}"
else
  cat >"${LICENSE_FILE}" <<EOF
Ripgrep ${RIPGREP_VERSION}
Source: ${URL}
License: Unlicense / dual-licensed (see upstream ripgrep repository).
EOF
fi

rm -rf "${TEMP_ROOT}"
echo "[ripgrep-bundle] installed -> ${RG_BIN}"

#!/usr/bin/env bash
# EvoPanel macOS release: PyInstaller gateway -> Tauri DMG (same flow as build-installer-win.ps1).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVOPANEL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${EVOPANEL_DIR}/.." && pwd)"
MAC_BUILD_SCRIPT="${REPO_ROOT}/backend/packaging/macos/build-gateway-macos.sh"

echo "[build-installer-mac] evopanel: ${EVOPANEL_DIR}"
echo "[build-installer-mac] repo root: ${REPO_ROOT}"

if [[ ! -f "${MAC_BUILD_SCRIPT}" ]]; then
  echo "[build-installer-mac] ERROR: missing ${MAC_BUILD_SCRIPT}"
  exit 1
fi

# Sync version from evopanel/VERSION → package.json, Cargo.toml, tauri.conf.json
echo "[build-installer-mac] syncing version..."
node "${EVOPANEL_DIR}/scripts/sync-version.js"

BINARIES="${EVOPANEL_DIR}/src-tauri/binaries"
for legacy in \
  "${BINARIES}/evoflow-gateway.exe" \
  "${BINARIES}/backend-gateway.exe" \
  "${BINARIES}/backend-gateway-v2" \
  "${BINARIES}/evoflow-gateway-v2" \
  "${BINARIES}/backend-gateway"; do
  if [[ -e "${legacy}" ]]; then
    echo "[build-installer-mac] removing legacy: ${legacy}"
    rm -rf "${legacy}"
  fi
done

# Clean any stale gateway directory (e.g. Windows build artifacts from a
# previous cross-platform checkout) so they don't get bundled into the DMG.
GATEWAY_DIR_PRE="${EVOPANEL_DIR}/src-tauri/binaries/evoflow-gateway"
if [[ -d "${GATEWAY_DIR_PRE}" ]]; then
  echo "[build-installer-mac] cleaning stale gateway directory: ${GATEWAY_DIR_PRE}"
  rm -rf "${GATEWAY_DIR_PRE}"
fi

bash "${MAC_BUILD_SCRIPT}" "${EVOPANEL_DIR}/src-tauri/binaries/evoflow-gateway"

echo "[build-installer-mac] verifying gateway bundle..."
GATEWAY_DIR="${EVOPANEL_DIR}/src-tauri/binaries/evoflow-gateway"
GATEWAY_EXE="${GATEWAY_DIR}/evoflow-gateway"
if [[ ! -d "${GATEWAY_DIR}" ]]; then
  echo "[build-installer-mac] ERROR: gateway bundle directory not found at ${GATEWAY_DIR}"
  exit 1
fi
if [[ ! -f "${GATEWAY_EXE}" ]]; then
  echo "[build-installer-mac] ERROR: gateway executable missing at ${GATEWAY_EXE}"
  exit 1
fi
echo "[build-installer-mac] gateway bundle: ${GATEWAY_DIR} (dir)"
echo "[build-installer-mac] gateway executable: ${GATEWAY_EXE} ($(du -h "${GATEWAY_EXE}" | cut -f1))"

cd "${EVOPANEL_DIR}"

# Wipe stale Vite output so orphaned public/ copies cannot re-enter the DMG.
if [[ -d "${EVOPANEL_DIR}/dist" ]]; then
  echo "[build-installer-mac] cleaning stale frontend dist/"
  rm -rf "${EVOPANEL_DIR}/dist"
fi

# Validate signing key length; disable updater artifacts if key is invalid.
# CI sets TAURI_SIGNING_PRIVATE_KEY from secret; if format/password is off,
# Tauri fails with "failed to decode secret key" *after* building the DMG.
NOCONFIG=""
SIGN_KEY="${TAURI_SIGNING_PRIVATE_KEY:-}"
if [[ -n "${SIGN_KEY}" ]]; then
  SIGN_KEY="$(echo "${SIGN_KEY}" | tr -d '[:space:]')"
fi
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  echo "[build-installer-mac] updater signing: TAURI_SIGNING_PRIVATE_KEY_PATH"
elif [[ -n "${SIGN_KEY}" && "${#SIGN_KEY}" -ge 280 && -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
  echo "[build-installer-mac] updater signing: env key (${#SIGN_KEY} chars, password set)"
elif [[ -n "${SIGN_KEY}" && "${#SIGN_KEY}" -ge 280 ]]; then
  echo "[build-installer-mac] signing key present but no password — disabling updater artifacts"
  NOCONFIG="--config=src-tauri/tauri.ci-nosign.conf.json"
  unset TAURI_SIGNING_PRIVATE_KEY
elif [[ -f "${EVOPANEL_DIR}/src-tauri/updater-signing.key" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY_PATH="${EVOPANEL_DIR}/src-tauri/updater-signing.key"
  echo "[build-installer-mac] updater signing: ${TAURI_SIGNING_PRIVATE_KEY_PATH}"
else
  echo "[build-installer-mac] signing key unavailable — disabling updater artifacts"
  NOCONFIG="--config=src-tauri/tauri.ci-nosign.conf.json"
fi

# GHA macOS runners intermittently fail at hdiutil create with "Resource busy"
# (Spotlight / XProtect). Build .app once, then retry DMG-only with cleanup.
cleanup_hdiutil_state() {
  sync || true
  # Detach leftover volume mounts from a previous failed bundle_dmg.sh
  for mp in /Volumes/EvoFlow /Volumes/EvoFlow*; do
    if [[ -e "${mp}" ]]; then
      echo "[build-installer-mac] detaching leftover mount: ${mp}"
      hdiutil detach "${mp}" -force 2>/dev/null || true
    fi
  done
  # Stale read-write scratch images lock the next hdiutil create
  local target_root="${EVOPANEL_DIR}/src-tauri/target"
  if [[ -d "${target_root}" ]]; then
    find "${target_root}" \( -name 'rw.*.dmg' -o -name '.rw.*.dmg' \) -type f -delete 2>/dev/null || true
  fi
}

TAURI_BUILD_ARGS=(build --verbose)
if [[ -n "${NOCONFIG}" ]]; then
  TAURI_BUILD_ARGS+=("${NOCONFIG}")
fi
if [[ -n "${TAURI_BUILD_TARGET:-}" ]]; then
  echo "[build-installer-mac] tauri target: ${TAURI_BUILD_TARGET}"
  rustup target add "${TAURI_BUILD_TARGET}" 2>/dev/null || true
  TAURI_BUILD_ARGS+=(--target "${TAURI_BUILD_TARGET}")
fi

echo "[build-installer-mac] building .app (no dmg yet)..."
npm run tauri -- "${TAURI_BUILD_ARGS[@]}" --bundles app

DMG_ATTEMPTS="${TAURI_DMG_ATTEMPTS:-5}"
dmg_ok=0
for i in $(seq 1 "${DMG_ATTEMPTS}"); do
  cleanup_hdiutil_state
  if [[ "${i}" -gt 1 ]]; then
    delay=$(( (i - 1) * 8 ))
    echo "[build-installer-mac] DMG attempt ${i}/${DMG_ATTEMPTS} after ${delay}s (hdiutil Resource busy mitigation)..."
    sleep "${delay}"
  else
    echo "[build-installer-mac] bundling DMG (attempt ${i}/${DMG_ATTEMPTS})..."
  fi
  if npm run tauri -- "${TAURI_BUILD_ARGS[@]}" --bundles dmg; then
    dmg_ok=1
    break
  fi
  echo "[build-installer-mac] DMG attempt ${i} failed"
done

if [[ "${dmg_ok}" -ne 1 ]]; then
  echo "[build-installer-mac] ERROR: DMG bundling failed after ${DMG_ATTEMPTS} attempts (hdiutil Resource busy?)"
  exit 1
fi

echo "[build-installer-mac] done"

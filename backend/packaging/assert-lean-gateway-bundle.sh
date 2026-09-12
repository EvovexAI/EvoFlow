#!/usr/bin/env bash
# Fail the desktop build when lean defaults are violated (Chromium / torch present).
set -euo pipefail

GATEWAY_DIR="${1:-}"
if [[ -z "${GATEWAY_DIR}" || ! -d "${GATEWAY_DIR}" ]]; then
  echo "[lean-assert] gateway dir missing: ${GATEWAY_DIR:-"(empty)"}" >&2
  exit 1
fi

allow_chromium=0
allow_local_embed=0
case "${EVOFLOW_BUNDLE_CHROMIUM:-}" in 1|true|TRUE|yes|YES|on|ON) allow_chromium=1 ;; esac
case "${EVOFLOW_GATEWAY_INCLUDE_LOCAL_EMBEDDING:-}" in 1|true|TRUE|yes|YES|on|ON) allow_local_embed=1 ;; esac

errors=0
fail() {
  echo "  - $*" >&2
  errors=$((errors + 1))
}

browsers="${GATEWAY_DIR}/tools/agent-browser/browsers"
if [[ "${allow_chromium}" != "1" && -d "${browsers}" ]]; then
  fail "Chromium prebundled at ${browsers}. Unset EVOFLOW_BUNDLE_CHROMIUM and rebuild."
fi

torch="${GATEWAY_DIR}/_internal/torch"
if [[ "${allow_local_embed}" != "1" && -d "${torch}" ]]; then
  fail "torch bundled at ${torch}. Unset EVOFLOW_GATEWAY_INCLUDE_LOCAL_EMBEDDING and rebuild."
fi

st="${GATEWAY_DIR}/_internal/sentence_transformers"
if [[ "${allow_local_embed}" != "1" && -d "${st}" ]]; then
  fail "sentence_transformers bundled at ${st}."
fi

total_kb=$(du -sk "${GATEWAY_DIR}" 2>/dev/null | awk '{print $1}')
total_mb=$(( total_kb / 1024 ))
if [[ "${allow_chromium}" != "1" && "${allow_local_embed}" != "1" && "${total_mb}" -gt 900 ]]; then
  fail "Gateway sidecar is ${total_mb} MB (lean limit 900MB)."
fi

if [[ "${errors}" -gt 0 ]]; then
  echo "[lean-assert] FAILED for ${GATEWAY_DIR} (${total_mb} MB, ${errors} issue(s))" >&2
  exit 1
fi

echo "[lean-assert] OK: ${GATEWAY_DIR} (${total_mb} MB; chromium=${allow_chromium} localEmbed=${allow_local_embed})"

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
allow_whisper=0
case "${EVOFLOW_BUNDLE_CHROMIUM:-}" in 1|true|TRUE|yes|YES|on|ON) allow_chromium=1 ;; esac
case "${EVOFLOW_GATEWAY_INCLUDE_LOCAL_EMBEDDING:-}" in 1|true|TRUE|yes|YES|on|ON) allow_local_embed=1 ;; esac
case "${EVOFLOW_BUNDLE_WHISPER:-}" in 1|true|TRUE|yes|YES|on|ON) allow_whisper=1 ;; esac

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

whisper="${GATEWAY_DIR}/tools/whisper"
if [[ "${allow_whisper}" != "1" && -d "${whisper}" ]]; then
  fail "Whisper ASR bundled at ${whisper}. Unset EVOFLOW_BUNDLE_WHISPER and rebuild."
fi

# Official plugins: single in-package copy only (no sidecar duplicate).
sidecar_dup="${GATEWAY_DIR}/official-plugins-bundle"
if [[ -d "${sidecar_dup}" ]]; then
  fail "duplicate official-plugins-bundle sidecar present (use _internal/evoflow/plugins/bundled_official only)"
fi

# PyInstaller onefile-folder layout uses _internal/; some trees may nest evoflow under Contents.
official_bundle=""
for candidate in \
  "${GATEWAY_DIR}/_internal/evoflow/plugins/bundled_official" \
  "${GATEWAY_DIR}/evoflow/plugins/bundled_official"
do
  if [[ -d "${candidate}" ]]; then
    official_bundle="${candidate}"
    break
  fi
done

required_official=(
  browser-use computer-use node-repl-host documents pdf
  presentations spreadsheets image-search plugin-creator skill-creator
)
if [[ -z "${official_bundle}" ]]; then
  fail "bundled_official missing under ${GATEWAY_DIR} (sync official-plugins-bundle before PyInstaller)"
else
  for name in "${required_official[@]}"; do
    versioned=0
    if [[ -d "${official_bundle}/${name}" ]]; then
      shopt -s nullglob
      for ver in "${official_bundle}/${name}"/*/; do
        base="$(basename "${ver}")"
        [[ "${base}" == "0.0.0-stub" ]] && continue
        if [[ -f "${ver}.zcode-plugin/plugin.json" || -f "${ver}.evoflow-plugin/plugin.json" ]]; then
          versioned=1
          break
        fi
      done
      shopt -u nullglob
    fi
    if [[ "${versioned}" -ne 1 ]]; then
      fail "official plugin missing/stub in bundled_official: ${name} (need <version>/.zcode-plugin)"
    fi
  done
  helper_entry="${official_bundle}/cua-helper/runtime/dist/windows-helper.js"
  helper_addon="${official_bundle}/cua-helper/runtime/build/Release/ax_native.node"
  if [[ ! -f "${helper_entry}" || ! -f "${helper_addon}" ]]; then
    fail "cua-helper runtime incomplete under bundled_official (need windows-helper.js + ax_native.node)"
  elif [[ "$(wc -c < "${helper_addon}" | tr -d ' ')" -le 1024 ]]; then
    fail "cua-helper ax_native.node looks like a stub under bundled_official"
  fi
fi

# Asset Hub memory templates (Phase2 consolidate). PyInstaller must ship prompts/.
consolidation=""
for candidate in \
  "${GATEWAY_DIR}/_internal/evoflow/assets/prompts/memories/consolidation.md" \
  "${GATEWAY_DIR}/evoflow/assets/prompts/memories/consolidation.md"
do
  if [[ -f "${candidate}" ]]; then
    consolidation="${candidate}"
    break
  fi
done
if [[ -z "${consolidation}" ]]; then
  fail "memory prompt missing: evoflow/assets/prompts/memories/consolidation.md (Phase2 FileNotFoundError on startup)"
fi

# Builtin user guide for owned KB seed (小V knowledge search).
user_guide=""
for candidate in \
  "${GATEWAY_DIR}/_internal/evoflow/assets/builtin_knowledge_vaults/user-guide" \
  "${GATEWAY_DIR}/evoflow/assets/builtin_knowledge_vaults/user-guide"
do
  if [[ -d "${candidate}" ]]; then
    user_guide="${candidate}"
    break
  fi
done
if [[ -z "${user_guide}" ]]; then
  fail "builtin user-guide missing: evoflow/assets/builtin_knowledge_vaults/user-guide"
else
  md_count=$(find "${user_guide}" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${md_count}" -lt 1 ]]; then
    fail "builtin user-guide has no .md files under ${user_guide}"
  fi
fi

# Xiaomi Frame voice ONNX (skip macOS Intel — pipecat-ai omitted there).
require_voice_onnx=1
if [[ "$(uname -s 2>/dev/null)" == "Darwin" && "$(uname -m 2>/dev/null)" == "x86_64" ]]; then
  require_voice_onnx=0
fi
if [[ "${require_voice_onnx}" == "1" ]]; then
  silero_count=$(find "${GATEWAY_DIR}" -type f -name 'silero_vad.onnx' 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${silero_count}" -lt 1 ]]; then
    fail "pipecat Silero ONNX missing (silero_vad.onnx). Rebuild with gateway.spec collect_data_files(pipecat) or Xiaomi voice fails at VAD load."
  fi
fi

total_kb=$(du -sk "${GATEWAY_DIR}" 2>/dev/null | awk '{print $1}')
total_mb=$(( total_kb / 1024 ))
if [[ "${allow_chromium}" != "1" && "${allow_local_embed}" != "1" && "${allow_whisper}" != "1" && "${total_mb}" -gt 900 ]]; then
  fail "Gateway sidecar is ${total_mb} MB (lean limit 900MB)."
fi

if [[ "${errors}" -gt 0 ]]; then
  echo "[lean-assert] FAILED for ${GATEWAY_DIR} (${total_mb} MB, ${errors} issue(s))" >&2
  exit 1
fi

echo "[lean-assert] OK: ${GATEWAY_DIR} (${total_mb} MB; chromium=${allow_chromium} localEmbed=${allow_local_embed} whisper=${allow_whisper})"

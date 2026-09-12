#!/usr/bin/env bash
# Prune oversized / non-runtime skill payloads after copying skills/public into the gateway bundle.
# Also drop skills that must not ship in the public installer, and refuse OpenClaw residue.
# Usage: bash prune-bundled-skills.sh /path/to/skills/public

set -euo pipefail

SKILLS_PUBLIC="${1:-}"
if [[ -z "${SKILLS_PUBLIC}" || ! -d "${SKILLS_PUBLIC}" ]]; then
  echo "[skills-prune] skip: missing ${SKILLS_PUBLIC:-<empty>}"
  exit 0
fi

dir_bytes() {
  local p="$1"
  if [[ -d "$p" ]]; then
    du -sk "$p" 2>/dev/null | awk '{print $1 * 1024}'
  else
    echo 0
  fi
}

remove_rel() {
  local rel="$1"
  local full="${SKILLS_PUBLIC}/${rel}"
  if [[ ! -e "$full" ]]; then
    return 0
  fi
  local bytes
  bytes="$(dir_bytes "$full")"
  rm -rf "$full"
  local mb
  mb="$(awk -v b="$bytes" 'BEGIN { printf "%.1f", b/1024/1024 }')"
  echo "[skills-prune] removed ${rel} (~${mb} MB)"
  REMOVED=$((REMOVED + bytes))
}

REMOVED=0
remove_rel "hyperframes-animation/examples"

# Not redistributed in public desktop builds (.gitignore scrubbed packs).
for skill in \
  desktop-control \
  wechat-chat \
  content-hunter \
  canvas \
  gh-issues \
  newmedia-operations \
  aihot \
  wechat-mp-writer-skill-mxx
do
  remove_rel "${skill}"
done

# Safety net: any leftover node_modules
while IFS= read -r -d '' nm; do
  bytes="$(dir_bytes "$nm")"
  rel="${nm#"${SKILLS_PUBLIC}/"}"
  rm -rf "$nm"
  mb="$(awk -v b="$bytes" 'BEGIN { printf "%.1f", b/1024/1024 }')"
  echo "[skills-prune] removed ${rel} (~${mb} MB)"
  REMOVED=$((REMOVED + bytes))
done < <(find "${SKILLS_PUBLIC}" -type d -name node_modules -print0 2>/dev/null || true)

# Brand gate (bash 3.2–compatible: no mapfile)
BRAND_HITS=()
while IFS= read -r f; do
  [[ -n "${f}" ]] || continue
  BRAND_HITS+=("${f}")
done < <(
  find "${SKILLS_PUBLIC}" -type f \
    \( -name '*.md' -o -name '*.js' -o -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.json' -o -name '*.yml' -o -name '*.yaml' -o -name '*.txt' \) \
    -print0 2>/dev/null |
    xargs -0 grep -Il -E -i 'openclaw|\.openclaw' 2>/dev/null || true
)
if [[ ${#BRAND_HITS[@]} -gt 0 ]]; then
  echo "[skills-prune] OpenClaw residue in bundled skills:" >&2
  i=0
  for f in "${BRAND_HITS[@]}"; do
    echo "  - ${f#"${SKILLS_PUBLIC}/"}" >&2
    i=$((i + 1))
    [[ "${i}" -ge 30 ]] && break
  done
  echo "[skills-prune] refusing to ship skills with OpenClaw / ~/.openclaw residue (${#BRAND_HITS[@]} file(s))" >&2
  exit 1
fi

TOTAL_MB="$(awk -v b="$REMOVED" 'BEGIN { printf "%.1f", b/1024/1024 }')"
echo "[skills-prune] total removed ~${TOTAL_MB} MB from ${SKILLS_PUBLIC}"

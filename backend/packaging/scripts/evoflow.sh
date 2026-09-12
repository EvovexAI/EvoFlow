#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GW="${DIR}/../../evoflow-gateway"
if [[ ! -x "${GW}" ]]; then
  GW="${DIR}/../evoflow-gateway"
fi
if [[ -x "${GW}" ]]; then
  exec "${GW}" --mode cli "$@"
fi
echo "evoflow: evoflow-gateway not found next to bundled CLI (expected under tools/evoflow)" >&2
exit 127

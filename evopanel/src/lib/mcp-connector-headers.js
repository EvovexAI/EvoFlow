/**
 * MCP connector wizard helpers for optional HTTP/SSE request headers.
 */

export function emptyMcpHeaderRow() {
  return { key: '', value: '' }
}

/** Build MCP `headers` object from wizard rows; skips blank keys. */
export function headersFromWizardRows(rows) {
  const out = {}
  for (const row of rows || []) {
    const key = String(row?.key || '').trim()
    if (!key) continue
    out[key] = String(row?.value ?? '')
  }
  return out
}

export function isRemoteMcpType(type) {
  const t = String(type || '').toLowerCase()
  return t === 'sse' || t === 'http' || t === 'streamable_http' || t === 'streamable-http'
}

export function mcpTransportLabel(config) {
  const t = String(config?.type || config?.transport || 'stdio').toLowerCase()
  if (t === 'sse') return 'SSE'
  if (t === 'http' || t === 'streamable_http' || t === 'streamable-http' || t === 'streamablehttp') {
    return 'HTTP（Streamable）'
  }
  return 'Stdio'
}

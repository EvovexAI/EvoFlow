import { describe, expect, it } from 'vitest'
import {
  emptyMcpHeaderRow,
  headersFromWizardRows,
  isRemoteMcpType,
  mcpTransportLabel,
} from '../src/lib/mcp-connector-headers.js'

describe('headersFromWizardRows', () => {
  it('skips blank keys and keeps values including $VAR refs', () => {
    expect(
      headersFromWizardRows([
        { key: 'Authorization', value: 'Bearer $MCP_TOKEN' },
        { key: '  ', value: 'ignored' },
        { key: 'X-Custom', value: '' },
        emptyMcpHeaderRow(),
      ]),
    ).toEqual({
      Authorization: 'Bearer $MCP_TOKEN',
      'X-Custom': '',
    })
  })

  it('returns empty object for empty input', () => {
    expect(headersFromWizardRows([])).toEqual({})
    expect(headersFromWizardRows(null)).toEqual({})
  })
})

describe('isRemoteMcpType / mcpTransportLabel', () => {
  it('treats http aliases as remote streamable http', () => {
    expect(isRemoteMcpType('http')).toBe(true)
    expect(isRemoteMcpType('sse')).toBe(true)
    expect(isRemoteMcpType('streamable-http')).toBe(true)
    expect(isRemoteMcpType('stdio')).toBe(false)
    expect(mcpTransportLabel({ type: 'http' })).toBe('HTTP（Streamable）')
    expect(mcpTransportLabel({ type: 'sse' })).toBe('SSE')
    expect(mcpTransportLabel({ type: 'stdio' })).toBe('Stdio')
  })
})

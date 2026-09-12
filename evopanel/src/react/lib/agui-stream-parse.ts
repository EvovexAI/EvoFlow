/**
 * Parse AG-UI SSE wire frames and validate with @ag-ui/core EventSchemas.
 */
import { EventSchemas } from '@ag-ui/core'
import type { AGUIEvent } from '@ag-ui/core'

import { isStreamCompareFileLogOn } from './stream-compare-file-log.js'

export type ParsedAgUiWireFrame =
  | { ok: true; event: AGUIEvent }
  | { ok: false; raw: unknown; error: string }

export function parseAgUiSseData(dataRaw: string): ParsedAgUiWireFrame {
  const trimmed = String(dataRaw || '').trim()
  if (!trimmed) return { ok: false, raw: null, error: 'empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, raw: trimmed, error: 'json_parse_failed' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, raw: parsed, error: 'not_object' }
  }
  try {
    const event = EventSchemas.parse(parsed) as AGUIEvent
    return { ok: true, event }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, raw: parsed, error: msg }
  }
}

export function isAgUiEventType(type: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(String(type || '').trim())
}

export function logAgUiParseDiagnostic(detail: Record<string, unknown>): void {
  if (!isStreamCompareFileLogOn()) return
  console.debug('[agui-parse]', detail)
}

/**
 * 控制台镜像「流式气泡」当前实际渲染内容（与 MessageRow _stream 数据源一致）。
 * - **[流式来源]** 默认常驻（仅 run / 续流来源，不输出正文）；关闭：localStorage.setItem('EVOFLOW_STREAM_SOURCE_CONSOLE','0')
 * - 时间线调试见 stream-turn-debug.ts（EVOFLOW_STREAM_TURN_DEBUG=1 才开）
 * - Plan 链路见 plan-trace.js（控制台过滤 `[plan]`）
 * - 本模块旧开关 EVOFLOW_STREAM_PAGE_MIRROR 仍控制是否附带「合并正文+工具」完整摘要
 */

import { flattenStreamDisplayTextRaw } from '../lib/chat-normalize.js'
import type { DisplayRow } from './chat-types.js'
import { deriveAttachState, getSessionRuntime, type StreamWireSource } from './lib/session-runtime-store.js'
import {
  // @ts-ignore
  formatStreamTurnTimelineMirror,
  isStreamTurnTimelineDebugOn,
  logStreamTurnTimelineIfChanged,
  resetStreamTurnTimelineDedupe,
} from './lib/stream-turn-debug.js'

const SOURCE_PREFIX = '[流式来源]'

function isTauriDesktop(): boolean {
  try {
    return typeof window !== 'undefined' && !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  } catch {
    return false
  }
}

/** 常驻流来源镜像（默认开；仅输出 run / 续流来源，不输出正文） */
export function isStreamSourceConsoleOn(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    const v =
      localStorage.getItem('EVOFLOW_STREAM_SOURCE_CONSOLE') ??
      localStorage.getItem('EVOFLOW_STREAM_BODY_CONSOLE')
    if (v === '0') return false
    if (v === '1') return true
    return true
  } catch {
    return true
  }
}

export function resolveStreamWireSource(sessionKey?: string | null): {
  label: string
  wire: StreamWireSource
  attachState: string
  catchup: boolean
} {
  const sk = String(sessionKey || '').trim()
  if (!sk) return { label: 'unknown', wire: null, attachState: 'idle', catchup: false }
  const rt = getSessionRuntime(sk)
  const attach = deriveAttachState(rt)
  const catchup = !!rt.resumeCatchupReplay
  const wire = rt.streamWireSource ?? null

  if (catchup) {
    return { label: '续流·catchup', wire: wire ?? 'attach', attachState: attach, catchup: true }
  }
  if (wire === 'attach') {
    return { label: '续流·attach', wire, attachState: attach, catchup: false }
  }
  if (wire === 'run') {
    return { label: 'run', wire, attachState: attach, catchup: false }
  }
  if (rt.turnPhase === 'reattaching') {
    return { label: '续流·connecting', wire: 'attach', attachState: attach, catchup: false }
  }
  return { label: 'unknown', wire: null, attachState: attach, catchup: false }
}

export function isStreamConsoleMirrorOn(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    const v = localStorage.getItem('EVOFLOW_STREAM_PAGE_MIRROR')
    if (v === '1') return true
    if (v === '0') return false
    // Tauri：console-file-log 会把每条 log invoke 写盘，流式时易拖死整窗
    if (isTauriDesktop()) return false
    if (import.meta.env.PROD) return false
    return true
  } catch {
    return false
  }
}

function jsonMirror(v: unknown, maxLen = 4000): string {
  if (v == null) return ''
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return ''
    return s.length > maxLen ? `${s.slice(0, maxLen)}…(共${s.length}字)` : s
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    const s = JSON.stringify(v)
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s
  } catch {
    return String(v)
  }
}

/** 控制台专用：大段写入内容只保留长度 + 开头一点，避免刷屏 */
function shrinkWriteContentField(obj: Record<string, unknown>): Record<string, unknown> {
  const next = { ...obj }
  if (typeof next.content === 'string' && next.content.length > 120) {
    const c = next.content
    const head = c.slice(0, 72).replace(/\s+/g, ' ')
    next.content = `〈${c.length} 字〉 ${head}…`
  }
  return next
}

/** 与页面合并态可能仍为 running；从 args / output 里补「业务态」便于读日志 */
function effectiveToolStatusLabel(o: Record<string, unknown>): string {
  const ui = String(o.status || '').trim() || '—'
  const input = (o.input ?? (o as { arguments?: unknown }).arguments) as unknown
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const p = input as Record<string, unknown>
    const inner = typeof p.status === 'string' ? p.status.trim() : ''
    if (inner) return inner !== ui ? `${ui}→${inner}` : ui
  }
  const out = o.output
  if (out == null || out === '') return ui
  let j: Record<string, unknown> | null = null
  if (typeof out === 'string') {
    try {
      const parsed = JSON.parse(out) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) j = parsed as Record<string, unknown>
    } catch {
      /* 非 JSON 字符串 */
    }
  } else if (typeof out === 'object' && !Array.isArray(out)) {
    j = out as Record<string, unknown>
  }
  if (j) {
    if (typeof j.status === 'string' && j.status.trim()) {
      const js = j.status.trim()
      return js !== ui ? `${ui}→${js}` : ui
    }
    if (j.success === true) return ui === 'running' || !ui ? 'done' : `${ui}→ok`
  }
  return ui
}

function argsMirrorForConsole(input: unknown, toolName: string): string {
  if (input == null) return ''
  const n = toolName.toLowerCase()
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    let o = { ...(input as Record<string, unknown>) }
    if (n.includes('write') || n.includes('file')) {
      o = shrinkWriteContentField(o)
    }
    return jsonMirror(o, 2000)
  }
  return jsonMirror(input, 2000)
}

function outputMirrorForConsole(output: unknown, toolName: string): string {
  if (output == null || output === '') return ''
  const n = toolName.toLowerCase()
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (n.includes('write') || n.includes('file'))) {
        return jsonMirror(shrinkWriteContentField(parsed as Record<string, unknown>), 2000)
      }
    } catch {
      /* 原样截断 */
    }
    return jsonMirror(output, 2000)
  }
  if (typeof output === 'object' && !Array.isArray(output) && (n.includes('write') || n.includes('file'))) {
    return jsonMirror(shrinkWriteContentField(output as Record<string, unknown>), 2000)
  }
  return jsonMirror(output, 2000)
}

function toolLineMirror(t: unknown): string {
  if (!t || typeof t !== 'object') return '(无效工具)'
  const o = t as Record<string, unknown>
  const id = String(o.id || o.tool_call_id || '').trim() || '-'
  const name = String(o.name || o.tool_name || 'tool').trim()
  const status = effectiveToolStatusLabel(o)
  const input = 'input' in o ? o.input : (o as { arguments?: unknown }).arguments
  const inputStr = argsMirrorForConsole(input, name)
  const outStr = outputMirrorForConsole(o.output, name)
  const bits = [`${name}`, `id=${id}`, `status=${status}`]
  if (inputStr) bits.push(`args=${inputStr}`)
  if (outStr) bits.push(`result=${outStr}`)
  return bits.join(' | ')
}

/** 与 AssistantBody 数据源一致：segments 顺序 + 尾 text + tools 列表 */
export function formatStreamBubbleMirrorText(row: DisplayRow): string {
  const text = flattenStreamDisplayTextRaw(row.segments || [], row.text || '')
  const tools = (row.tools || []) as unknown[]
  const lines: string[] = ['[流式页·当前渲染]']
  lines.push(text ? `正文: ${text}` : '正文: (空)')
  if (!tools.length) {
    lines.push('工具: (无)')
  } else {
    lines.push(`工具: ${tools.length} 个`)
    for (let i = 0; i < tools.length; i++) {
      lines.push(`  ${i + 1}. ${toolLineMirror(tools[i])}`)
    }
  }
  return lines.join('\n')
}

let lastMirrorSig = ''
let lastSourceSig = ''
let sourceBootLogged = false

export function resetStreamMirrorDedupe(): void {
  lastMirrorSig = ''
  lastSourceSig = ''
  resetStreamTurnTimelineDedupe()
}

/** 常驻：控制台输出当前流来源（run / 续流），来源变化时才打 */
export function logStreamSourceConsoleIfChanged(row: DisplayRow, sessionKey?: string | null): void {
  if (row.role !== '_stream') return
  if (!isStreamSourceConsoleOn()) return

  const runId = String(row.runId || '').trim() || '-'
  const source = resolveStreamWireSource(sessionKey)
  const phase = String(row.streamTextPhase || '').trim() || null
  const sig = `${runId}\0${source.label}\0${source.wire}\0${source.attachState}\0${source.catchup}\0${phase}`
  if (sig === lastSourceSig) return
  lastSourceSig = sig

  if (!sourceBootLogged) {
    sourceBootLogged = true
     
    console.info(
      `${SOURCE_PREFIX} 常驻；wire=run|stream-resume|attach；关闭 localStorage.setItem('EVOFLOW_STREAM_SOURCE_CONSOLE','0')`,
    )
  }

   
  console.info(SOURCE_PREFIX, {
    source: source.label,
    wire: source.wire,
    attachState: source.attachState,
    catchup: source.catchup,
    runId,
    phase,
  })
}

/** 内容相对上次未变则不打（避免 React 重复渲染刷屏） */
export function logStreamBubbleMirrorIfChanged(row: DisplayRow): void {
  if (row.role === '_stream') {
    logStreamTurnTimelineIfChanged({
      segments: row.segments || [],
      openText: row.text || '',
      streamTextPhase: row.streamTextPhase,
      tools: row.tools || [],
      reasoningSegments: row.reasoningSegments,
    })
  }

  if (!isStreamConsoleMirrorOn() && !isStreamTurnTimelineDebugOn()) return
  const block = formatStreamBubbleMirrorText(row)
  if (block === lastMirrorSig) return
  lastMirrorSig = block
  if (!isStreamConsoleMirrorOn()) return
   
  console.log(block)
}
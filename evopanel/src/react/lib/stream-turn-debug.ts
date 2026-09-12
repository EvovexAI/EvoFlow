/**
 * 流式轮次调试：结构化时间线（正文 / 思考 / 工具 / Exploring），正文截断，便于复制给排查。
 *
 * - 默认关；开启：localStorage.setItem('EVOFLOW_STREAM_TURN_DEBUG', '1')
 * - 逐条 WS 事件：随时间线开；单独关：localStorage.setItem('EVOFLOW_STREAM_TURN_EVENTS', '0')
 * - Plan / 底部确认条：见 plan-trace.js（控制台过滤 `[plan]`）
 */
import type { MessageSegment } from '../chat-types.js'
import { splitToolIdsForExploring } from './exploring-activity-group.js'
import { resolveEffectiveToolName } from '../../lib/tool-display.js'

export function isStreamTurnTimelineDebugOn(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem('EVOFLOW_STREAM_TURN_DEBUG') === '1'
  } catch {
    return false
  }
}

export function isStreamTurnEventsDebugOn(): boolean {
  if (!isStreamTurnTimelineDebugOn()) return false
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem('EVOFLOW_STREAM_TURN_EVENTS') !== '0'
  } catch {
    return false
  }
}

/** 控制台用 log（debug 级别在 DevTools 默认被过滤） */
function streamDebugLog(...args: unknown[]): void {
   
  console.log(...args)
}

/** 控制台一行内展示字符数（不含省略标记） */
export function shrinkStreamDebugText(raw: unknown, max = 56): string {
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return '(空)'
  if (s.length <= max) return `「${s}」`
  return `「${s.slice(0, max)}…」(${s.length}字)`
}

function toolChip(id: string, tools: unknown[]): string {
  const row = tools.find((t) => {
    const o = t as Record<string, unknown>
    const rid = String(o.id || o.tool_call_id || '').trim()
    return rid === id
  }) as Record<string, unknown> | undefined
  const name = row ? resolveEffectiveToolName(row) : 'tool'
  const shortId = id.length > 10 ? id.slice(-8) : id
  return `${name}:${shortId}`
}

function formatToolsSegment(seg: Extract<MessageSegment, { kind: 'tools' }>, tools: unknown[]): string {
  const { exploring, standalone } = splitToolIdsForExploring(seg.ids, tools, false)
  const bits: string[] = []
  if (exploring.length) {
    bits.push(`exploring×${exploring.length} [${exploring.map((id) => toolChip(id, tools)).join(', ')}]`)
  }
  if (standalone.length) {
    bits.push(`standalone×${standalone.length} [${standalone.map((id) => toolChip(id, tools)).join(', ')}]`)
  }
  if (!bits.length) bits.push(`ids×${seg.ids.length}`)
  return bits.join(' + ')
}

/** 与 stream-turn-engine 投影一致：时间线 + 开写尾文 */
export function formatStreamTurnTimelineMirror(opts: {
  segments: MessageSegment[]
  openText: string
  streamTextPhase?: 'pre_tools' | 'post_tools' | null
  tools: unknown[]
  reasoningSegments?: string[]
}): string {
  const { segments, openText, streamTextPhase, tools, reasoningSegments } = opts
  const lines: string[] = []
  const phase = streamTextPhase || 'pre_tools'
  const tailLen = String(openText || '').trim().length
  const rs = (reasoningSegments || []).filter((s) => String(s || '').trim())
  lines.push(
    `[stream-turn] phase=${phase} | timeline=${segments.length}段 | tail=${tailLen}字` +
      (rs.length ? ` | reasoning段=${rs.length}` : ''),
  )

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg.kind === 'text') {
      const label =
        i === 0 && !segments.some((s, j) => j < i && s.kind === 'tools')
          ? 'text·plan'
          : segments.some((s, j) => j < i && s.kind === 'tools')
            ? 'text·inter'
            : 'text'
      lines.push(`  #${i} ${label} ${shrinkStreamDebugText(seg.text)}`)
    } else if (seg.kind === 'reasoning') {
      lines.push(`  #${i} reasoning ${shrinkStreamDebugText(seg.text)}`)
    } else if (seg.kind === 'tools') {
      lines.push(`  #${i} tools ${formatToolsSegment(seg, tools)}`)
    }
  }

  if (tailLen) {
    const tailLabel = phase === 'post_tools' ? 'tail·post' : 'tail·live'
    lines.push(`  … ${tailLabel} ${shrinkStreamDebugText(openText)}`)
  }

  return lines.join('\n')
}

let lastTimelineSig = ''

export function resetStreamTurnTimelineDedupe(): void {
  lastTimelineSig = ''
}

export function logStreamTurnTimelineIfChanged(opts: Parameters<typeof formatStreamTurnTimelineMirror>[0]): void {
  if (!isStreamTurnTimelineDebugOn()) return
  const block = formatStreamTurnTimelineMirror(opts)
  if (block === lastTimelineSig) return
  lastTimelineSig = block
  streamDebugLog(block)
}

/** 单条归约事件（默认随 EVOFLOW_STREAM_TURN_DEBUG 开） */
export function logStreamTurnEvent(
  event: string,
  detail: Record<string, string | number | boolean | undefined>,
): void {
  if (!isStreamTurnEventsDebugOn()) return
  const parts = Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`)
  streamDebugLog(`[stream-event] ${event}${parts.length ? ' ' + parts.join(' ') : ''}`)
}

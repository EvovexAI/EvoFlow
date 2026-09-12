/**
 * Ask / Agent / Plan 会话模式：与后端 intent_tool_profile、Gateway session-modes 对齐。
 */

import {
  normalizeScenarioKeyForUi,
  parseScenarioToolOutputBlob,
  pickDisplayChatSceneFromScenarioResult,
} from '../../lib/chat-normalize.js'
import { wsClient } from '../../lib/ws-client.js'

export type SessionMode = 'flash' | 'auto' | 'thinking' | 'pro' | 'ultra' | 'ask' | 'agent' | 'plan'

export type ChatSceneId = 'ask' | 'plan' | 'agent'

export type SessionModeDefinition = {
  value: string
  label: string
  visible: boolean
  scenario: string | null
}

/** 模式 → 后端 activated_scenarios 键（与 Gateway _SESSION_MODE_DEFINITIONS 一致） */
export const MODE_TO_SCENARIO: Record<SessionMode, string | null> = {
  auto: null,
  ask: 'ask',
  agent: 'agent',
  plan: 'plan',
  flash: null,
  thinking: null,
  pro: null,
  ultra: null,
}

export const DEFAULT_SESSION_MODES: SessionModeDefinition[] = [
  { value: 'auto', label: 'Auto', visible: false, scenario: null },
  { value: 'ask', label: 'Ask', visible: true, scenario: 'ask' },
  { value: 'agent', label: 'Agent', visible: true, scenario: 'agent' },
  { value: 'plan', label: 'Plan', visible: true, scenario: 'plan' },
  { value: 'flash', label: '闪速', visible: false, scenario: null },
  { value: 'thinking', label: '思考', visible: false, scenario: null },
  { value: 'pro', label: 'Pro', visible: false, scenario: null },
  { value: 'ultra', label: 'Ultra', visible: false, scenario: null },
]

export const SESSION_MODES: Array<{ value: SessionMode; label: string }> = DEFAULT_SESSION_MODES.map((m) => ({
  value: m.value as SessionMode,
  label: m.label,
}))

export const SHOW_SESSION_MODE_COLLAB_UI = true

export const VALID_SESSION_MODES: SessionMode[] = [
  'flash',
  'auto',
  'thinking',
  'pro',
  'ultra',
  'ask',
  'agent',
  'plan',
]

const STORAGE_SESSION_META_KEY = 'evopanel-chat-session-meta'

const LEGACY_SPEED_SESSION_MODES: SessionMode[] = ['flash', 'thinking', 'pro', 'ultra']

/** 已下线的 UI 模式，展示与选择器统一回落到 Agent */
const LEGACY_DEPRECATED_SESSION_MODES: SessionMode[] = ['auto', ...LEGACY_SPEED_SESSION_MODES]

function safeReadSessionMetaMap(): Record<string, unknown> {
  try {
    return JSON.parse(
      localStorage.getItem(STORAGE_SESSION_META_KEY) || localStorage.getItem('evopanel-chat-session-meta-v1') || '{}',
    ) as Record<string, unknown>
  } catch {
    return {}
  }
}

function safeWriteSessionMetaMap(map: Record<string, unknown>) {
  try {
    localStorage.setItem(STORAGE_SESSION_META_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

export function normalizeSessionModeForUi(mode: SessionMode): SessionMode {
  if (LEGACY_DEPRECATED_SESSION_MODES.includes(mode)) return 'agent'
  return mode
}

export function resolveChatSceneId(raw: string | null | undefined): ChatSceneId {
  const v = normalizeScenarioKeyForUi(String(raw || ''))
  if (v === 'ask' || v === 'agent' || v === 'plan') return v
  return 'ask'
}

export function chatSceneToSessionMode(scene: string | null | undefined): SessionMode | null {
  const id = resolveChatSceneId(scene)
  if (id === 'ask' || id === 'agent' || id === 'plan') return id
  return null
}

export function modeLabel(mode: SessionMode, modes?: Array<{ value: string; label: string }>): string {
  const list = modes || SESSION_MODES
  const uiMode = normalizeSessionModeForUi(mode)
  const row = list.find((m) => m.value === uiMode) || list.find((m) => m.value === mode)
  return row?.label || 'Agent'
}

export function parseSceneFromModelPayload(item: unknown): ChatSceneId | undefined {
  const o = item as Record<string, unknown> | null | undefined
  const raw = o?.scene ?? o?.chat_scene
  if (typeof raw !== 'string') return undefined
  const v = normalizeScenarioKeyForUi(raw)
  return v ? (v as ChatSceneId) : undefined
}

export function getSessionModeFromMeta(sessionKey: string): SessionMode {
  const raw = (safeReadSessionMetaMap()[sessionKey] as { mode?: string } | undefined)?.mode
  if (raw === 'normal') return 'pro'
  if (raw === 'fast') return 'flash'
  if (raw === 'think') return 'thinking'
  if (raw === 'deep') return 'ultra'
  if (raw === 'agent') return 'agent'
  if (raw === 'agent_plan') return 'plan'
  if (raw === 'question') return 'ask'
  if (raw && VALID_SESSION_MODES.includes(raw as SessionMode)) {
    return normalizeSessionModeForUi(raw as SessionMode)
  }
  const sk = String(sessionKey || '').trim()
  if (sk) {
    try {
      const sm = String(wsClient.getSessionContext(sk)?.session_mode || '')
        .trim()
        .toLowerCase()
      if (VALID_SESSION_MODES.includes(sm as SessionMode)) {
        return normalizeSessionModeForUi(sm as SessionMode)
      }
    } catch {
      /* ignore */
    }
  }
  return 'agent'
}

export function setSessionModeInMeta(sessionKey: string, mode: SessionMode) {
  if (!sessionKey) return
  const map = safeReadSessionMetaMap()
  if (mode && mode !== 'agent') {
    map[sessionKey] = { ...((map[sessionKey] as object) || {}), mode }
  } else {
    const cur = (map[sessionKey] as Record<string, unknown>) || {}
    const next = { ...cur }
    delete next.mode
    if (Object.keys(next).length) map[sessionKey] = next
    else delete map[sessionKey]
  }
  safeWriteSessionMetaMap(map)
}

/**
 * Inverse of {@link sessionModeFromActivatedScenarios}: derive the active
 * scenario list from a session mode. `plan`→['plan'], `agent`→['agent'],
 * everything else (including `ask`/legacy speed modes)→[].
 *
 * This is the single source of truth on the frontend after the backend
 * dropped the ``activated_scenarios_json`` column in schema v75 — the
 * scenario list is now derived from ``session_mode``.
 */
export function activatedScenariosFromSessionMode(mode: SessionMode | string | null | undefined): string[] {
  const m = String(mode || '')
    .trim()
    .toLowerCase()
  if (m === 'plan') return ['plan']
  if (m === 'agent') return ['agent']
  return []
}

export function resolvedActivatedScenariosForOpenSession(
  row:
    | {
        activatedScenarios?: string[]
        sessionMode?: string | null
        context?: Record<string, unknown>
      }
    | undefined,
  sessionKey: string,
): string[] {
  const norm = (arr: string[]) =>
    arr
      .map((x) => normalizeScenarioKeyForUi(String(x || '')))
      .filter((x): x is string => !!x)

  // 1) Prefer session_mode derived from the API row (authoritative after v75).
  const fromRowMode = activatedScenariosFromSessionMode(row?.sessionMode)
  if (fromRowMode.length) return norm(fromRowMode)

  // 2) Fall back to the residual activatedScenarios column (backend still
  //    emits it, derived from session_mode — kept for back-compat).
  const fromCol = Array.isArray(row?.activatedScenarios) ? norm(row.activatedScenarios) : []
  if (fromCol.length) return fromCol

  // 3) Fall back to context.session_mode on the row.
  const ctxRowMode = activatedScenariosFromSessionMode(
    row?.context?.session_mode as string | null | undefined,
  )
  if (ctxRowMode.length) return norm(ctxRowMode)

  // 4) Fall back to context.activated_scenarios on the row (legacy residual JSON).
  const ctxRow = row?.context
  if (Array.isArray(ctxRow?.activated_scenarios)) {
    const fromRowCtx = norm(ctxRow.activated_scenarios as string[])
    if (fromRowCtx.length) return fromRowCtx
  }

  // 5) Fall back to the live ws-client context (session_mode first, then
  //    legacy activated_scenarios).
  const sk = String(sessionKey || '').trim()
  if (sk) {
    try {
      const ctx = wsClient.getSessionContext(sk) as {
        session_mode?: string
        activated_scenarios?: string[]
      }
      const fromWsMode = activatedScenariosFromSessionMode(ctx?.session_mode)
      if (fromWsMode.length) return norm(fromWsMode)
      if (Array.isArray(ctx?.activated_scenarios)) {
        const fromWs = norm(ctx.activated_scenarios)
        if (fromWs.length) return fromWs
      }
    } catch {
      /* ignore */
    }
  }
  return []
}

export function sessionModeFromActivatedScenarios(scenarios: string[]): SessionMode | null {
  const norm = scenarios
    .map((s) => normalizeScenarioKeyForUi(String(s || '')))
    .filter((x): x is string => !!x)
  if (norm.includes('plan')) return 'plan'
  if (norm.includes('agent')) return 'agent'
  return null
}

export function resolveSessionModeForSession(
  sessionKey: string,
  row?: {
    activatedScenarios?: string[]
    sessionMode?: string | null
    context?: Record<string, unknown>
  },
): SessionMode {
  const sk = String(sessionKey || '').trim()
  if (sk) {
    try {
      const ctx = wsClient.getSessionContext(sk) as { session_mode?: string } | undefined
      const sm = String(ctx?.session_mode || '')
        .trim()
        .toLowerCase()
      if (sm && VALID_SESSION_MODES.includes(sm as SessionMode)) {
        const ui = normalizeSessionModeForUi(sm as SessionMode)
        if (ui === 'ask' || ui === 'agent' || ui === 'plan') return ui
      }
    } catch {
      /* ignore */
    }
  }
  const fromRowMode = String(row?.sessionMode || '')
    .trim()
    .toLowerCase()
  if (fromRowMode && VALID_SESSION_MODES.includes(fromRowMode as SessionMode)) {
    const ui = normalizeSessionModeForUi(fromRowMode as SessionMode)
    if (ui === 'ask' || ui === 'agent' || ui === 'plan') return ui
  }
  const fromRowCtx = String((row?.context?.session_mode as string) || '')
    .trim()
    .toLowerCase()
  if (fromRowCtx && VALID_SESSION_MODES.includes(fromRowCtx as SessionMode)) {
    const ui = normalizeSessionModeForUi(fromRowCtx as SessionMode)
    if (ui === 'ask' || ui === 'agent' || ui === 'plan') return ui
  }
  const scenarios = resolvedActivatedScenariosForOpenSession(row, sessionKey)
  const derived = sessionModeFromActivatedScenarios(scenarios)
  if (derived) return derived
  return normalizeSessionModeForUi(getSessionModeFromMeta(sessionKey))
}

export function activeScenariosFromScenarioBlob(
  blob: Record<string, unknown> | null,
  inputFallback: object | undefined,
): string[] {
  const inp = inputFallback && typeof inputFallback === 'object' && !Array.isArray(inputFallback)
    ? (inputFallback as Record<string, unknown>)
    : {}
  const base = blob && typeof blob === 'object' ? blob : {}
  const rawAll = base.all_active_scenarios
  const list: string[] = []
  if (Array.isArray(rawAll)) {
    for (const x of rawAll) {
      const s = String(x || '').trim()
      if (s) list.push(s)
    }
  }
  if (list.length) return list
  const act = String(base.action || inp.action || '').toLowerCase()
  if (act === 'deactivate') return []
  const sk =
    typeof base.scenario_key === 'string'
      ? base.scenario_key
      : typeof inp.scenario_key === 'string'
        ? inp.scenario_key
        : ''
  return sk ? [String(sk)] : []
}

/** 流式 scenario 工具结果 → 同步底部模式与会话 activated_scenarios */
export function consumeLatestScenarioToolForSession(
  tools: unknown[],
  opts?: {
    sessionKey?: string
    onSessionModeChange?: (mode: SessionMode) => void
    patchSessionScenarios?: (sessionKey: string, scenarios: string[]) => void
  },
) {
  if (!Array.isArray(tools) || tools.length === 0) return
  for (let i = tools.length - 1; i >= 0; i--) {
    const row = tools[i] as Record<string, unknown>
    const nm = String(row?.name ?? row?.tool_name ?? row?.toolName ?? '').trim().toLowerCase()
    if (nm !== 'scenario') continue
    const blob = parseScenarioToolOutputBlob(row.output)
    if (blob && String(blob.status || '').toLowerCase() === 'noop') continue
    const next = pickDisplayChatSceneFromScenarioResult(blob, row.input as object | undefined)
    if (!next) continue
    const activeList = activeScenariosFromScenarioBlob(blob, row.input as object | undefined)
    const sk = String(opts?.sessionKey || '').trim()
    if (sk && opts?.patchSessionScenarios) {
      opts.patchSessionScenarios(sk, activeList)
    }
    const mode = chatSceneToSessionMode(next)
    if (mode && opts?.onSessionModeChange) {
      opts.onSessionModeChange(mode)
    }
    return
  }
}

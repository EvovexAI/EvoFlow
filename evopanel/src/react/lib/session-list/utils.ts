import type { Dispatch, SetStateAction } from 'react'
import { CHAT_MAIN_SESSION_KEY } from '../../../lib/chat-normalize.js'
import { isDeletedChatSessionKey } from '../../../lib/ws-client.js'
import { skTail, ssLog } from '../../../lib/session-list-debug.js'
import type { ChatSessionRow } from '../../chat-types.js'
import { isBackendRunActive } from '../session-execution/queries.js'
import { isTurnBusy, getSessionRuntime } from '../session-runtime-store.js'
import { isTerminalRunStatus } from '../session-reattach.js'
import { isSessionRecoveryCooldownActive } from '../stream-reattach-cooldown.js'
import { STORAGE_SESSION_NAMES_KEY } from './constants.js'
import { getSessionNames, isPlaceholderSessionTitle, pickSessionRowTitle } from './display.js'
import { resolveMergedSessionPin } from './session-pin-pending.js'

export function isDefaultMainSessionKey(sessionKey: string | null | undefined): boolean {
  return String(sessionKey || '').trim() === CHAT_MAIN_SESSION_KEY
}

export function stripDefaultMainSessionRows(rows: ChatSessionRow[]): ChatSessionRow[] {
  return rows.filter((s) => !isDefaultMainSessionKey(s.sessionKey))
}

export function sessionCreatedMs(n: unknown): number {
  const v = typeof n === 'number' && !Number.isNaN(n) ? n : 0
  if (v <= 0) return 0
  if (v < 1e11) return v * 1000
  return v
}

export function dedupeSessionRows(rows: ChatSessionRow[]): ChatSessionRow[] {
  const seen = new Set<string>()
  const out: ChatSessionRow[] = []
  for (const s of rows) {
    const sk = String(s.sessionKey || '').trim()
    if (!sk || seen.has(sk)) continue
    seen.add(sk)
    out.push(s)
  }
  return out
}

/** 比较函数：置顶区 → pinOrder → 创建时间降序 → sessionKey */
export function compareSessionRows(a: ChatSessionRow, b: ChatSessionRow): number {
  const aPin = a.isPinned ? 1 : 0
  const bPin = b.isPinned ? 1 : 0
  if (aPin !== bPin) return bPin - aPin
  if (aPin && bPin) {
    const po = Number(a.pinOrder ?? 0) - Number(b.pinOrder ?? 0)
    if (po !== 0) return po
  }
  const dc = sessionCreatedMs(b.createdAt) - sessionCreatedMs(a.createdAt)
  if (dc !== 0) return dc
  const ka = String(a.sessionKey || '')
  const kb = String(b.sessionKey || '')
  return ka < kb ? -1 : ka > kb ? 1 : 0
}

/** 侧栏会话列表排序：置顶区 → 创建时间降序 */
export function sortSessionsForSidebar(rows: ChatSessionRow[]): ChatSessionRow[] {
  const sorted = dedupeSessionRows(stripDefaultMainSessionRows(rows))
  sorted.sort(compareSessionRows)
  return sorted
}

/** shell-aside 用：对已过滤的行排序（不去 default main） */
export function sortSessionRows<T extends { sessionKey?: string; isPinned?: boolean; pinOrder?: number; createdAt?: number }>(
  rows: T[],
): T[] {
  return [...dedupeSessionRows(rows as ChatSessionRow[])].sort(
    (a, b) => compareSessionRows(a as ChatSessionRow, b as ChatSessionRow),
  ) as T[]
}

export function sessionRowFromApi(
  row: ChatSessionRow & { key?: string },
  opts?: { bumpActivity?: boolean },
): ChatSessionRow {
  const sessionKey = String(row.sessionKey || row.key || '').trim()
  const now = Date.now()
  const bump = opts?.bumpActivity === true
  const rawCreatedAt = Number(row.createdAt) || 0
  const rawUpdatedAt = Number(row.updatedAt) || 0
  // Fallback chain: updatedAt -> createdAt -> now; createdAt -> updatedAt -> now
  // 避免后端返回 0 时所有会话都拿到同一个 Date.now()
  const createdAt = rawCreatedAt || rawUpdatedAt || now
  const updatedAt = bump ? now : (rawUpdatedAt || createdAt)
  return {
    sessionKey,
    threadId: row.threadId ?? null,
    title: String(row.title || '').trim() || '新对话',
    messageCount: Number(row.messageCount) || 0,
    updatedAt,
    lastActivity: bump ? now : Number(row.lastActivity) || updatedAt,
    createdAt,
    isPinned: !!row.isPinned,
    pinOrder: Number(row.pinOrder ?? 0),
    runStatus: row.runStatus,
    currentRunId: row.currentRunId,
    currentTurnStartedAt: row.currentTurnStartedAt,
    currentTurnEndedAt: row.currentTurnEndedAt,
    modelName:
      row.modelName ??
      (row.context && typeof row.context === 'object'
        ? String((row.context as { model_name?: string }).model_name || '').trim() || null
        : null),
    sessionMode:
      row.sessionMode ??
      (row.context && typeof row.context === 'object'
        ? String((row.context as { session_mode?: string }).session_mode || '').trim() || null
        : null),
    memoryEnabled:
      row.memoryEnabled ??
      (row.context && typeof row.context === 'object'
        ? (row.context as { memory_enabled?: boolean }).memory_enabled
        : undefined),
    agentId: row.agentId ?? null,
    localWorkspaceRoot:
      row.localWorkspaceRoot ??
      (row.context && typeof row.context === 'object'
        ? String((row.context as { local_workspace_root?: string }).local_workspace_root || '').trim() || null
        : null),
    useVirtualPaths:
      row.useVirtualPaths ??
      (row.context && typeof row.context === 'object'
        ? !!(row.context as { use_virtual_paths?: boolean }).use_virtual_paths
        : undefined),
    context: row.context,
  }
}

/** 刷新列表时若当前草稿会话尚未出现在 API 结果中，补一条占位行 */
export function ensureSessionRowPresent(rows: ChatSessionRow[], sessionKey: string): ChatSessionRow[] {
  const cur = String(sessionKey || '').trim()
  const deduped = dedupeSessionRows(rows)
  if (!cur || deduped.some((s) => String(s.sessionKey || '') === cur)) return deduped
  const now = Date.now()
  return [
    ...deduped,
    {
      sessionKey: cur,
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      lastActivity: now,
      messageCount: 0,
      isPinned: false,
    },
  ]
}

/** 新建会话成功后立刻写入侧栏列表 */
export function prependNewSessionToList(
  setter: Dispatch<SetStateAction<ChatSessionRow[]>>,
  row: ChatSessionRow & { key?: string },
) {
  const next = sessionRowFromApi(row, { bumpActivity: true })
  if (!next.sessionKey) return
  setter((prev) => {
    const rest = prev.filter((s) => String(s.sessionKey || '') !== next.sessionKey)
    return [next, ...rest]
  })
}

export function patchSessionTitleInRows(
  rows: ChatSessionRow[],
  sessionKey: string,
  title: string,
): ChatSessionRow[] {
  const sk = String(sessionKey || '').trim()
  const t = String(title || '').trim()
  if (!sk || !t) return rows
  let changed = false
  const next = rows.map((s) => {
    if (String(s.sessionKey || '').trim() !== sk) return s
    if (String(s.title || '').trim() === t) return s
    changed = true
    return { ...s, title: t }
  })
  return changed ? next : rows
}

export function patchSessionPinInRows(
  rows: ChatSessionRow[],
  sessionKey: string,
  pinned: boolean,
): ChatSessionRow[] {
  const sk = String(sessionKey || '').trim()
  if (!sk) return rows
  let changed = false
  const next = rows.map((s) => {
    if (String(s.sessionKey || '').trim() !== sk) return s
    if (!!s.isPinned === !!pinned) return s
    changed = true
    return { ...s, isPinned: !!pinned }
  })
  return changed ? sortSessionsForSidebar(next) : rows
}

/** API 刷新后与本地列表合并：保留置顶/新建草稿/当前会话标题 */
export function mergeSessionsFromApi(
  prev: ChatSessionRow[],
  apiRows: ChatSessionRow[],
  currentSessionKey: string,
): ChatSessionRow[] {
  const cur = String(currentSessionKey || '').trim()
  let next = dedupeSessionRows(stripDefaultMainSessionRows(apiRows)).filter(
    (s) => !isDeletedChatSessionKey(String(s.sessionKey || '').trim()),
  )

  const prevMap = new Map<string, ChatSessionRow>()
  for (const s of prev) {
    const k = String(s.sessionKey || '').trim()
    if (k && !isDeletedChatSessionKey(k)) prevMap.set(k, s)
  }

  const nextKeys = new Set(next.map((s) => String(s.sessionKey || '').trim()))
  const newSessions = prev.filter((s) => {
    const k = String(s.sessionKey || '').trim()
    return k && !nextKeys.has(k) && !isDeletedChatSessionKey(k)
  })

  if (cur) {
    next = ensureSessionRowPresent(next, cur)
  }

  next = next.map((s) => {
    const sk = String(s.sessionKey || '').trim()
    const prevRow = sk ? prevMap.get(sk) : undefined
    if (!prevRow) return s
    const isCur = sk === cur
    const mergedIsPinned = resolveMergedSessionPin(sk, !!s.isPinned)
    const merged: ChatSessionRow = {
      ...s,
      isPinned: mergedIsPinned,
      pinOrder: mergedIsPinned
        ? Math.max(Number(s.pinOrder ?? 0), Number(prevRow.pinOrder ?? 0))
        : Number(s.pinOrder ?? 0),
      title: pickSessionRowTitle(sk, s.title, prevRow.title),
      ...(isCur
        ? {
            threadId: s.threadId ?? prevRow.threadId ?? null,
          }
        : {}),
    }
    if (isBackendRunActive(prevRow.runStatus) && !isBackendRunActive(s.runStatus)) {
      return {
        ...merged,
        runStatus: prevRow.runStatus,
        currentRunId: prevRow.currentRunId ?? s.currentRunId,
        currentTurnStartedAt: prevRow.currentTurnStartedAt ?? s.currentTurnStartedAt,
        currentTurnEndedAt: prevRow.currentTurnEndedAt ?? s.currentTurnEndedAt,
        updatedAt: Math.max(Number(prevRow.updatedAt) || 0, Number(s.updatedAt) || 0),
        lastActivity: Math.max(Number(prevRow.lastActivity) || 0, Number(s.lastActivity) || 0),
      }
    }
    // 用户停止后 refresh 竞态：本地已终态时，勿被后端尚未落库的 running 覆盖
    if (
      sk &&
      isSessionRecoveryCooldownActive(sk) &&
      isTerminalRunStatus(prevRow.runStatus) &&
      isBackendRunActive(s.runStatus)
    ) {
      return {
        ...merged,
        runStatus: prevRow.runStatus,
        currentRunId: prevRow.currentRunId ?? null,
        currentTurnStartedAt: prevRow.currentTurnStartedAt ?? s.currentTurnStartedAt,
        currentTurnEndedAt: prevRow.currentTurnEndedAt ?? s.currentTurnEndedAt,
      }
    }
    // 正常结束后的 refresh 竞态：本地已标终态且 turn 已 idle，勿被 DB 残留 running 刷回「运行中」
    if (
      sk &&
      isTerminalRunStatus(prevRow.runStatus) &&
      isBackendRunActive(s.runStatus) &&
      !isTurnBusy(getSessionRuntime(sk))
    ) {
      return {
        ...merged,
        runStatus: prevRow.runStatus,
        currentRunId: prevRow.currentRunId ?? null,
        currentTurnStartedAt: prevRow.currentTurnStartedAt ?? s.currentTurnStartedAt,
        currentTurnEndedAt: prevRow.currentTurnEndedAt ?? s.currentTurnEndedAt,
      }
    }
    // 计时器保护：同一回合内状态流转（如准备中→运行中）时，保留本地更早的起始时间
    // 防止 background_worker 启动时重置 current_turn_started_at 导致计时归零
    if (
      prevRow.runStatus &&
      isBackendRunActive(prevRow.runStatus) &&
      prevRow.currentTurnStartedAt &&
      (!s.currentTurnStartedAt || s.currentTurnStartedAt < prevRow.currentTurnStartedAt)
    ) {
      return {
        ...merged,
        currentTurnStartedAt: prevRow.currentTurnStartedAt,
      }
    }
    return merged
  })

  if (newSessions.length > 0) {
    next = [...newSessions, ...next]
  }

  if (cur) {
    next = ensureSessionRowPresent(next, cur)
  }

  return sortSessionsForSidebar(next)
}

/** 将 API 返回的 title 写入 localStorage 缓存 */
export function persistSessionTitlesFromRows(rows: ChatSessionRow[]): void {
  for (const s of rows) {
    const sk = String(s.sessionKey || '').trim()
    const t = String(s.title || '').trim()
    if (sk && t && !isPlaceholderSessionTitle(t)) {
      try {
        const names = getSessionNames()
        if (names[sk] !== t) {
          names[sk] = t
          localStorage.setItem(STORAGE_SESSION_NAMES_KEY, JSON.stringify(names))
        }
      } catch {
        /* ignore */
      }
    }
  }
}

export type SessionReselectAction =
  | { type: 'none'; reason: string }
  | { type: 'clear'; reason: string }
  | { type: 'select'; sessionKey: string; reason: string }

/** 刷新列表后决定是否自动重选会话 */
export function resolveSessionReselectAfterRefresh(opts: {
  mergedSessions: ChatSessionRow[]
  currentSessionKey: string
  selectedBeforeAwait: string
  selectedAfterAwait: string
  pendingNewAtStart: boolean
  /** Re-check at decision time — create may have started mid-refresh. */
  pendingNewNow?: boolean
  skipAutoReselect?: boolean
  refreshId: string
}): SessionReselectAction {
  const {
    mergedSessions,
    currentSessionKey,
    selectedBeforeAwait,
    selectedAfterAwait,
    pendingNewAtStart,
    pendingNewNow,
    skipAutoReselect,
    refreshId,
  } = opts

  const pendingNew = !!(pendingNewAtStart || pendingNewNow)
  const sessionKeys = mergedSessions.map((s) => String(s.sessionKey || '')).filter(Boolean)
  const keys = new Set(sessionKeys)
  const curNow = currentSessionKey
  const curSelectable = curNow && !isDefaultMainSessionKey(curNow) ? curNow : ''
  const selectedAfter = String(selectedAfterAwait || '').trim()

  // 新建对话中：禁止回填「第一条历史会话」。
  // 不要 clear——create 可能已把 sessionRef 写成新 key，clear 会把新会话冲掉。
  if (pendingNew) {
    ssLog('refresh.skip', {
      refreshId,
      reason: 'pending-new-session',
      atStart: !!pendingNewAtStart,
      now: !!pendingNewNow,
      selected: skTail(selectedAfter),
      cur: skTail(curSelectable),
    })
    return { type: 'none', reason: 'pending-new-session' }
  }

  if (selectedAfter && keys.has(selectedAfter)) {
    ssLog('refresh.skip', {
      refreshId,
      reason: 'selected-state-in-list',
      selected: skTail(selectedAfter),
    })
    return { type: 'none', reason: 'selected-state-in-list' }
  }

  if (curSelectable && keys.has(curSelectable)) {
    ssLog('refresh.skip', { refreshId, reason: 'current-in-list', cur: skTail(curSelectable) })
    return { type: 'none', reason: 'current-in-list' }
  }
  if (curSelectable && skipAutoReselect) {
    ssLog('refresh.skip', {
      refreshId,
      reason: 'skip-auto-reselect-with-cur',
      cur: skTail(curSelectable),
    })
    return { type: 'none', reason: 'skip-auto-reselect-with-cur' }
  }
  const curAfterAwait = String(currentSessionKey || '').trim()
  if (curAfterAwait && curAfterAwait !== selectedBeforeAwait) {
    ssLog('refresh.skip', {
      refreshId,
      reason: 'session-changed-during-await',
      before: skTail(selectedBeforeAwait),
      after: skTail(curAfterAwait),
    })
    return { type: 'none', reason: 'session-changed-during-await' }
  }
  if (selectedAfterAwait && !keys.has(selectedAfterAwait) && !skipAutoReselect) {
    ssLog('refresh.skip', {
      refreshId,
      reason: 'selected-not-in-list-yet',
      selected: skTail(selectedAfterAwait),
    })
    return { type: 'none', reason: 'selected-not-in-list-yet' }
  }
  if (curNow && isDefaultMainSessionKey(curNow)) {
    ssLog('refresh.reselect', { refreshId, reason: 'clear-default-main', to: '(empty)' })
    return { type: 'clear', reason: 'clear-default-main' }
  }
  if (skipAutoReselect) {
    ssLog('refresh.skip', { refreshId, reason: 'skip-auto-reselect-flag' })
    return { type: 'none', reason: 'skip-auto-reselect-flag' }
  }

  const pendingSession = sessionStorage.getItem('evopanel_pending_shell_session')
  if (pendingSession && keys.has(pendingSession)) {
    ssLog('refresh.reselect', {
      refreshId,
      reason: 'pending-shell-session',
      to: skTail(pendingSession),
    })
    return { type: 'select', sessionKey: pendingSession, reason: 'pending-shell-session' }
  }

  const firstSelectable = mergedSessions.find(
    (s) => !isDefaultMainSessionKey(s.sessionKey) && String(s.sessionKey || '').trim(),
  )
  if (firstSelectable) {
    const sk = String(firstSelectable.sessionKey || '').trim()
    ssLog('refresh.reselect', { refreshId, reason: 'first-selectable', to: skTail(sk) })
    return { type: 'select', sessionKey: sk, reason: 'first-selectable' }
  }

  ssLog('refresh.reselect', { refreshId, reason: 'no-selectable', to: '(empty)' })
  return { type: 'clear', reason: 'no-selectable' }
}

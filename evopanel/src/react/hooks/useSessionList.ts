import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { isDeletedChatSessionKey } from '../../lib/ws-client.js'
import { isTauri } from '../../lib/panel-login.js'
import { skTail, ssLog } from '../../lib/session-list-debug.js'
import { wsClient } from '../../lib/ws-client.js'
import type { ChatSessionRow } from '../chat-types.js'
import { SESSION_LIST_PAGE_SIZE, GLOBAL_RECENT_PAGINATION_KEY } from '../lib/session-list/constants.js'
import { loadExpandedWorkspaceKeys } from '../lib/session-list/expanded-workspaces-storage.js'
import type { WorkspaceGroupSummary } from '../lib/session-list/types.js'
import {
  mergeSessionsFromApi,
  persistSessionTitlesFromRows,
  resolveSessionReselectAfterRefresh,
  sortSessionsForSidebar,
  stripDefaultMainSessionRows,
} from '../lib/session-list/utils.js'
import {
  isProactiveSessionKey,
  isSpecialWorkspaceGroupKey,
  normalizeWorkspacePathKey,
  resolveSessionWorkspaceGroup,
  WORKSPACE_GROUP_PROACTIVE,
  WORKSPACE_GROUP_UNBOUND,
  WORKSPACE_GROUP_VIRTUAL,
} from '../lib/session-list/workspace-groups.js'

/** 后端搜索 debounce 延迟（ms）—— 输入停止后等待此时间再发起请求 */
const SESSION_SEARCH_DEBOUNCE_MS = 280

/** 会话列表快照 key（localStorage）。按当前登录用户隔离，避免切换账号后展示他人会话。 */
const SESSION_SNAPSHOT_KEY_BASE = 'evopanel_sessions_snapshot_v1'

function sessionSnapshotKey(): string {
  let uid = ''
  try {
    // 以 WebUI 登录 token 稳定摘要作为用户维度；本机免登（无 token）用默认 key
    const token = localStorage.getItem('evoflow_webui_token')
    if (token) {
      let h = 5381
      for (let i = 0; i < token.length; i += 1) {
        h = ((h << 5) + h + token.charCodeAt(i)) >>> 0
      }
      uid = `_u${h.toString(36)}`
    }
  } catch {
    /* ignore */
  }
  return `${SESSION_SNAPSHOT_KEY_BASE}${uid}`
}
/** 快照最大行数 */
const SESSION_SNAPSHOT_MAX_ROWS = 300

/** 精简版快照行 */
type SnapshotRow = {
  sessionKey: string
  title?: string
  updatedAt?: number
  runStatus?: string
  isPinned?: boolean
  pinOrder?: number
  localWorkspaceRoot?: string | null
  useVirtualPaths?: boolean | null
}

/** 从完整行提取快照字段 */
function snapshotRowFromSessionRow(row: ChatSessionRow): SnapshotRow {
  return {
    sessionKey: row.sessionKey,
    title: row.title,
    updatedAt: row.updatedAt,
    runStatus: row.runStatus,
    isPinned: row.isPinned,
    pinOrder: row.pinOrder,
    localWorkspaceRoot: row.localWorkspaceRoot,
    useVirtualPaths: row.useVirtualPaths,
  }
}

/** 从快照行恢复为完整行 */
function sessionRowFromSnapshotRow(snapshot: SnapshotRow, now: number): ChatSessionRow {
  const createdAt = snapshot.updatedAt || now
  return {
    sessionKey: snapshot.sessionKey,
    title: snapshot.title || '新对话',
    updatedAt: snapshot.updatedAt || now,
    createdAt,
    lastActivity: snapshot.updatedAt || now,
    messageCount: 0,
    isPinned: !!snapshot.isPinned,
    pinOrder: Number(snapshot.pinOrder ?? 0),
    runStatus: snapshot.runStatus,
    localWorkspaceRoot: snapshot.localWorkspaceRoot ?? null,
    useVirtualPaths: snapshot.useVirtualPaths,
  }
}

/** 读取会话列表快照 */
function loadSessionSnapshot(): ChatSessionRow[] | null {
  try {
    const raw = localStorage.getItem(sessionSnapshotKey())
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data || data.version !== 1 || !Array.isArray(data.rows)) return null
    const now = Date.now()
    const rows = data.rows
      .map((s: SnapshotRow) => sessionRowFromSnapshotRow(s, now))
      .filter((s: ChatSessionRow) => {
        const sk = String(s.sessionKey || '').trim()
        if (!sk) return false
        if (isDeletedChatSessionKey(sk)) return false
        return true
      })
      .slice(0, SESSION_SNAPSHOT_MAX_ROWS)
    return rows.length > 0 ? rows : null
  } catch {
    return null
  }
}

/** 写入会话列表快照 */
function saveSessionSnapshot(rows: ChatSessionRow[]): void {
  try {
    const snapshot = {
      version: 1 as const,
      savedAt: Date.now(),
      rows: rows.map(snapshotRowFromSessionRow).slice(0, SESSION_SNAPSHOT_MAX_ROWS),
    }
    localStorage.setItem(sessionSnapshotKey(), JSON.stringify(snapshot))
  } catch {
    /* ignore */
  }
}

export type RefreshSessionsOptions = {
  skipAutoReselect?: boolean
  /** 仅同步 workspace-groups 汇总，不重载各目录会话 */
  summariesOnly?: boolean
  /** 批量重载时不展示各目录「加载中…」 */
  silentReload?: boolean
}

function resolveWorkspaceKeyForSession(
  sessionKey: string,
  sessions: ChatSessionRow[],
): string {
  const selected = String(sessionKey || '').trim()
  if (!selected) return WORKSPACE_GROUP_UNBOUND
  const row = sessions.find((s) => String(s.sessionKey || '').trim() === selected)
  if (row) return resolveSessionWorkspaceGroup(row).workspaceKey
  if (isProactiveSessionKey(selected)) return WORKSPACE_GROUP_PROACTIVE
  const ctx = wsClient.getSessionContext(selected) || {}
  const src = String(ctx.source || '').trim().toLowerCase()
  if (src === 'proactive' || src.startsWith('proactive_')) return WORKSPACE_GROUP_PROACTIVE
  if (ctx.use_virtual_paths === true) return WORKSPACE_GROUP_VIRTUAL
  const root = String(ctx.local_workspace_root || '').trim()
  if (root) return root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return WORKSPACE_GROUP_UNBOUND
}

export type UseSessionListOptions = {
  /** 当前选中 sessionKey（React state） */
  selectedSessionKey: string
  /** 与 selectedSessionKey 同步的 ref（sessionRef） */
  sessionRef: MutableRefObject<string>
  /** 新建会话进行中标记 */
  pendingNewSessionRef: MutableRefObject<boolean>
  setSelectedSessionKey: Dispatch<SetStateAction<string>>
  hydrateContextUsageFromSessionsRef: MutableRefObject<(rows: ChatSessionRow[]) => void>
  /** 侧栏标题 localStorage 更新时递增，触发 sortedSessions 重算 */
  sessionNamesTick?: number
}

type WorkspacePaginationState = {
  offset: number
  hasMore: boolean
  loading: boolean
}

function defaultWorkspacePagination(): WorkspacePaginationState {
  return { offset: 0, hasMore: true, loading: false }
}

/** 列表是否有可见变化（避免 soft 刷新无意义 setState → 底部闪） */
function sessionListFingerprint(rows: ChatSessionRow[]): string {
  return rows
    .map((s) => {
      const sk = String(s.sessionKey || '').trim()
      return [
        sk,
        String(s.title || ''),
        String(s.runStatus || ''),
        Number(s.updatedAt || 0),
        s.isPinned ? 1 : 0,
        Number(s.pinOrder ?? 0),
      ].join('\x1f')
    })
    .join('\x1e')
}

function sessionBelongsToWorkspace(session: ChatSessionRow, workspaceKey: string): boolean {
  const { workspaceKey: wk } = resolveSessionWorkspaceGroup(session)
  return wk === workspaceKey
}

function removeSessionsForWorkspace(
  sessions: ChatSessionRow[],
  workspaceKey: string,
): ChatSessionRow[] {
  return sessions.filter((s) => !sessionBelongsToWorkspace(s, workspaceKey))
}

export function useSessionList(opts: UseSessionListOptions) {
  const {
    selectedSessionKey,
    sessionRef,
    pendingNewSessionRef,
    setSelectedSessionKey,
    hydrateContextUsageFromSessionsRef,
    sessionNamesTick = 0,
  } = opts

  const [sessions, setSessions] = useState<ChatSessionRow[]>(() => {
    // 冷启动 UI-first：同步水合上次会话列表快照，侧栏首帧即有内容；
    // 后端就绪后 onBackendReadyChange 触发 refreshSessions 走 merge 对账覆盖。
    if (isTauri) {
      const snap = loadSessionSnapshot()
      if (snap && snap.length) return snap
    }
    return []
  })
  const sessionsRef = useRef(sessions)
  useLayoutEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])
  // 快照已水合 → 列表"有内容"，不走「加载中」骨架，保持后台静默刷新语义
  const hydratedFromSnapshotRef = useRef(sessions.length > 0)
  const [listLoading, setListLoading] = useState(sessions.length === 0)

  const [workspaceSummaries, setWorkspaceSummaries] = useState<WorkspaceGroupSummary[]>([])
  const [sessionFilter, setSessionFilter] = useState('')
  const [moreMenuKey, setMoreMenuKey] = useState<string | null>(null)
  const [newChatButtonActive, setNewChatButtonActive] = useState(false)
  const [workspacePaginationTick, setWorkspacePaginationTick] = useState(0)

  // —— 后端搜索状态 —— 有搜索词时走后端（覆盖全部会话，不受分页限制）
  const [searchResults, setSearchResults] = useState<ChatSessionRow[]>([])
  const searchAbortRef = useRef<AbortController | null>(null)
  const searchTimerRef = useRef<number | null>(null)

  const workspacePaginationRef = useRef<Record<string, WorkspacePaginationState>>({})
  const loadedWorkspaceKeysRef = useRef<Set<string>>(new Set())
  /** 首次进入已完成全目录首页预拉（避免每次刷新都全量拉） */
  const initialPreloadDoneRef = useRef(false)
  /** 静默 soft 刷新进行中的 workspace，避免 8s 轮询叠请求 */
  const softReloadInflightRef = useRef<Set<string>>(new Set())
  const refreshSessionsTimerRef = useRef<number | null>(null)
  /** Singleflight: coalesce overlapping refreshSessions (post-turn title polls flooded stdio). */
  const refreshInflightRef = useRef<Promise<void> | null>(null)
  const refreshDirtyRef = useRef(false)
  const refreshPendingOptRef = useRef<RefreshSessionsOptions | undefined>(undefined)
  const refreshSessionsRef = useRef<
    ((opt?: RefreshSessionsOptions) => Promise<void>) | null
  >(null)
  const scheduleRefreshSessionsRef = useRef<
    ((delayMs?: number, opt?: RefreshSessionsOptions) => void) | null
  >(null)

  const selectedSessionKeyRef = useRef(selectedSessionKey)

  useEffect(() => {
    selectedSessionKeyRef.current = selectedSessionKey
  }, [selectedSessionKey])

  const bumpWorkspacePagination = useCallback(() => {
    setWorkspacePaginationTick((n) => n + 1)
  }, [])

  /** 从分页列表与搜索缓存中同步移除会话（删除侧栏条目时两者都要更新） */
  const removeSessionFromList = useCallback((sessionKey: string) => {
    const sk = String(sessionKey || '').trim()
    if (!sk) return
    setSessions((prev) => prev.filter((s) => String(s.sessionKey || '').trim() !== sk))
    setSearchResults((prev) => prev.filter((s) => String(s.sessionKey || '').trim() !== sk))
  }, [])

  const setWorkspacePagination = useCallback(
    (workspaceKey: string, patch: Partial<WorkspacePaginationState>) => {
      const key = String(workspaceKey || '').trim()
      if (!key) return
      const prev = workspacePaginationRef.current[key] || defaultWorkspacePagination()
      workspacePaginationRef.current[key] = { ...prev, ...patch }
      bumpWorkspacePagination()
    },
    [bumpWorkspacePagination],
  )

  const patchWorkspacePaginationBatch = useCallback(
    (patches: Record<string, Partial<WorkspacePaginationState>>) => {
      let changed = false
      for (const [rawKey, patch] of Object.entries(patches)) {
        const key = String(rawKey || '').trim()
        if (!key) continue
        const prev = workspacePaginationRef.current[key] || defaultWorkspacePagination()
        workspacePaginationRef.current[key] = { ...prev, ...patch }
        changed = true
      }
      if (changed) bumpWorkspacePagination()
    },
    [bumpWorkspacePagination],
  )

  const loadWorkspaceSessionsBatch = useCallback(
    async (
      workspaceKeys: string[],
      opt?: { reset?: boolean; silent?: boolean },
    ) => {
      const keys = [...new Set(workspaceKeys.map((k) => String(k || '').trim()).filter(Boolean))]
      if (!keys.length) return

      // 静默 + reset：当作 soft 合并，避免截断已加载页 → 底部 loadMore 转圈闪烁
      const soft = !!(opt?.silent && opt?.reset)

      if (!opt?.silent) {
        patchWorkspacePaginationBatch(
          Object.fromEntries(keys.map((k) => [k, { loading: true }])),
        )
      }

      try {
        const { api } = await import('../../lib/tauri-api.js')
        // Cap concurrency — unbounded Promise.all of chatSessionsList floods the
        // desktop app-server stdio pipe and delays /messages history paint.
        const CONCURRENCY = 3
        const pages: Array<{
          key: string
          pageRows: ChatSessionRow[]
          nextOffset: number
          hasMore: boolean
          ok: boolean
        }> = new Array(keys.length)
        let nextIndex = 0
        const worker = async () => {
          while (nextIndex < keys.length) {
            const idx = nextIndex
            nextIndex += 1
            const key = keys[idx]
            try {
              const pag = workspacePaginationRef.current[key] || defaultWorkspacePagination()
              const offset = soft || opt?.reset ? 0 : pag.offset
              const data = await api.chatSessionsList(SESSION_LIST_PAGE_SIZE, offset, key)
              const apiRows = (data?.sessions || []) as ChatSessionRow[]
              const pageRows = stripDefaultMainSessionRows(apiRows)
              pages[idx] = {
                key,
                pageRows,
                nextOffset: offset + apiRows.length,
                hasMore: apiRows.length >= SESSION_LIST_PAGE_SIZE,
                ok: true,
              }
            } catch (e) {
              if ((e as Error)?.name !== 'AbortError') {
                console.warn('[SessionList] loadWorkspaceBatch item', key, e)
              }
              pages[idx] = {
                key,
                pageRows: [],
                nextOffset: 0,
                hasMore: true,
                ok: false,
              }
            }
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, keys.length) }, () => worker()),
        )
        const okPages = pages.filter((p) => p.ok)
        const failedKeys = pages.filter((p) => !p.ok).map((p) => p.key)
        if (failedKeys.length) {
          patchWorkspacePaginationBatch(
            Object.fromEntries(failedKeys.map((k) => [k, { loading: false }])),
          )
        }
        if (!okPages.length) return

        const curAtMerge = String(sessionRef.current || '').trim()
        let mergedForStorage: ChatSessionRow[] = []
        let sessionsChanged = true
        setSessions((prev) => {
          let base = prev
          if (opt?.reset && !soft) {
            for (const key of keys) {
              base = removeSessionsForWorkspace(base, key)
            }
          }
          let next = base
          for (const { pageRows } of okPages) {
            next = mergeSessionsFromApi(next, pageRows, curAtMerge)
          }
          if (soft && sessionListFingerprint(prev) === sessionListFingerprint(next)) {
            sessionsChanged = false
            mergedForStorage = prev
            return prev
          }
          mergedForStorage = next
          sessionsRef.current = next
          return next
        })

        if (soft) {
          const pagPatches: Record<string, Partial<WorkspacePaginationState>> = {}
          for (const { key, nextOffset, hasMore } of okPages) {
            const livePag = workspacePaginationRef.current[key] || defaultWorkspacePagination()
            const neverPaged =
              !loadedWorkspaceKeysRef.current.has(key) || Number(livePag.offset || 0) <= 0
            if (neverPaged) {
              pagPatches[key] = { offset: nextOffset, hasMore, loading: false }
            }
          }
          if (Object.keys(pagPatches).length) {
            patchWorkspacePaginationBatch(pagPatches)
          }
        } else {
          patchWorkspacePaginationBatch(
            Object.fromEntries(
              okPages.map(({ key, nextOffset, hasMore }) => [
                key,
                { offset: nextOffset, hasMore, loading: false },
              ]),
            ),
          )
        }
        for (const { key } of okPages) {
          loadedWorkspaceKeysRef.current.add(key)
        }

        if (sessionsChanged || !soft) {
          const flatPageRows = okPages.flatMap((p) => p.pageRows)
          if (mergedForStorage.length) {
            persistSessionTitlesFromRows(mergedForStorage)
            hydrateContextUsageFromSessionsRef.current(mergedForStorage)
            saveSessionSnapshot(mergedForStorage)
          } else if (flatPageRows.length) {
            persistSessionTitlesFromRows(flatPageRows)
            hydrateContextUsageFromSessionsRef.current(flatPageRows)
            saveSessionSnapshot(flatPageRows)
          }
        }
      } catch (e) {
        patchWorkspacePaginationBatch(
          Object.fromEntries(keys.map((k) => [k, { loading: false }])),
        )
        if ((e as Error)?.name !== 'AbortError') {
          console.warn('[SessionList] loadWorkspaceBatch', e)
        }
      }
    },
    [hydrateContextUsageFromSessionsRef, patchWorkspacePaginationBatch, sessionRef],
  )

  const loadWorkspaceSessions = useCallback(
    async (
      workspaceKey: string,
      opt?: {
        reset?: boolean
        /** 不展示「加载中…」，供后台轮询 */
        silent?: boolean
        /**
         * 静默刷新：合并首页更新，不清空已加载的后续页。
         * 避免 force reset 把第 2 页起的会话抹掉再靠 IntersectionObserver 补回 → 列表闪烁。
         */
        soft?: boolean
      },
    ) => {
      const key = String(workspaceKey || '').trim()
      if (!key) return
      const pag = workspacePaginationRef.current[key] || defaultWorkspacePagination()
      if (pag.loading) return
      if (!opt?.reset && loadedWorkspaceKeysRef.current.has(key) && pag.offset > 0 && !pag.hasMore) {
        return
      }

      const soft = !!(opt?.soft || (opt?.silent && opt?.reset))
      const offset = soft || opt?.reset ? 0 : pag.offset
      if (soft) {
        if (softReloadInflightRef.current.has(key)) return
        softReloadInflightRef.current.add(key)
      }
      if (!opt?.silent) {
        setWorkspacePagination(key, { loading: true })
      }
      try {
        const { api } = await import('../../lib/tauri-api.js')
        const data = await api.chatSessionsList(SESSION_LIST_PAGE_SIZE, offset, key)
        const apiRows = (data?.sessions || []) as ChatSessionRow[]
        const pageRows = stripDefaultMainSessionRows(apiRows)
        const nextOffset = offset + apiRows.length
        const hasMore = apiRows.length >= SESSION_LIST_PAGE_SIZE

        const curAtMerge = String(sessionRef.current || '').trim()
        let mergedForStorage: ChatSessionRow[] = []
        let sessionsChanged = false
        setSessions((prev) => {
          // soft：在现有列表上合并；硬 reset：先清本 workspace 再合并首页
          const base = opt?.reset && !soft ? removeSessionsForWorkspace(prev, key) : prev
          const next = mergeSessionsFromApi(base, pageRows, curAtMerge)
          if (soft && sessionListFingerprint(prev) === sessionListFingerprint(next)) {
            mergedForStorage = prev
            return prev
          }
          sessionsChanged = true
          mergedForStorage = next
          sessionsRef.current = next
          return next
        })

        if (soft) {
          // soft 绝不能把已翻页的 offset 打回首页（会触发底部 loadMore 转圈）。
          // 若尚未正式分页过，则写入首页 offset/hasMore，否则完全不动分页。
          const livePag = workspacePaginationRef.current[key] || defaultWorkspacePagination()
          const neverPaged =
            !loadedWorkspaceKeysRef.current.has(key) || Number(livePag.offset || 0) <= 0
          if (neverPaged) {
            setWorkspacePagination(key, { offset: nextOffset, hasMore, loading: false })
          }
        } else {
          setWorkspacePagination(key, { offset: nextOffset, hasMore, loading: false })
        }
        loadedWorkspaceKeysRef.current.add(key)

        if (sessionsChanged || !soft) {
          if (mergedForStorage.length) {
            persistSessionTitlesFromRows(mergedForStorage)
            hydrateContextUsageFromSessionsRef.current(mergedForStorage)
          } else if (pageRows.length) {
            persistSessionTitlesFromRows(pageRows)
            hydrateContextUsageFromSessionsRef.current(pageRows)
          }
        }
      } catch (e) {
        if (!opt?.silent) setWorkspacePagination(key, { loading: false })
        if ((e as Error)?.name !== 'AbortError') {
          console.warn('[SessionList] loadWorkspace', key, e)
        }
      } finally {
        if (soft) softReloadInflightRef.current.delete(key)
      }
    },
    [hydrateContextUsageFromSessionsRef, sessionRef, setWorkspacePagination],
  )

  const loadMoreWorkspaceSessions = useCallback(
    async (workspaceKey: string) => {
      const key = String(workspaceKey || '').trim()
      if (!key) return
      const pag = workspacePaginationRef.current[key] || defaultWorkspacePagination()
      if (pag.loading || !pag.hasMore) return
      await loadWorkspaceSessions(key, { reset: false })
    },
    [loadWorkspaceSessions],
  )

  /** 全局最近对话（不按 workspace_key 过滤） */
  const loadGlobalRecentSessions = useCallback(
    async (opt?: { reset?: boolean; silent?: boolean }) => {
      const key = GLOBAL_RECENT_PAGINATION_KEY
      const pag = workspacePaginationRef.current[key] || defaultWorkspacePagination()
      if (pag.loading) return
      if (!opt?.reset && loadedWorkspaceKeysRef.current.has(key) && pag.offset > 0 && !pag.hasMore) {
        return
      }

      const offset = opt?.reset ? 0 : pag.offset
      setWorkspacePagination(key, { loading: true })
      try {
        const { api } = await import('../../lib/tauri-api.js')
        const data = await api.chatSessionsList(SESSION_LIST_PAGE_SIZE, offset, null)
        const apiRows = (data?.sessions || []) as ChatSessionRow[]
        const pageRows = stripDefaultMainSessionRows(apiRows)
        const nextOffset = offset + apiRows.length
        const hasMore = apiRows.length >= SESSION_LIST_PAGE_SIZE

        setWorkspacePagination(key, { offset: nextOffset, hasMore, loading: false })
        loadedWorkspaceKeysRef.current.add(key)

        const curAtMerge = String(sessionRef.current || '').trim()
        let mergedForStorage: ChatSessionRow[] = []
        setSessions((prev) => {
          if (opt?.reset && offset === 0) {
            // Keep pinned / current / already-paged workspaces (esp. 员工对话
            // __proactive__). Global recent alone is only ~20 rows and would
            // otherwise drop employee multi-sessions until a later expand.
            const keep = prev.filter((s) => {
              const sk = String(s.sessionKey || '').trim()
              if (!sk) return false
              if (sk === curAtMerge) return true
              if (s.isPinned) return true
              for (const wk of loadedWorkspaceKeysRef.current) {
                if (!wk || wk === GLOBAL_RECENT_PAGINATION_KEY) continue
                if (sessionBelongsToWorkspace(s, wk)) return true
              }
              return false
            })
            const merged = mergeSessionsFromApi(pageRows, keep, curAtMerge)
            mergedForStorage = merged
            sessionsRef.current = merged
            return merged
          }
          const next = mergeSessionsFromApi(prev, pageRows, curAtMerge)
          mergedForStorage = next
          sessionsRef.current = next
          return next
        })
        if (mergedForStorage.length) {
          persistSessionTitlesFromRows(mergedForStorage)
          hydrateContextUsageFromSessionsRef.current(mergedForStorage)
        } else if (pageRows.length) {
          persistSessionTitlesFromRows(pageRows)
          hydrateContextUsageFromSessionsRef.current(pageRows)
        }
      } catch (e) {
        setWorkspacePagination(key, { loading: false })
        if ((e as Error)?.name !== 'AbortError') {
          console.warn('[SessionList] loadGlobalRecent', e)
        }
      }
    },
    [hydrateContextUsageFromSessionsRef, sessionRef, setWorkspacePagination],
  )

  const loadMoreGlobalRecentSessions = useCallback(async () => {
    const pag =
      workspacePaginationRef.current[GLOBAL_RECENT_PAGINATION_KEY] || defaultWorkspacePagination()
    if (pag.loading || !pag.hasMore) return
    await loadGlobalRecentSessions({ reset: false })
  }, [loadGlobalRecentSessions])

  const resolveWorkspaceKeysToLoad = useCallback((): string[] => {
    // 刷新时预拉取：当前选中会话所在目录 + 已展开过的特殊组（员工对话）
    // 普通工作空间仍由侧栏面板按需 ensureWorkspaceExpanded
    const keys = new Set<string>()
    const selected = String(selectedSessionKeyRef.current || sessionRef.current || '').trim()
    if (selected) {
      keys.add(resolveWorkspaceKeyForSession(selected, sessionsRef.current))
    }
    if (loadedWorkspaceKeysRef.current.has(WORKSPACE_GROUP_PROACTIVE)) {
      keys.add(WORKSPACE_GROUP_PROACTIVE)
    }
    if (loadedWorkspaceKeysRef.current.has(WORKSPACE_GROUP_VIRTUAL)) {
      keys.add(WORKSPACE_GROUP_VIRTUAL)
    }
    return [...keys].filter((k) => k && k !== GLOBAL_RECENT_PAGINATION_KEY)
  }, [sessionRef])

  const refreshSessions = useCallback(
    async (opt?: RefreshSessionsOptions) => {
      if (refreshInflightRef.current) {
        refreshDirtyRef.current = true
        const prev = refreshPendingOptRef.current
        refreshPendingOptRef.current = {
          skipAutoReselect: !!(prev?.skipAutoReselect || opt?.skipAutoReselect),
          // Prefer a full reload if either caller asked for one.
          summariesOnly: !!(prev?.summariesOnly && opt?.summariesOnly),
          silentReload:
            prev?.silentReload === false || opt?.silentReload === false
              ? false
              : (opt?.silentReload ?? prev?.silentReload),
        }
        ssLog('refresh.coalesced', {
          summariesOnly: !!refreshPendingOptRef.current.summariesOnly,
        })
        await refreshInflightRef.current
        return
      }

      const run = async () => {
        let currentOpt = opt
        do {
          refreshDirtyRef.current = false
          refreshPendingOptRef.current = undefined

          // 预热期跳过：后端 liveness 从未通过时（冷启动 UI-first），列表请求必然
          // 失败返回空 → loadGlobalRecentSessions({reset:true}) 空结果只保留置顶/
          // 当前会话，会冲掉快照水合的普通最近会话。后端就绪由 onBackendReadyChange
          // 兜底触发对账刷新。
          if (isTauri && hydratedFromSnapshotRef.current) {
            try {
              const { isGatewayWarming } = await import('../../lib/tauri-api.js')
              if (isGatewayWarming()) {
                ssLog('refresh.skipped_warming', {})
                setListLoading(false)
                break
              }
            } catch {
              /* 拿不到状态就按原逻辑走 */
            }
          }
          const refreshId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          const pendingNewAtStart = pendingNewSessionRef.current
          const selectedBeforeAwait = String(selectedSessionKeyRef.current || '').trim()
          ssLog('refresh.start', {
            refreshId,
            skipAutoReselect: !!currentOpt?.skipAutoReselect,
            summariesOnly: !!currentOpt?.summariesOnly,
            sessionRef: skTail(sessionRef.current),
            selectedKey: skTail(selectedBeforeAwait),
            pendingNew: pendingNewAtStart,
          })
          try {
            const { api } = await import('../../lib/tauri-api.js')
            const groupData = await api.chatSessionsWorkspaceGroups()
            const summaries = (groupData?.groups || []) as WorkspaceGroupSummary[]
            setWorkspaceSummaries(summaries)

            // 首次加载时主动拉取已注册工作空间列表，确保侧栏显示完整的工作空间分组
            // （包括无会话的空目录），避免初始只显示有会话的2个工作空间
            let registeredPaths: string[] = []
            if (!initialPreloadDoneRef.current) {
              try {
                const historyData = await api.listUserWorkspaceHistory()
                registeredPaths = (historyData?.paths || [])
                  .map((p: string) => String(p || '').trim())
                  .filter(Boolean)
              } catch {
                /* ignore */
              }
            }

            if (!currentOpt?.summariesOnly) {
              // 默认主视图：全局最近对话；再补当前会话所在目录
              await loadGlobalRecentSessions({
                reset: true,
                silent: currentOpt?.silentReload ?? true,
              })
              const keysToLoad = resolveWorkspaceKeysToLoad()
              // 首次进入：预拉各工作空间首页。不 await——否则 N 路并行 sessions
              // 会堵死 app-server stdio，拖慢当前对话 /messages。
              if (!initialPreloadDoneRef.current) {
                const preloadKeys = summaries
                  .map((g) => String(g.workspaceKey || '').trim())
                  .filter(
                    (k) =>
                      k &&
                      k !== WORKSPACE_GROUP_PROACTIVE &&
                      k !== GLOBAL_RECENT_PAGINATION_KEY &&
                      Number((summaries.find((s) => s.workspaceKey === k) || {}).sessionCount ?? 0) > 0,
                  )
                const needKeys = [...new Set([...preloadKeys, ...keysToLoad])]
                initialPreloadDoneRef.current = true
                if (needKeys.length) {
                  void loadWorkspaceSessionsBatch(needKeys, {
                    reset: true,
                    silent: currentOpt?.silentReload ?? true,
                  }).catch((e) => {
                    console.warn('[SessionList] deferred workspace preload', e)
                  })
                }
                if (registeredPaths.length > 0) {
                  window.dispatchEvent(
                    new CustomEvent('evopanel:registered-workspace-paths-updated', {
                      detail: { paths: registeredPaths },
                    }),
                  )
                }
              } else if (keysToLoad.length) {
                await loadWorkspaceSessionsBatch(keysToLoad, {
                  reset: true,
                  silent: currentOpt?.silentReload ?? true,
                })
              }
              // 仍展开着的目录：静默补拉（工作空间面板）
              const expanded = [...loadExpandedWorkspaceKeys()].filter(
                (k) => k && !keysToLoad.includes(k) && k !== GLOBAL_RECENT_PAGINATION_KEY,
              )
              if (expanded.length) {
                void loadWorkspaceSessionsBatch(expanded, {
                  reset: true,
                  silent: true,
                }).catch(() => {})
              }
            }

            const mergedForStorage = sessionsRef.current
            const action = resolveSessionReselectAfterRefresh({
              mergedSessions: mergedForStorage,
              currentSessionKey: sessionRef.current,
              selectedBeforeAwait,
              selectedAfterAwait: String(selectedSessionKeyRef.current || '').trim(),
              pendingNewAtStart,
              skipAutoReselect: currentOpt?.skipAutoReselect,
              refreshId,
            })

            if (action.type === 'clear') {
              setSelectedSessionKey('')
              sessionRef.current = ''
              setNewChatButtonActive(true)
            } else if (action.type === 'select') {
              setSelectedSessionKey(action.sessionKey)
              sessionRef.current = action.sessionKey
              setNewChatButtonActive(false)
            }
          } catch (e) {
            if ((e as Error)?.name === 'AbortError') {
              ssLog('refresh.aborted', { refreshId })
            } else {
              ssLog('refresh.error', { refreshId, message: String((e as Error)?.message || e) })
              console.warn('[SessionList] refresh', e)
            }
          } finally {
            setListLoading(false)
          }

          currentOpt = refreshPendingOptRef.current
        } while (refreshDirtyRef.current)
      }

      const pending = run().finally(() => {
        if (refreshInflightRef.current === pending) refreshInflightRef.current = null
      })
      refreshInflightRef.current = pending
      await pending
    },
    [
      loadGlobalRecentSessions,
      loadWorkspaceSessionsBatch,
      pendingNewSessionRef,
      resolveWorkspaceKeysToLoad,
      sessionRef,
      setSelectedSessionKey,
    ],
  )

  const ensureWorkspaceExpanded = useCallback(
    (workspaceKey: string, opt?: { force?: boolean; silent?: boolean }) => {
      const key = String(workspaceKey || '').trim()
      if (!key) return
      if (!opt?.force && loadedWorkspaceKeysRef.current.has(key)) return
      if (opt?.force) {
        if (opt.silent) {
          // 后台轮询：不清 loaded 标记、不亮 loading、不截断已加载页
          void loadWorkspaceSessions(key, { reset: true, silent: true, soft: true })
          return
        }
        loadedWorkspaceKeysRef.current.delete(key)
        void loadWorkspaceSessions(key, { reset: true })
        return
      }
      void loadWorkspaceSessions(key, { reset: false })
    },
    [loadWorkspaceSessions],
  )

  const purgeWorkspaceFromSidebar = useCallback(
    (workspaceKey: string, opt?: { skipSessions?: boolean }) => {
      const key = normalizeWorkspacePathKey(workspaceKey) || String(workspaceKey || '').trim()
      if (!key || isSpecialWorkspaceGroupKey(key)) return
      loadedWorkspaceKeysRef.current.delete(key)
      delete workspacePaginationRef.current[key]
      bumpWorkspacePagination()
      setWorkspaceSummaries((prev) =>
        prev.filter((s) => {
          const sk = String(s.workspaceKey || '').trim()
          if (isSpecialWorkspaceGroupKey(sk)) return true
          const nk = normalizeWorkspacePathKey(sk) || sk
          return nk !== key
        }),
      )
      if (!opt?.skipSessions) {
        setSessions((prev) => removeSessionsForWorkspace(prev, key))
      }
      window.dispatchEvent(
        new CustomEvent('evopanel:shell-workspace-removed', {
          detail: { workspaceKey: key },
        }),
      )
    },
    [bumpWorkspacePagination],
  )

  const scheduleRefreshSessions = useCallback(
    (delayMs = 400, opt?: RefreshSessionsOptions) => {
      ssLog('refresh.scheduled', { delayMs, summariesOnly: !!opt?.summariesOnly })
      if (refreshSessionsTimerRef.current != null) {
        window.clearTimeout(refreshSessionsTimerRef.current)
      }
      refreshSessionsTimerRef.current = window.setTimeout(() => {
        refreshSessionsTimerRef.current = null
        void refreshSessions(opt)
      }, Math.max(0, delayMs)) as unknown as number
    },
    [refreshSessions],
  )

  useEffect(() => {
    refreshSessionsRef.current = refreshSessions
    scheduleRefreshSessionsRef.current = scheduleRefreshSessions
  }, [refreshSessions, scheduleRefreshSessions])

  useEffect(() => {
    const onSessionsMutated = () => {
      void refreshSessionsRef.current?.()
    }
    window.addEventListener('evopanel:shell-sessions-mutated', onSessionsMutated)
    return () => window.removeEventListener('evopanel:shell-sessions-mutated', onSessionsMutated)
  }, [])

  // 后端就绪后触发一次对账刷新（使用快照水合的列表会走 merge 而非覆盖）
  useEffect(() => {
    if (!isTauri) return
    let unsub: (() => void) | null = null
    let disposed = false
    import('../../lib/tauri-api.js').then(({ onBackendReadyChange, isBackendReady }) => {
      if (disposed) return
      // 挂载时后端已就绪：稍后再对账，避免与当前会话 /messages 抢管道
      const kick = () => {
        window.setTimeout(() => {
          void refreshSessionsRef.current?.()
        }, 1500)
      }
      if (isBackendReady() === true) {
        kick()
        return
      }
      unsub = onBackendReadyChange((ready) => {
        if (ready) kick()
      })
    }).catch(() => {})
    return () => {
      disposed = true
      try { unsub?.() } catch { /* ignore */ }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (refreshSessionsTimerRef.current != null) {
        window.clearTimeout(refreshSessionsTimerRef.current)
      }
      if (searchTimerRef.current != null) {
        window.clearTimeout(searchTimerRef.current)
      }
      if (searchAbortRef.current) {
        try { searchAbortRef.current.abort() } catch { /* ignore */ }
      }
    }
  }, [])

  // —— 后端搜索 debounce effect ——
  // 有搜索词时走后端搜索（覆盖全部会话，不受分页限制），停止输入 280ms 后发请求。
  // 搜索词清空时立即清空搜索结果，回到分页列表。
  useEffect(() => {
    const q = sessionFilter.trim()
    if (searchTimerRef.current != null) {
      window.clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    if (!q) {
      if (searchAbortRef.current) {
        try { searchAbortRef.current.abort() } catch { /* ignore */ }
        searchAbortRef.current = null
      }
      queueMicrotask(() => setSearchResults([]))
      return
    }
    searchTimerRef.current = window.setTimeout(() => {
      searchTimerRef.current = null
      const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      if (searchAbortRef.current) {
        try { searchAbortRef.current.abort() } catch { /* ignore */ }
      }
      const controller = new AbortController()
      searchAbortRef.current = controller
      void (async () => {
        try {
          const { api } = await import('../../lib/tauri-api.js')
          const data = await api.chatSessionsSearch(q, 50)
          if (searchAbortRef.current !== controller) return
          const apiRows = (data?.sessions || []) as ChatSessionRow[]
          setSearchResults(stripDefaultMainSessionRows(apiRows))
          ssLog('search.done', { reqId, q, count: apiRows.length })
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') return
          ssLog('search.error', { reqId, q, message: String((e as Error)?.message || e) })
          setSearchResults([])
        } finally {
          if (searchAbortRef.current === controller) {
            searchAbortRef.current = null
          }
        }
      })()
    }, SESSION_SEARCH_DEBOUNCE_MS) as unknown as number
    return () => {
      if (searchTimerRef.current != null) {
        window.clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }
    }
  }, [sessionFilter])

  const sortedSessions = useMemo(
    () => sortSessionsForSidebar(sessions),
    [sessions, sessionNamesTick],
  )

  // 搜索模式下用后端返回的 searchResults（后端已按标题+消息内容匹配过滤）；
  // 无搜索词时用分页列表。
  const filteredSessions = useMemo(() => {
    const q = sessionFilter.trim().toLowerCase()
    if (!q) return sortedSessions
    // 后端已做标题+消息内容匹配，这里只做排序，不再二次过滤
    // （二次按标题过滤会把「消息内容命中但标题不含关键字」的会话错误剔除）
    return sortSessionsForSidebar(searchResults)
  }, [sortedSessions, searchResults, sessionFilter])

  const [workspacePagination, setWorkspacePaginationState] = useState<
    Record<string, { hasMore: boolean; loading: boolean }>
  >({})
  useEffect(() => {
    void workspacePaginationTick
    const out: Record<string, { hasMore: boolean; loading: boolean }> = {}
    for (const [k, v] of Object.entries(workspacePaginationRef.current)) {
      out[k] = { hasMore: v.hasMore, loading: v.loading }
    }
    queueMicrotask(() => setWorkspacePaginationState(out))
  }, [workspacePaginationTick])

  return {
    sessions,
    setSessions,
    sessionsRef,
    workspaceSummaries,
    workspacePagination,
    listLoading,
    setListLoading,
    sessionFilter,
    setSessionFilter,
    moreMenuKey,
    setMoreMenuKey,
    newChatButtonActive,
    setNewChatButtonActive,
    sortedSessions,
    filteredSessions,
    refreshSessions,
    refreshSessionsRef,
    scheduleRefreshSessions,
    scheduleRefreshSessionsRef,
    ensureWorkspaceExpanded,
    loadMoreWorkspaceSessions,
    loadMoreGlobalRecentSessions,
    purgeWorkspaceFromSidebar,
    removeSessionFromList,
  }
}

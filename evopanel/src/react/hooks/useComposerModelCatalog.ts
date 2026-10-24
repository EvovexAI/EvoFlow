/**
 * Composer model catalog load/hydrate + session model pill sync.
 * Extracted from ChatApp.tsx (P8).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import {
  buildModelConnNameMap,
  defaultModelFromCatalog,
  modelDisplayLabel,
  normalizeModelCatalogRows,
  type ModelCatalogEntry,
} from '../lib/model-catalog.js'
import { parseSceneFromModelPayload } from '../lib/session-mode.js'
import {
  sessionRowFromApi,
  sortSessionsForSidebar,
} from '../lib/session-list/utils.js'
import { isDesktopTauriRuntime } from '../chat-app/utils/desktop-workspace.js'
import { wsClient } from '../../lib/ws-client.js'
import type { ChatSessionRow } from '../chat-types.js'

export function useComposerModelCatalog(opts: {
  selectedSessionKey: string
  sessions: ChatSessionRow[]
  listLoading: boolean
  agentDefaultModelName: string
  roleUiNonce: number
  bottomModelOpen: boolean
  setSessions: Dispatch<SetStateAction<ChatSessionRow[]>>
  sessionsRef: MutableRefObject<ChatSessionRow[]>
}) {
  const {
    selectedSessionKey,
    sessions,
    listLoading,
    agentDefaultModelName,
    roleUiNonce,
    bottomModelOpen,
    setSessions,
    sessionsRef,
  } = opts

  const [modelCatalog, setModelCatalog] = useState<ModelCatalogEntry[]>([])
  /** config.yaml primary_model（与后端 _resolve_model_name 回落一致） */
  const [primaryModelName, setPrimaryModelName] = useState<string>('')
  const [modelName, setModelName] = useState<string>('')
  /** 用于模型↔会话同步：区分「切换会话」与「同会话内改药丸」，避免把上一会话的 modelName 写进新会话 context */
  const syncModelSessionPrevKeyRef = useRef<string | null>(null)
  /** 刷新后按 key 拉会话详情以恢复 model_name；每会话最多尝试一次，避免空模型新会话死循环 */
  const modelHydrateAttemptedRef = useRef<string | null>(null)
  const modelHydrateInflightRef = useRef<string | null>(null)
  /** hydrate 完成后递增，驱动模型同步 effect 再跑一遍 */
  const [modelHydrateTick, setModelHydrateTick] = useState(0)
  const modelsLoadInflightRef = useRef<Promise<void> | null>(null)
  const modelCatalogLoadedRef = useRef(false)
  const [modelsLoading, setModelsLoading] = useState(false)
  /** 连接 key → 自定义展示名映射（来自 /model-connections + localStorage），用于级联菜单区分同厂商多套连接 */
  const [modelConnNameMap, setModelConnNameMap] = useState<Record<string, string>>({})

  const loadModelCatalog = useCallback(async (opts?: { silent?: boolean; forceLive?: boolean }) => {
    const forceLive = !!opts?.forceLive
    if (modelsLoadInflightRef.current) {
      await modelsLoadInflightRef.current
      // A concurrent non-force load may have finished on stale prefetch; forceLive must re-hit /models.
      if (!forceLive) return
    }
    const silent = opts?.silent ?? modelCatalogLoadedRef.current
    const applyCatalog = (rowsRaw: any, primaryRaw: string) => {
      const rows = Array.isArray(rowsRaw?.models)
        ? rowsRaw.models
        : Array.isArray(rowsRaw)
          ? rowsRaw
          : []
      const primary = String(primaryRaw || '').trim()
      if (primary) setPrimaryModelName(primary)
      const next = normalizeModelCatalogRows(rows, parseSceneFromModelPayload)
      setModelCatalog(next)
      modelCatalogLoadedRef.current = next.length > 0
      return next
    }
    const work = (async () => {
      if (forceLive && isDesktopTauriRuntime()) {
        try {
          const prefetchMod = await import('../../lib/tauri-api.js')
          prefetchMod.invalidateModelCatalogPrefetch?.()
        } catch {
          /* ignore */
        }
      }

      // Prefer engineReady prefetch only for the first paint — never after config CRUD.
      if (!forceLive && isDesktopTauriRuntime()) {
        try {
          const prefetchMod = await import('../../lib/tauri-api.js')
          const pref = prefetchMod.getModelCatalogPrefetch?.()
          if (pref) {
            const hit = await Promise.race([
              pref.catch(() => null),
              new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 2500)),
            ])
            if (hit?.models) {
              const p = hit.primary as unknown as { primary_model?: unknown } | null
              const primary =
                typeof p?.primary_model === 'string' ? p.primary_model.trim() : ''
              applyCatalog(hit.models, primary)
              if (!silent) setModelsLoading(false)
              // Connections are display-only; never block catalog paint.
              void (async () => {
                try {
                  const { api } = await import('../../lib/tauri-api.js')
                  const conns = await api.listModelConnections()
                  const list = Array.isArray(conns) ? conns : (conns?.connections || [])
                  setModelConnNameMap(buildModelConnNameMap(list))
                } catch {
                  /* ignore */
                }
              })()
              return
            }
          }
        } catch {
          /* fall through */
        }
      }

      if (!silent) setModelsLoading(true)
      try {
        const { api } = await import('../../lib/tauri-api.js')
        const fetchLive = async () => {
          if (isDesktopTauriRuntime()) {
            const [modelsData, primaryInfo] = await Promise.all([
              api.listModels(),
              api.getPrimaryModel().catch(() => null),
            ])
            return {
              data: modelsData,
              primary:
                typeof primaryInfo?.primary_model === 'string'
                  ? primaryInfo.primary_model.trim()
                  : '',
            }
          }
          const [resp, primaryInfo] = await Promise.all([
            fetch('/api/models'),
            api.getPrimaryModel().catch(() => null),
          ])
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const data = await resp.json()
          return {
            data,
            primary:
              typeof primaryInfo?.primary_model === 'string'
                ? primaryInfo.primary_model.trim()
                : '',
          }
        }
        const live = await Promise.race([
          fetchLive(),
          new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 12_000)),
        ])
        if (!live) {
          if (!modelCatalogLoadedRef.current) {
            setModelCatalog([])
            modelCatalogLoadedRef.current = false
          }
          return
        }
        applyCatalog(live.data, live.primary)
        void (async () => {
          try {
            const conns = await api.listModelConnections()
            const list = Array.isArray(conns) ? conns : (conns?.connections || [])
            setModelConnNameMap(buildModelConnNameMap(list))
          } catch {
            /* ignore */
          }
        })()
      } catch {
        if (!modelCatalogLoadedRef.current) {
          setModelCatalog([])
          modelCatalogLoadedRef.current = false
        }
      }
    })()
    modelsLoadInflightRef.current = work
    try {
      await work
    } finally {
      modelsLoadInflightRef.current = null
      if (!silent) setModelsLoading(false)
    }
  }, [])

  /** 跟随智能体时的展示/回落模型名 */
  const followResolvedModelName = useMemo(() => {
    if (agentDefaultModelName) return agentDefaultModelName
    return defaultModelFromCatalog(modelCatalog, primaryModelName) || String(primaryModelName || '').trim()
  }, [agentDefaultModelName, modelCatalog, primaryModelName])

  /** 会话是否已钉死 model_name（覆盖智能体默认） */
  const sessionModelOverride = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return ''
    const row = sessions.find((s) => String(s.sessionKey || '') === sk)
    const rowModel = String(row?.modelName || '').trim()
    const ctxRaw = String(wsClient.getSessionContext(sk)?.model_name ?? '').trim()
    return ctxRaw || rowModel
    // modelHydrateTick / roleUiNonce：hydrate 与切角色后重读 context
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionKey, sessions, modelHydrateTick, roleUiNonce])

  useEffect(() => {
    if (modelsLoading || !modelCatalog.length) return

    if (!selectedSessionKey) {
      syncModelSessionPrevKeyRef.current = null
      const def = followResolvedModelName || defaultModelFromCatalog(modelCatalog, primaryModelName)
      if (def) {
        queueMicrotask(() => setModelName((prev) => ((prev || '').trim() === def ? prev : def)))
      }
      return
    }

    if (listLoading) return

    const sk = selectedSessionKey
    syncModelSessionPrevKeyRef.current = sk

    const stored = sessionModelOverride
    // 后端 stored 是用户选择模型的权威值：非空时一律保留（无论是否在当前 catalog 内），
    // 避免 catalog 暂时不全/加载竞态时兜底成 primary 后无法回到用户实际选择的模型。
    // 仅当 stored 为空（跟随智能体）时用智能体默认 → primary 做 UI 展示；
    // 切勿把展示回落写回后端。
    if (!stored && modelHydrateAttemptedRef.current !== sk) {
      // 等按 key 拉取真实行完成后再决定是否跟随，避免刷新瞬间误判
      return
    }
    const desired = stored || followResolvedModelName
    if (!desired) return

    setModelName((prev) => ((prev || '').trim() === desired ? prev : desired))
  }, [
    selectedSessionKey,
    modelCatalog,
    modelsLoading,
    primaryModelName,
    listLoading,
    sessions,
    modelHydrateTick,
    sessionModelOverride,
    followResolvedModelName,
  ])

  // 刷新/分页竞态：选中会话不在当前页或仅为占位行时，按 key 拉真实行以恢复 model_name
  useEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk || listLoading) return

    const row = sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
    const rowModel = String(row?.modelName || '').trim()
    const ctxModel = String(wsClient.getSessionContext(sk)?.model_name ?? '').trim()
    if (rowModel || ctxModel) {
      if (modelHydrateAttemptedRef.current !== sk) {
        modelHydrateAttemptedRef.current = sk
        setModelHydrateTick((n) => n + 1)
      }
      return
    }
    if (modelHydrateAttemptedRef.current === sk) return
    if (modelHydrateInflightRef.current === sk) return
    modelHydrateInflightRef.current = sk

    let cancelled = false
    void (async () => {
      try {
        const { api } = await import('../../lib/tauri-api.js')
        const got = await api.chatSessionsGet(sk)
        if (cancelled) return
        if (got) {
          const next = sessionRowFromApi(got as ChatSessionRow & { key?: string })
          if (next.sessionKey) {
            setSessions((prev) => {
              const rest = prev.filter((s) => String(s.sessionKey || '') !== next.sessionKey)
              return sortSessionsForSidebar([next, ...rest])
            })
          }
        }
      } catch {
        /* ignore — UI 回落 primary，且不会写回后端 */
      } finally {
        if (modelHydrateInflightRef.current === sk) modelHydrateInflightRef.current = null
        if (!cancelled) {
          modelHydrateAttemptedRef.current = sk
          setModelHydrateTick((n) => n + 1)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedSessionKey, listLoading, sessionsRef, setSessions])

  useEffect(() => {
    if (!bottomModelOpen) return
    // Re-hit live /models on each open so console CRUD shows up without remount.
    // Depend only on open→true (not catalog length) to avoid a reload loop.
    void loadModelCatalog({
      silent: modelCatalogLoadedRef.current,
      forceLive: true,
    })
  }, [bottomModelOpen, loadModelCatalog])

  const effectiveModelName = useMemo(() => {
    if (modelsLoading && !modelCatalog.length) return ''
    const pill = (modelName || '').trim()
    // 保留会话已选 / 当前展示模型（即使 catalog 暂未就绪），避免刷新时瞬时回落成 primary
    if (pill) return pill
    return followResolvedModelName || defaultModelFromCatalog(modelCatalog, primaryModelName)
  }, [modelName, modelCatalog, primaryModelName, modelsLoading, followResolvedModelName])

  const modelPillLabel = useMemo(() => {
    if (modelsLoading && !modelCatalog.length) return '加载中…'
    const pill = (modelName || '').trim()
    if (pill) {
      const entry = modelCatalog.find((m) => m.name === pill)
      return modelDisplayLabel(entry) || pill
    }
    if (effectiveModelName) {
      const entry = modelCatalog.find((m) => m.name === effectiveModelName)
      return modelDisplayLabel(entry) || effectiveModelName
    }
    const fallback = modelCatalog[0]
    if (fallback) return modelDisplayLabel(fallback) || fallback.name
    return primaryModelName.trim() || '默认模型'
  }, [modelName, effectiveModelName, modelsLoading, primaryModelName, modelCatalog])

  return {
    modelCatalog,
    primaryModelName,
    modelName,
    setModelName,
    modelsLoading,
    modelConnNameMap,
    modelHydrateTick,
    loadModelCatalog,
    followResolvedModelName,
    sessionModelOverride,
    effectiveModelName,
    modelPillLabel,
    syncModelSessionPrevKeyRef,
    modelCatalogLoadedRef,
  }
}

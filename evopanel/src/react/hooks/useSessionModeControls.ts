/**
 * Session mode / thinking / collab server patch helpers.
 * Extracted from ChatApp.tsx (P12).
 */
import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { wsClient } from '../../lib/ws-client.js'
import { toast } from '../../components/toast.js'
import {
  MODE_TO_SCENARIO,
  DEFAULT_SESSION_MODES,
  modeLabel,
  setSessionModeInMeta,
  type SessionMode,
} from '../lib/session-mode.js'
import {
  getSessionCollabModeFromMeta,
  setSessionCollabModeInMeta,
  setThinkingLevelInMeta,
} from '../chat-app/utils/session-meta.js'
import type { ThinkingLevel } from '../chat-app/utils/storage.js'

type ModeRow = { value: string; label: string; visible: boolean; scenario: string | null }

async function getApi() {
  const mod = await import('../../lib/tauri-api.js')
  return mod.api
}

export function useSessionModeControls(opts: {
  sessionMode: SessionMode
  setSessionMode: Dispatch<SetStateAction<SessionMode>>
  setThinkingLevel: Dispatch<SetStateAction<ThinkingLevel>>
  setCollabOn: Dispatch<SetStateAction<boolean>>
  dynamicModes: ModeRow[] | null
  selectedSessionKey: string
  sessionRef: MutableRefObject<string>
}) {
  const {
    sessionMode,
    setSessionMode,
    setThinkingLevel,
    setCollabOn,
    dynamicModes,
    selectedSessionKey,
    sessionRef,
  } = opts

  const reconcileCollabWithMode = useCallback(async (sessionKey: string) => {
    const api = await getApi()
    const on = getSessionCollabModeFromMeta(sessionKey)
    if (on) {
      await api.chatUpdateContext(sessionKey, {
        subagent_enabled: true,
        is_plan_mode: true,
        collab_phase: 'planning',
        collab_task_id: null,
      })
    } else {
      await api.chatUpdateContext(sessionKey, { collab_phase: 'idle', collab_task_id: null })
      // 与 toggleCollab(off) 一致：把磁盘 thread collab 拉回 idle，否则中间件仍按 planning 注入 <collab_phase_context>
      const threadId = await wsClient.ensureChatThread(sessionKey)
      if (threadId) {
        try {
          await wsClient.putThreadCollabState(threadId, { collab_phase: 'idle', bound_task_id: null })
        } catch {
          /* ignore */
        }
      }
    }
  }, [])

  const applyCollabServerPatch = useCallback(async (sessionKey: string, on: boolean) => {
    const threadId = on
      ? await wsClient.ensureChatThread(sessionKey)
      : (await wsClient.ensureChatThread(sessionKey).catch(() => wsClient.getSessionThreadId(sessionKey)))
    if (!threadId) return
    if (on) {
      const collab = await wsClient.putThreadCollabState(threadId, { collab_phase: 'planning' })
      const boundTaskId =
        collab && typeof collab.bound_task_id === 'string' && collab.bound_task_id.trim()
          ? collab.bound_task_id.trim()
          : ''
      if (boundTaskId) {
        try {
          const api = await getApi()
          await api.chatUpdateContext(sessionKey, {
            collab_task_id: boundTaskId,
            is_plan_mode: true,
            collab_phase: 'planning',
          })
        } catch {
          /* ignore */
        }
      }
    } else {
      await wsClient.putThreadCollabState(threadId, {
        collab_phase: 'idle',
        bound_task_id: null,
      })
    }
  }, [])

  const applySessionModePreset = useCallback(
    async (sessionKey: string, mode: SessionMode) => {
      const api = await getApi()
      const scenario = MODE_TO_SCENARIO[mode] ?? null
      // 通过场景接口设置 activated_scenarios（chat/workspace/plan/null=auto）
      await api.setSessionScenario(sessionKey, scenario)
      // 兼容旧 context 字段：同步 session_mode（后端中间件仍可能读取）；思考由后端 AUTO 决策，不传 thinking_enabled
      const contextUpdate: Record<string, any> = {
        session_mode: mode,
        thinking_type: 'auto',
        thinking_enabled: null,
        reasoning_effort: null,
      }
      // 切换模式时重置思考等级为自动
      setThinkingLevel('auto')
      setThinkingLevelInMeta(sessionKey, 'auto')
      // 同步本地 ws-client session context
      wsClient.updateSessionContext(sessionKey, contextUpdate)
      if (mode === 'plan') {
        contextUpdate.is_plan_mode = true
        contextUpdate.subagent_enabled = true
        contextUpdate.collab_phase = 'planning'
      } else {
        contextUpdate.is_plan_mode = false
        contextUpdate.subagent_enabled = false
      }
      await api.chatUpdateContext(sessionKey, contextUpdate)
      // plan 模式需要同步协作状态
      if (mode === 'plan') {
        if (!getSessionCollabModeFromMeta(sessionKey)) {
          setSessionCollabModeInMeta(sessionKey, true)
          setCollabOn(true)
        }
        await applyCollabServerPatch(sessionKey, true)
      } else {
        if (getSessionCollabModeFromMeta(sessionKey)) {
          setSessionCollabModeInMeta(sessionKey, false)
          setCollabOn(false)
          await applyCollabServerPatch(sessionKey, false)
        }
      }
      await reconcileCollabWithMode(sessionKey)
    },
    [setThinkingLevel, setCollabOn, applyCollabServerPatch, reconcileCollabWithMode],
  )

  const applyThinkingLevel = useCallback(
    async (sessionKey: string, level: ThinkingLevel) => {
      if (!sessionKey) return
      setThinkingLevelInMeta(sessionKey, level)
      setThinkingLevel(level)
      const api = await getApi()
      let contextUpdate: Record<string, any>
      if (level === 'auto') {
        // auto 模式：交回后端 AUTO 决策
        contextUpdate = { thinking_type: 'auto', thinking_enabled: null, reasoning_effort: null }
        toast('思考模式：自动（由后端决策）', 'success')
      } else if (level === 'off') {
        contextUpdate = { thinking_type: 'manual', thinking_enabled: false, reasoning_effort: 'minimum' }
        toast('思考模式：关闭', 'success')
      } else {
        const effortMap: Record<string, string> = { low: 'low', medium: 'medium', high: 'high' }
        contextUpdate = {
          thinking_type: 'manual',
          thinking_enabled: true,
          reasoning_effort: effortMap[level] || 'medium',
        }
        toast(`思考模式：${level === 'low' ? '轻度' : level === 'medium' ? '中度' : '深度'}思考`, 'success')
      }
      // 同步本地 ws-client session context（chatSend 从本地读取构建 runContext）
      wsClient.updateSessionContext(sessionKey, contextUpdate)
      // 同步后端 DB
      await api.chatUpdateContext(sessionKey, contextUpdate)
    },
    [setThinkingLevel],
  )

  const setCollabPhaseForSession = useCallback(
    async (sessionKey: string, phase: 'planning' | 'executing' | 'idle') => {
      const api = await getApi()
      await api.chatUpdateContext(sessionKey, { collab_phase: phase })
      const threadId = await wsClient.ensureChatThread(sessionKey)
      if (!threadId) return
      if (phase === 'idle') {
        await wsClient.putThreadCollabState(threadId, { collab_phase: 'idle', bound_task_id: null })
        return
      }
      await wsClient.putThreadCollabState(threadId, { collab_phase: phase })
    },
    [],
  )

  const setSessionModeAndApply = useCallback(
    async (mode: SessionMode) => {
      if (mode === sessionMode) return
      setSessionMode(mode)
      const key = sessionRef.current || selectedSessionKey
      if (!key) {
        toast(`已切换为：${modeLabel(mode, dynamicModes || DEFAULT_SESSION_MODES)}`, 'success')
        return
      }
      setSessionModeInMeta(key, mode)
      try {
        await applySessionModePreset(key, mode)
        toast(`已切换为：${modeLabel(mode, dynamicModes || DEFAULT_SESSION_MODES)}`, 'success')
      } catch (e) {
        toast(`切换模式失败: ${String((e as Error)?.message || e)}`, 'error')
      }
    },
    [
      sessionMode,
      setSessionMode,
      sessionRef,
      selectedSessionKey,
      dynamicModes,
      applySessionModePreset,
    ],
  )

  return {
    reconcileCollabWithMode,
    applySessionModePreset,
    applyThinkingLevel,
    applyCollabServerPatch,
    setCollabPhaseForSession,
    setSessionModeAndApply,
  }
}

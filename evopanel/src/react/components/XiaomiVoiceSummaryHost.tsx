/**
 * 小V 语音舞台：复用主聊 ChatSummaryPanel（气泡 → 面板）。
 * 智能体 / 工具 / 提示词 / 调试 走同一套。
 *
 * 展开面板必须 portal 到 body：语音左栏在右栏打开时只有 ~340–480px，
 * 且 .xws-root overflow:hidden，卡在宿主里会被裁掉一半。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatSummaryPanel } from './ChatSummaryPanel.js'
import type { AgentCapabilityPatch } from './AgentCapabilityTabs.js'
import type { ThinkingPref, MemoryPref } from './AgentRolePrefs.js'
import type { ChatSummaryDisplayMode } from '../lib/chat-summary-panel-prefs.js'
import type { AgentAvatarAgent } from '../lib/agent-avatar.js'
import { toast } from '../../components/toast.js'
import { getState, subscribe } from '../../components/global-assistant/assistant-store.js'
import { openCurrentAgentEditor } from '../chat-app/agents/open-current-agent-editor.js'
import { patchCurrentAgentCapabilities } from '../chat-app/agents/patch-current-agent-capabilities.js'

const PANEL_W = 360
const BUBBLE_GAP = 8
const EDGE = 16

const XIAOMI = 'xiaomi'

type PortalPos = { top: number; right: number; overlay: boolean }

function samePortalPos(a: PortalPos, b: PortalPos): boolean {
  return a.top === b.top && a.right === b.right && a.overlay === b.overlay
}

function asStringList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  return raw.map((x) => String(x || '').trim()).filter(Boolean)
}

export function XiaomiVoiceSummaryHost(props: {
  sessionKey: string
  /** 递增时强制展开为面板（如点顶栏模型条） */
  expandSignal?: number
}) {
  const { sessionKey, expandSignal = 0 } = props
  const sk = String(sessionKey || '').trim()

  const [displayMode, setDisplayMode] = useState<ChatSummaryDisplayMode>('capsule')
  const [agent, setAgent] = useState<AgentAvatarAgent | null>(null)
  const [roleNonce, setRoleNonce] = useState(0)
  const [capBusy, setCapBusy] = useState(false)
  const [threadId, setThreadId] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [modelName, setModelName] = useState('')
  const [modelLabel, setModelLabel] = useState('')
  const [thinkingPref, setThinkingPref] = useState<ThinkingPref>('follow')
  const [memoryEnabled, setMemoryEnabled] = useState(true)
  const [modelSupportsThinking, setModelSupportsThinking] = useState<boolean | null>(null)
  /** fixed 锚点：相对视口；窄左栏展开时改贴视口右侧，避免裁切 */
  const [portalPos, setPortalPos] = useState<PortalPos>({
    top: 56,
    right: EDGE,
    overlay: false,
  })
  const displayModeRef = useRef(displayMode)
  displayModeRef.current = displayMode

  const onDisplayModeChange = useCallback((mode: ChatSummaryDisplayMode) => {
    setDisplayMode((prev) => (prev === mode ? prev : mode))
  }, [])

  useEffect(() => {
    if (expandSignal > 0) onDisplayModeChange('panel')
  }, [expandSignal, onDisplayModeChange])

  /*
   * 测距必须：
   * - 用 useEffect（勿 layout）：避免与 Bridge / right-stage 的 layout 写叠成 #185
   * - 值不变不 setState：ResizeObserver / MutationObserver 会连打
   * - rAF 合并：同一帧多次 observer 只落地一次
   */
  useEffect(() => {
    let raf = 0
    let cancelled = false
    const apply = (next: PortalPos) => {
      if (cancelled) return
      setPortalPos((prev) => (samePortalPos(prev, next) ? prev : next))
    }
    const measure = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        const host = document.querySelector('.xw-voice-host') as HTMLElement | null
        if (!host) {
          apply({ top: 56, right: EDGE, overlay: true })
          return
        }
        const r = host.getBoundingClientRect()
        const winW = window.innerWidth
        const hostW = Math.max(0, r.width)
        const top = Math.max(8, Math.round(r.top + 10))
        const open = displayModeRef.current === 'panel'
        if (open && hostW < PANEL_W + EDGE * 2) {
          apply({ top, right: EDGE, overlay: true })
          return
        }
        let insetRight = Math.max(EDGE, Math.round(winW - r.right + EDGE))
        if (!open) {
          const recent = host.querySelector('.xws-recent') as HTMLElement | null
          if (recent) {
            const rw = recent.getBoundingClientRect().width
            if (rw > 40 && hostW > rw + 56) {
              insetRight = Math.max(
                EDGE,
                Math.round(winW - r.right + EDGE + rw + BUBBLE_GAP),
              )
            }
          }
        }
        apply({ top, right: insetRight, overlay: false })
      })
    }
    measure()
    window.addEventListener('resize', measure)
    const host = document.querySelector('.xw-voice-host')
    const ro = host && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (host && ro) ro.observe(host)
    const mo =
      typeof MutationObserver !== 'undefined' ? new MutationObserver(measure) : null
    const body = document.querySelector('.react-chat-main-body')
    if (body && mo) mo.observe(body, { attributes: true, attributeFilter: ['class'] })
    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
      ro?.disconnect()
      mo?.disconnect()
    }
  }, [displayMode])

  useEffect(() => {
    const sync = () => {
      try {
        const st = getState()
        const next = !!st.streaming
        setIsRunning((prev) => (prev === next ? prev : next))
      } catch {
        /* ignore */
      }
    }
    sync()
    const unsub = subscribe(sync)
    return () => {
      try {
        unsub?.()
      } catch {
        /* ignore */
      }
    }
  }, [])

  useEffect(() => {
    if (!sk) {
      setThreadId('')
      return
    }
    let cancelled = false
    const pull = async () => {
      try {
        const { wsClient } = await import('../../lib/ws-client.js')
        const tid = String(wsClient.getSessionThreadId?.(sk) || '').trim()
        if (cancelled) return
        setThreadId((prev) => (prev === tid ? prev : tid))
        const ctx = (wsClient.getSessionContext?.(sk) || {}) as Record<string, unknown>
        const mid = String(ctx.modelName || ctx.model_name || '').trim()
        if (mid) setModelName((prev) => (prev === mid ? prev : mid))
        const nextThink: ThinkingPref =
          ctx.thinking_enabled === false ? 'off' : ctx.thinking_enabled === true ? 'on' : 'follow'
        setThinkingPref((prev) => (prev === nextThink ? prev : nextThink))
        const nextMem = ctx.memory_enabled !== false
        setMemoryEnabled((prev) => (prev === nextMem ? prev : nextMem))
      } catch {
        if (!cancelled) setThreadId((prev) => (prev === '' ? prev : ''))
      }
    }
    void pull()
    const t = window.setInterval(() => void pull(), 3000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [sk, isRunning, roleNonce])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { api } = await import('../../lib/tauri-api.js')
        const row = (await api.getAgent(XIAOMI)) as Record<string, unknown> | null
        if (cancelled || !row) return
        setAgent(row as AgentAvatarAgent)
        const agentModel = String(row.model || row.model_name || '').trim()
        setModelName((prev) => prev || agentModel)
        const label = String(row.name || row.display_name || row.label || '小V').trim()
        setModelLabel(label)
      } catch {
        if (!cancelled) setAgent({ agent_code: XIAOMI } as AgentAvatarAgent)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [roleNonce])

  useEffect(() => {
    const mid = String(modelName || '').trim()
    if (!mid) {
      setModelSupportsThinking(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const { api } = await import('../../lib/tauri-api.js')
        const list = await api.listModels().catch(() => null)
        const rows: Record<string, unknown>[] = Array.isArray(list)
          ? (list as Record<string, unknown>[])
          : Array.isArray((list as { models?: unknown })?.models)
            ? ((list as { models: Record<string, unknown>[] }).models)
            : []
        const hit = rows.find(
          (r) => String(r?.name || r?.id || r?.model || '').trim() === mid,
        )
        if (cancelled || !hit) return
        const label = String(hit.label || hit.display_name || hit.title || '').trim()
        if (label) setModelLabel(label)
        const alwaysOn = hit.thinking_always_on === true
        const canOff = hit.can_disable_thinking !== false
        setModelSupportsThinking(alwaysOn ? true : canOff ? true : false)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [modelName, roleNonce])

  const skillNames = useMemo(() => {
    const fromAgent = asStringList((agent as { skills?: unknown } | null)?.skills) || []
    return fromAgent
  }, [agent])

  const toolNames = useMemo(
    () => asStringList((agent as { tools?: unknown } | null)?.tools),
    [agent],
  )
  const mcpServers = useMemo(
    () => asStringList((agent as { mcp_servers?: unknown } | null)?.mcp_servers),
    [agent],
  )
  const knowledgeVaultIds = useMemo(
    () => asStringList((agent as { knowledge_vault_ids?: unknown } | null)?.knowledge_vault_ids) || [],
    [agent],
  )

  const refreshAgentsList = useCallback(async () => {
    setRoleNonce((n) => n + 1)
  }, [])

  const onEditAgent = useCallback(() => {
    openCurrentAgentEditor({
      agents: agent ? [agent as never] : [],
      currentRoleCodeForUi: XIAOMI,
      employeeSessionAgentCode: null,
      isProactiveEmployeeSession: false,
      refreshAgentsList,
      setRoleUiNonce: setRoleNonce,
    })
  }, [agent, refreshAgentsList])

  const onPatchCapabilities = useCallback(
    async (patch: AgentCapabilityPatch) => {
      await patchCurrentAgentCapabilities(
        {
          currentRoleCodeForUi: XIAOMI,
          employeeSessionAgentCode: null,
          isProactiveEmployeeSession: false,
          getApi: async () => {
            const { api } = await import('../../lib/tauri-api.js')
            return {
              proactiveUpdateRole: (code, patch) => api.proactiveUpdateRole(code, patch),
              updateAgent: (code, patch) => api.updateAgent(code, patch),
            }
          },
          setCapabilityPatchBusy: setCapBusy,
          setRoleUiNonce: setRoleNonce,
          refreshAgentsList,
        },
        patch,
      )
    },
    [refreshAgentsList],
  )

  const onApplySessionThinking = useCallback(
    async (pref: ThinkingPref) => {
      if (!sk) return
      const { wsClient } = await import('../../lib/ws-client.js')
      const { api } = await import('../../lib/tauri-api.js')
      let contextUpdate: Record<string, unknown>
      if (pref === 'follow') {
        contextUpdate = { thinking_type: 'auto', thinking_enabled: null, reasoning_effort: null }
        toast('思考模式：自动（由后端决策）', 'success')
      } else if (pref === 'off') {
        contextUpdate = {
          thinking_type: 'manual',
          thinking_enabled: false,
          reasoning_effort: 'minimum',
        }
        toast('思考模式：关闭', 'success')
      } else {
        contextUpdate = {
          thinking_type: 'manual',
          thinking_enabled: true,
          reasoning_effort: 'medium',
        }
        toast('思考模式：中度思考', 'success')
      }
      wsClient.updateSessionContext(sk, contextUpdate)
      await api.chatUpdateContext(sk, contextUpdate).catch(() => {})
      setThinkingPref(pref)
    },
    [sk],
  )

  const onApplySessionMemory = useCallback(
    async (pref: MemoryPref) => {
      if (!sk) return
      const memory_enabled = pref !== 'off'
      const { wsClient } = await import('../../lib/ws-client.js')
      const { api } = await import('../../lib/tauri-api.js')
      wsClient.updateSessionContext(sk, { memory_enabled })
      await api.chatUpdateContext(sk, { memory_enabled }).catch(() => {})
      setMemoryEnabled(memory_enabled)
      toast(memory_enabled ? '已开启记忆（本会话）' : '已关闭记忆（本会话）', 'success')
    },
    [sk],
  )

  const agentLabel = String(
    (agent as { name?: string; display_name?: string } | null)?.name ||
      (agent as { display_name?: string } | null)?.display_name ||
      '小V',
  ).trim()
  const agentDescription = String(
    (agent as { description?: string } | null)?.description || '',
  ).trim()
  const pillModel = String(modelName || '').trim()
  const pillLabel = pillModel
    ? modelLabel && modelLabel !== pillModel
      ? `${modelLabel} (${pillModel})`
      : pillModel
    : modelLabel || '模型…'

  if (!sk || typeof document === 'undefined') return null

  const node = (
    <div
      className={`xws-summary-portal${displayMode === 'panel' ? ' is-open' : ''}${
        portalPos.overlay ? ' is-overlay' : ''
      }`}
      data-tauri-no-drag=""
      style={{ top: portalPos.top, right: portalPos.right }}
    >
      {portalPos.overlay && displayMode === 'panel' ? (
        <button
          type="button"
          className="xws-summary-portal-scrim"
          aria-label="收起状态面板"
          onClick={() => setDisplayMode('capsule')}
        />
      ) : null}
      <ChatSummaryPanel
        key={sk}
        displayMode={displayMode}
        onDisplayModeChange={onDisplayModeChange}
        isRunning={isRunning}
        sessionKey={sk}
        sessionTitle="小V 语音"
        agentLabel={agentLabel}
        modelLabel={pillLabel}
        modelName={pillModel}
        agentCode={XIAOMI}
        agentDescription={agentDescription}
        agent={agent}
        skillNames={skillNames}
        toolNames={toolNames}
        mcpServers={mcpServers}
        knowledgeVaultIds={knowledgeVaultIds}
        onPatchCapabilities={onPatchCapabilities}
        capabilityBusy={capBusy}
        onEditAgent={onEditAgent}
        modelSupportsThinking={modelSupportsThinking}
        sessionThinkingPref={thinkingPref}
        sessionMemoryEnabled={memoryEnabled}
        onApplySessionThinking={onApplySessionThinking}
        onApplySessionMemory={onApplySessionMemory}
        onMemoryEnabledChange={setMemoryEnabled}
        obsEnabled
        threadId={threadId}
      />
    </div>
  )

  return createPortal(node, document.body)
}

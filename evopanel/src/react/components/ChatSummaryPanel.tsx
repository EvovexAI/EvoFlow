/**
 * 状态面板（对齐 ZCode 形态）
 *
 * 三态：hidden（不渲染） / capsule（右侧气泡） / panel（右侧悬浮卡）。
 * 布局：对话 | 右侧占位（同底色）；视觉：内容多高就多高的悬浮卡，非通栏块。
 * 与专用 Right Stage 互斥。
 * 两区：
 * - 进程：terminal + 子智能体 + 协作子任务 聚合成一条有序列表
 * - 智能体 / 员工：普通会话为能力卡；员工会话用 EmployeePane（身份 + 职责合一）
 * - 更多：折叠收纳产物 / 平台 / 调试 / 任务（保留旧侧栏能力，不丢功能）
 *
 * 不做「计划」区：计划确认条仍在输入区上方（PlanExecConfirm）。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Ellipsis,
  Minimize2,
  Pencil,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import AgentAvatar from './AgentAvatar.js'
import { AgentCapabilityTabs, type AgentCapabilityPatch } from './AgentCapabilityTabs.js'
import { AssetQuickActions, partitionArtifacts } from './ChatWorkspaceInfoRail.js'
import { PlatformRunTable } from './PlatformRunTable.js'
import { SessionDebugPane } from './SessionDebugPane.js'
import { chatArtifactDisplayLabel, type ChatArtifact } from '../lib/chat-artifact.js'
import {
  formatInfoRailTime,
  infoRailScopeLabel,
  type InfoRailScope,
} from '../lib/info-rail-format.js'
import { normalizePlatformRunEntries, type PlatformRunEntry } from '../../lib/right-stage/platform-feedback.js'
import {
  buildProcessSummary,
  PROCESS_STATE_LABEL,
  type ProcessItem,
  type ProcessState,
  type ProcessSummary,
} from '../lib/chat-summary-panel-model.js'
import {
  loadChatSummaryPrefs,
  saveChatSummaryExpandPolicy,
  type ChatSummaryDisplayMode,
  type ChatSummaryExpandPolicy,
} from '../lib/chat-summary-panel-prefs.js'
import type { CollabSubtaskSnapshot, SubagentStreamTask, TerminalStreamTask } from '../chat-types.js'
import type { AgentAvatarAgent } from '../lib/agent-avatar.js'

type Props = {
  displayMode: ChatSummaryDisplayMode
  onDisplayModeChange: (mode: ChatSummaryDisplayMode) => void

  isRunning: boolean
  sessionTitle: string

  /** 进程区数据源 */
  terminalStreams?: Record<string, TerminalStreamTask> | null
  subagentTasks?: Record<string, SubagentStreamTask> | null
  workflowSubtasks?: CollabSubtaskSnapshot[] | null
  backgroundWorks?: Record<string, import('../chat-types.js').BackgroundWorkStreamItem> | null
  onOpenProcessItem?: (item: ProcessItem) => void
  onStopProcessItem?: (item: ProcessItem) => void

  /** 智能体区（复用旧 AgentPane 载荷） */
  agentLabel: string
  modelLabel: string
  modelName?: string
  agentCode?: string
  agentDescription?: string
  agent?: AgentAvatarAgent | null
  skillNames?: string[]
  toolNames?: string[] | null
  mcpServers?: string[] | null
  knowledgeVaultIds?: string[]
  onPatchCapabilities?: (patch: AgentCapabilityPatch) => Promise<void>
  capabilityBusy?: boolean
  onSwitchAgent?: () => void
  onEditAgent?: () => void
  /** 资产沉淀：记录过程 / 沉淀经验 / 反思 */
  onAssetQuickAction?: (kind: 'episode' | 'craft' | 'journal') => void
  assetQuickBusy?: boolean

  /** 更多区：产物 / 平台 / 调试 */
  artifacts?: ChatArtifact[]
  recentArtifacts?: ChatArtifact[]
  artifactFocusId?: string
  platformEntries?: PlatformRunEntry[]
  recentPlatformEntries?: PlatformRunEntry[]
  platformFocusEntryId?: string
  onOpenArtifact?: (item: ChatArtifact) => void
  onRevealArtifact?: (item: ChatArtifact) => void
  obsEnabled?: boolean
  threadId?: string

  /**
   * 员工会话：employeePane 取代「智能体」身份卡（含职责/审批等），
   * 不再单独挂「岗位」Tab；taskPane 仍在更多区。
   */
  isEmployeeSession?: boolean
  employeePane?: ReactNode
  taskPane?: ReactNode
}

const PROCESS_STATE_ICON: Record<ProcessState, LucideIcon> = {
  running: CircleDashed,
  completed: CircleCheck,
  failed: CircleX,
  cancelled: CircleSlash,
  pending: CircleDashed,
}

const EXPAND_POLICY_OPTIONS: Array<{ id: ChatSummaryExpandPolicy; label: string }> = [
  { id: 'auto-expand', label: '运行时自动展开' },
  { id: 'sticky', label: '保持面板（不收起）' },
  { id: 'sticky-collapsed', label: '保持收起为气泡' },
]

function ArtifactRows({
  items,
  recentIds,
  focusArtifactId,
  onOpen,
  onReveal,
}: {
  items: ChatArtifact[]
  recentIds: Set<string>
  focusArtifactId: string
  onOpen?: (it: ChatArtifact) => void
  onReveal?: (it: ChatArtifact) => void
}) {
  if (!items.length) return <div className="chat-summary-empty">暂无产物。</div>
  return (
    <ul className="chat-summary-process-list">
      {items.map((it) => {
        const label = chatArtifactDisplayLabel(it)
        const isTurn = recentIds.has(it.id)
        const isLatest = focusArtifactId === it.id
        const scope: InfoRailScope = isLatest ? 'latest' : isTurn ? 'turn' : 'existing'
        const time = formatInfoRailTime(it.updatedAt || it.createdAt)
        return (
          <li key={it.id}>
            <button
              type="button"
              className="chat-summary-process-item"
              title={[label, time ? `时间 ${time}` : '', infoRailScopeLabel(scope)]
                .filter(Boolean)
                .join(' · ')}
              onClick={() => onOpen?.(it)}
              onContextMenu={
                onReveal
                  ? (e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onReveal(it)
                    }
                  : undefined
              }
            >
              <CircleCheck className="chat-summary-process-icon" aria-hidden />
              <span className="chat-summary-process-main">
                <span className="chat-summary-process-label">{label}</span>
                <span className="chat-summary-process-detail">{time || it.type || '—'}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** 面板级 tab：智能体 + 进程 + 原「更多」内容合并进同一头部 */
type PanelTab = 'agent' | 'process' | 'artifacts' | 'platform' | 'debug' | 'employee' | 'task'

function MorePane({
  tab,
  artifacts,
  recentArtifacts = [],
  artifactFocusId = '',
  platformEntries = [],
  recentPlatformEntries = [],
  platformFocusEntryId = '',
  onOpenArtifact,
  onRevealArtifact,
  obsEnabled,
  threadId = '',
  isRunning,
  task,
}: {
  tab: PanelTab
  artifacts: ChatArtifact[]
  recentArtifacts?: ChatArtifact[]
  artifactFocusId?: string
  platformEntries?: PlatformRunEntry[]
  recentPlatformEntries?: PlatformRunEntry[]
  platformFocusEntryId?: string
  onOpenArtifact?: (it: ChatArtifact) => void
  onRevealArtifact?: (it: ChatArtifact) => void
  obsEnabled?: boolean
  threadId?: string
  isRunning: boolean
  task?: ReactNode
}) {
  // 沿用旧侧栏的三段分组（最新 / 当前轮次 / 已有），别把结构信息压平
  const grouped = useMemo(
    () => partitionArtifacts(artifacts, recentArtifacts, artifactFocusId),
    [artifacts, recentArtifacts, artifactFocusId],
  )
  const latestId = grouped.latestId

  return (
    <div className="chat-summary-more-body">
      {tab === 'artifacts' ? (
          <>
            {grouped.latestItem ? (
              <>
                <div className="chat-summary-subsection-label">最新产物</div>
                <ArtifactRows
                  items={[grouped.latestItem]}
                  recentIds={grouped.recentIds}
                  focusArtifactId={latestId}
                  onOpen={onOpenArtifact}
                  onReveal={onRevealArtifact}
                />
              </>
            ) : null}
            {grouped.turnItems.length > 0 ? (
              <>
                <div className="chat-summary-subsection-label">当前轮次</div>
                <ArtifactRows
                  items={grouped.turnItems}
                  recentIds={grouped.recentIds}
                  focusArtifactId={latestId}
                  onOpen={onOpenArtifact}
                  onReveal={onRevealArtifact}
                />
              </>
            ) : null}
            {grouped.existing.length > 0 ? (
              <>
                <div className="chat-summary-subsection-label">已有产物</div>
                <ArtifactRows
                  items={grouped.existing}
                  recentIds={grouped.recentIds}
                  focusArtifactId={latestId}
                  onOpen={onOpenArtifact}
                  onReveal={onRevealArtifact}
                />
              </>
            ) : null}
            {!grouped.latestItem &&
            grouped.turnItems.length === 0 &&
            grouped.existing.length === 0 &&
            grouped.all.length > 0 ? (
              <ArtifactRows
                items={grouped.all}
                recentIds={grouped.recentIds}
                focusArtifactId={latestId}
                onOpen={onOpenArtifact}
                onReveal={onRevealArtifact}
              />
            ) : null}
          </>
        ) : null}
        {tab === 'platform' ? (
          <PlatformRunTable
            entries={normalizePlatformRunEntries(platformEntries)}
            recentEntries={normalizePlatformRunEntries(recentPlatformEntries)}
            focusEntryId={platformFocusEntryId}
            emptyText="本次对话暂无平台操作。"
          />
        ) : null}
        {tab === 'debug' && obsEnabled ? (
          <SessionDebugPane threadId={threadId} isRunning={isRunning} />
        ) : null}
        {tab === 'task' ? task : null}
    </div>
  )
}

function formatElapsed(startedAt: number | undefined, now: number): string {
  if (!startedAt) return ''
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  if (min < 60) return `${min}m ${rem}s`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m`
}

function ProcessList({
  summary,
  onOpenItem,
  onStopItem,
}: {
  summary: ProcessSummary
  onOpenItem?: (item: ProcessItem) => void
  onStopItem?: (item: ProcessItem) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const hasRunning = summary.items.some((it) => it.state === 'running')
  useEffect(() => {
    if (!hasRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasRunning])

  if (!summary.items.length) {
    return <div className="chat-summary-empty">当前没有运行中的进程。</div>
  }
  return (
    <ul className="chat-summary-process-list">
      {summary.items.map((it) => {
        const StateIcon = PROCESS_STATE_ICON[it.state]
        const elapsed = it.state === 'running' ? formatElapsed(it.startedAt, now) : ''
        return (
          <li key={it.id} className="chat-summary-process-row">
            <button
              type="button"
              className={`chat-summary-process-item is-${it.state}`}
              title={`${it.label} · ${PROCESS_STATE_LABEL[it.state]}`}
              onClick={() => onOpenItem?.(it)}
            >
              <StateIcon className="chat-summary-process-icon" data-state={it.state} aria-hidden />
              <span className="chat-summary-process-main">
                <span className="chat-summary-process-label">{it.label}</span>
                <span className="chat-summary-process-detail">
                  {elapsed || it.detail || PROCESS_STATE_LABEL[it.state]}
                </span>
              </span>
            </button>
            {it.state === 'running' && it.cancellable && it.workId && onStopItem ? (
              <button
                type="button"
                className="chat-summary-process-stop"
                onClick={(e) => {
                  e.stopPropagation()
                  onStopItem(it)
                }}
              >
                停止
              </button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function ChatSummaryPanelInner({
  displayMode,
  onDisplayModeChange,
  isRunning,
  sessionTitle,
  terminalStreams,
  subagentTasks,
  workflowSubtasks,
  backgroundWorks,
  onOpenProcessItem,
  onStopProcessItem,
  agentLabel,
  modelLabel,
  modelName,
  agentCode,
  agentDescription,
  agent,
  skillNames = [],
  toolNames = null,
  mcpServers = null,
  knowledgeVaultIds = [],
  onPatchCapabilities,
  capabilityBusy = false,
  onSwitchAgent,
  onEditAgent,
  onAssetQuickAction,
  assetQuickBusy = false,
  artifacts = [],
  recentArtifacts = [],
  artifactFocusId = '',
  platformEntries = [],
  recentPlatformEntries = [],
  platformFocusEntryId = '',
  onOpenArtifact,
  onRevealArtifact,
  obsEnabled = false,
  threadId = '',
  isEmployeeSession = false,
  employeePane,
  taskPane,
}: Props) {
  const [policy, setPolicy] = useState<ChatSummaryExpandPolicy>('auto-expand')
  const [policyOpen, setPolicyOpen] = useState(false)
  const [panelTab, setPanelTab] = useState<PanelTab>('agent')
  const policyRef = useRef<HTMLDivElement | null>(null)
  const hydrated = useRef(false)

  // 展开策略在挂载时读一次偏好，之后由本组件持有并写回。
  // displayMode 由 ChatApp 侧 useState 初始化读同一份偏好，这里不再重复对齐。
  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true
    const prefs = loadChatSummaryPrefs()
    setPolicy(prefs.expandPolicy)
  }, [])

  // 点外部 / Esc 关掉策略菜单
  useEffect(() => {
    if (!policyOpen) return
    const onDown = (e: MouseEvent) => {
      if (!policyRef.current?.contains(e.target as Node)) setPolicyOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPolicyOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [policyOpen])

  const summary = useMemo(
    () =>
      buildProcessSummary({
        terminalStreams,
        subagentTasks,
        workflowSubtasks,
        backgroundWorks,
      }),
    [terminalStreams, subagentTasks, workflowSubtasks, backgroundWorks],
  )

  const pickPolicy = useCallback((next: ChatSummaryExpandPolicy) => {
    setPolicy(next)
    saveChatSummaryExpandPolicy(next)
    setUserCollapsed(false)
    setPolicyOpen(false)
  }, [])

  // 手动收起标记：auto-expand 策略下用户手动收起后，运行中不再强制撑开，
  // 直到新进程启动（running 0→>0）或用户手动展开才恢复自动展开语义。
  // 用 state 而非 ref：displayMode 已是 capsule 时点击收起，父级 setState 值不变
  // 不触发重渲染，必须靠本组件自身 state 变化驱动 effectiveMode 重算。
  // 初始跟 displayMode：收起后父级重挂气泡。
  // 若这里仍从 false 起步，auto-expand 会立刻把卡片又撑开。
  const [userCollapsed, setUserCollapsed] = useState(() => displayMode === 'capsule')
  const prevRunningRef = useRef(summary.running)

  const goPanel = useCallback(() => {
    setUserCollapsed(false)
    onDisplayModeChange('panel')
  }, [onDisplayModeChange])
  const goCapsule = useCallback(() => {
    setUserCollapsed(true)
    onDisplayModeChange('capsule')
  }, [onDisplayModeChange])

  // 新进程启动时清除手动收起标记，恢复 auto-expand 自动展开语义
  useEffect(() => {
    if (summary.running > 0 && prevRunningRef.current === 0) setUserCollapsed(false)
    prevRunningRef.current = summary.running
  }, [summary.running])

  // 实时跳转：平台条目 / 产物发布时（ChatApp 侧 publishPlatformEntries /
  // publishArtifacts 会更新 focus id），面板自动切到对应 tab 并撑开。
  const prevPlatformFocusRef = useRef('')
  useEffect(() => {
    const focus = String(platformFocusEntryId || '').trim()
    if (!focus || focus === prevPlatformFocusRef.current) return
    prevPlatformFocusRef.current = focus
    setPanelTab('platform')
    if (displayMode === 'capsule') goPanel()
  }, [platformFocusEntryId, displayMode, goPanel])

  const prevArtifactFocusRef = useRef('')
  useEffect(() => {
    const focus = String(artifactFocusId || '').trim()
    if (!focus || focus === prevArtifactFocusRef.current) return
    prevArtifactFocusRef.current = focus
    setPanelTab('artifacts')
    if (displayMode === 'capsule') goPanel()
  }, [artifactFocusId, displayMode, goPanel])

  // 展开策略：胶囊态 + 有进程在跑时自动撑成面板（用户手动收起后尊重选择）。
  // 仅会话 isRunning、尚无进程项时不撑开，避免「还没开终端」就弹出状态卡暗示终端调用。
  const effectiveMode = useMemo<ChatSummaryDisplayMode>(() => {
    if (displayMode === 'hidden') return 'hidden'
    if (displayMode === 'panel') return 'panel'
    if (policy === 'auto-expand' && !userCollapsed && summary.running > 0) return 'panel'
    return 'capsule'
  }, [displayMode, policy, userCollapsed, summary.running])

  // auto-expand 只改了 effectiveMode 时，通知父级切回 panel，
  // 以便右侧空白从气泡撑成悬浮卡（并让出专用侧栏）。
  useEffect(() => {
    if (displayMode !== 'capsule') return
    if (effectiveMode !== 'panel') return
    onDisplayModeChange('panel')
  }, [displayMode, effectiveMode, onDisplayModeChange])

  // 面板 tab：智能体/员工固定在最前，产物 / 平台带计数，
  // 任务仅在员工会话且 pane 存在时出现，调试仅在观测开启时出现。
  // 计数为 0 时不显示「0」：空 tab 条本身已经说明没有内容，
  // 再挂个「产物 0」只会让人以为是加载失败。
  const withCount = useCallback(
    (n: number, label: string) => (n > 0 ? `${label} ${n}` : label),
    [],
  )
  const visibleArtifacts = useMemo(
    () => artifacts.filter((it) => it.type !== 'platform'),
    [artifacts],
  )
  const panelTabs = useMemo<Array<{ id: PanelTab; label: string }>>(
    () => {
      const list: Array<{ id: PanelTab; label: string }> = [
        // 员工会话：首 tab 用 EmployeePane（身份 + 职责），不再另挂「岗位」
        { id: 'agent', label: isEmployeeSession ? '员工' : '智能体' },
        { id: 'process', label: withCount(summary.items.length, '进程') },
        { id: 'artifacts', label: withCount(visibleArtifacts.length, '产物') },
        { id: 'platform', label: withCount(platformEntries.length, '平台') },
      ]
      if (isEmployeeSession && taskPane) {
        list.splice(4, 0, { id: 'task', label: '任务' })
      }
      if (obsEnabled) list.push({ id: 'debug', label: '调试' })
      return list
    },
    [withCount, summary.items.length, visibleArtifacts, platformEntries, isEmployeeSession, taskPane, obsEnabled],
  )

  // tab 失效时回落：观测关闭 / 员工会话切走 / 旧「岗位」tab → 员工身份卡。
  // 不用 effect 打 setState（会级联渲染），渲染期直接派生生效 tab。
  const effectivePanelTab: PanelTab = useMemo(() => {
    if (panelTab === 'debug' && !obsEnabled) return 'agent'
    // 旧「岗位」已并入员工身份卡
    if (panelTab === 'employee') return 'agent'
    if (panelTab === 'task' && !isEmployeeSession) return 'agent'
    return panelTab
  }, [panelTab, obsEnabled, isEmployeeSession])

  // 悬浮卡展开：先挂卡片 DOM（缩放起点），再下一帧加 is-open；
  // 收起：先去掉 is-open 播完缩放，再换成气泡。
  const wantExpanded = effectiveMode === 'panel'
  const [cardOpen, setCardOpen] = useState(() => wantExpanded)
  const [showBubble, setShowBubble] = useState(() => !wantExpanded)
  const closeTimerRef = useRef(0)
  const expandRafRef = useRef(0)

  useEffect(() => {
    if (effectiveMode === 'hidden') return
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = 0
    }
    if (expandRafRef.current) {
      cancelAnimationFrame(expandRafRef.current)
      expandRafRef.current = 0
    }
    if (wantExpanded) {
      setShowBubble(false)
      let cancelled = false
      expandRafRef.current = requestAnimationFrame(() => {
        expandRafRef.current = requestAnimationFrame(() => {
          if (!cancelled) setCardOpen(true)
          expandRafRef.current = 0
        })
      })
      return () => {
        cancelled = true
        if (expandRafRef.current) cancelAnimationFrame(expandRafRef.current)
      }
    }
    setCardOpen(false)
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    closeTimerRef.current = window.setTimeout(
      () => {
        setShowBubble(true)
        closeTimerRef.current = 0
      },
      reduce ? 0 : 240,
    )
    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    }
  }, [wantExpanded, effectiveMode])

  if (effectiveMode === 'hidden') return null

  const displayName =
    String(agentLabel || '').trim() || (isEmployeeSession ? '未选择员工' : '未选择 Agent')
  const editTitle = isEmployeeSession ? '点击编辑此员工' : '点击编辑此智能体'
  // 员工会话固定当前岗位，不提供切换入口（避免误当成选其他员工）
  const canSwitchAgent = Boolean(onSwitchAgent) && !isEmployeeSession
  const bio = String(agentDescription || '').trim()
  const modelText = String(modelLabel || modelName || '').trim()
  const sessionTitleText = String(sessionTitle || '').trim()
  const bubbleTitle = summary.items.length ? summary.capsuleLabel : sessionTitleText || '状态'

  const CapsuleIcon =
    summary.capsuleState === 'running'
      ? CircleDashed
      : summary.capsuleState === 'failed'
        ? TriangleAlert
        : CircleCheck

  return (
    <aside
      className={`chat-summary-float${cardOpen ? ' is-open' : ''}${showBubble ? ' is-bubble' : ''}`}
      data-testid="chat-summary-panel"
      data-state={showBubble ? 'capsule' : 'panel'}
      data-display-mode={effectiveMode}
      data-running-count={summary.running}
      aria-label="状态"
    >
      {showBubble ? (
        <button
          type="button"
          className="chat-summary-bubble"
          data-state={summary.capsuleState}
          aria-label="展开状态面板"
          title={bubbleTitle}
          onClick={goPanel}
        >
          <CapsuleIcon aria-hidden />
        </button>
      ) : (
        <div className="chat-summary-panel is-panel">
          <div className="chat-summary-panel-head">
            <div className="chat-summary-more-tabs" role="tablist" aria-label="状态面板">
              {panelTabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={effectivePanelTab === t.id}
                  className={`chat-summary-more-tab${effectivePanelTab === t.id ? ' is-active' : ''}`}
                  onClick={() => setPanelTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="chat-summary-panel-head-actions">
              <div ref={policyRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="chat-summary-panel-icon-btn"
                  aria-label="状态面板展开策略"
                  aria-haspopup="menu"
                  aria-expanded={policyOpen}
                  onClick={() => setPolicyOpen((v) => !v)}
                >
                  <Ellipsis aria-hidden />
                </button>
                {policyOpen ? (
                  <div className="chat-summary-policy-menu" role="menu" aria-label="展开策略">
                    {EXPAND_POLICY_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        role="menuitem"
                        className="chat-summary-policy-item"
                        onClick={() => pickPolicy(opt.id)}
                      >
                        {opt.label}
                        {policy === opt.id ? <Check className="chat-summary-policy-check" aria-hidden /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="chat-summary-panel-icon-btn"
                data-summary-action="collapse"
                aria-label="收起"
                onClick={goCapsule}
              >
                <Minimize2 aria-hidden />
              </button>
            </div>
          </div>

          <div className="chat-summary-panel-scroll">
            {effectivePanelTab === 'agent' ? (
              isEmployeeSession && employeePane ? (
                <div className="chat-summary-agent-body chat-summary-employee-body">
                  {employeePane}
                </div>
              ) : (
                <div className="chat-summary-agent-body">
                  <div
                    className={`chat-summary-agent-header${onEditAgent ? ' is-editable' : ''}`}
                    role={onEditAgent ? 'button' : undefined}
                    tabIndex={onEditAgent ? 0 : undefined}
                    title={onEditAgent ? editTitle : undefined}
                    onClick={onEditAgent}
                    onKeyDown={
                      onEditAgent
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              onEditAgent()
                            }
                          }
                        : undefined
                    }
                  >
                    <span className="chat-summary-agent-portrait">
                      <AgentAvatar
                        agent={agent}
                        agentCode={agentCode || undefined}
                        size={40}
                        title={displayName}
                      />
                      <span className="chat-summary-agent-live" title={isRunning ? '执行中' : '在线'} />
                    </span>
                    <span className="chat-summary-agent-main">
                      <span className="chat-summary-agent-name-row">
                        <span className="chat-summary-agent-name" title={displayName}>
                          {displayName}
                        </span>
                        {onEditAgent ? (
                          <button
                            type="button"
                            className="chat-summary-panel-icon-btn chat-summary-agent-edit-btn"
                            aria-label={editTitle}
                            title={editTitle}
                            onClick={(e) => {
                              e.stopPropagation()
                              onEditAgent()
                            }}
                          >
                            <Pencil aria-hidden />
                          </button>
                        ) : null}
                        {canSwitchAgent ? (
                          <button
                            type="button"
                            className="chat-summary-panel-icon-btn"
                            aria-label="切换 Agent"
                            title="切换 Agent"
                            onClick={(e) => {
                              e.stopPropagation()
                              onSwitchAgent?.()
                            }}
                            style={{ width: 20, height: 20 }}
                          >
                            <ChevronRight aria-hidden />
                          </button>
                        ) : null}
                      </span>
                      {modelText ? (
                        <span className="chat-summary-agent-meta" title={modelText}>
                          {modelText}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {bio ? (
                    <p className="chat-summary-agent-bio" title={bio}>
                      {bio}
                    </p>
                  ) : null}
                  <AgentCapabilityTabs
                    skillNames={skillNames}
                    toolNames={toolNames}
                    mcpServers={mcpServers}
                    knowledgeVaultIds={knowledgeVaultIds}
                    modelName={String(modelName || modelText)}
                    editable={Boolean(onPatchCapabilities && agentCode)}
                    busy={capabilityBusy}
                    onPatch={onPatchCapabilities}
                  />
                  {onAssetQuickAction ? (
                    <AssetQuickActions onAction={onAssetQuickAction} busy={assetQuickBusy} />
                  ) : null}
                </div>
              )
            ) : null}

            {effectivePanelTab === 'process' ? (
              <div className="chat-summary-process-body">
                <ProcessList
                  summary={summary}
                  onOpenItem={onOpenProcessItem}
                  onStopItem={onStopProcessItem}
                />
              </div>
            ) : null}

            {effectivePanelTab !== 'agent' && effectivePanelTab !== 'process' ? (
              <MorePane
                tab={effectivePanelTab}
                artifacts={artifacts}
                recentArtifacts={recentArtifacts}
                artifactFocusId={artifactFocusId}
                platformEntries={platformEntries}
                recentPlatformEntries={recentPlatformEntries}
                platformFocusEntryId={platformFocusEntryId}
                onOpenArtifact={onOpenArtifact}
                onRevealArtifact={onRevealArtifact}
                obsEnabled={obsEnabled}
                threadId={threadId}
                isRunning={isRunning}
                task={taskPane}
              />
            ) : null}
          </div>
        </div>
      )}
    </aside>
  )
}

export const ChatSummaryPanel = memo(ChatSummaryPanelInner)

/**
 * 状态面板（对齐 ZCode 形态）
 *
 * 三态：hidden（不渲染） / capsule（右下胶囊浮层） / panel（右栏一条）。
 * 两区：
 * - 进程：terminal + 子智能体 + 协作子任务 聚合成一条有序列表
 * - 智能体：复用 AgentCapabilityTabs（技能 / 工具 / MCP / 知识库）
 * - 更多：折叠收纳产物 / 平台 / 调试（保留旧侧栏能力，不丢功能）
 *
 * 不做「计划」区：计划确认条仍在输入区上方（PlanExecConfirm）。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Ellipsis,
  Maximize2,
  Minimize2,
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
  formatCompactCount,
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
  DEFAULT_CHAT_SUMMARY_SECTIONS,
  loadChatSummaryPrefs,
  saveChatSummaryExpandPolicy,
  saveChatSummarySections,
  type ChatSummaryDisplayMode,
  type ChatSummaryExpandPolicy,
  type ChatSummarySectionId,
} from '../lib/chat-summary-panel-prefs.js'
import type { ContextUsageSnapshot } from '../lib/context-usage.js'
import type { CollabSubtaskSnapshot, SubagentStreamTask, TerminalStreamTask, TokenTotals } from '../chat-types.js'
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
  onOpenProcessItem?: (item: ProcessItem) => void

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
  tokenTotals?: TokenTotals | null
  contextUsage?: ContextUsageSnapshot | null
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

  /** 更多区：员工会话的岗位 / 任务（复用旧侧栏 Pane） */
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
  { id: 'sticky-collapsed', label: '保持收起为胶囊' },
]

function sectionIdOf(name: ChatSummarySectionId): string {
  return `chat-summary-${name}`
}

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

/** 「更多」分区头计数：只报有内容的项数，不复述 tab 名 */
function MoreCount({
  artifacts,
  platformEntries,
}: {
  artifacts: ChatArtifact[]
  platformEntries: PlatformRunEntry[]
}) {
  const n = artifacts.length + platformEntries.length
  if (n === 0) return null
  return (
    <div className="chat-summary-section-meta">
      <span className="chat-summary-section-count">{n}</span>
    </div>
  )
}

function MorePane({
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
  isEmployeeSession = false,
  employee,
  task,
}: {
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
  isEmployeeSession?: boolean
  employee?: ReactNode
  task?: ReactNode
}) {
  type MoreTab = 'artifacts' | 'platform' | 'debug' | 'employee' | 'task'
  const [tab, setTab] = useState<MoreTab>('artifacts')

  // 观测关闭 / 切走员工会话时，若停在失效 tab 则回落，避免空白面板
  useEffect(() => {
    if (tab === 'debug' && !obsEnabled) setTab('artifacts')
    if ((tab === 'employee' || tab === 'task') && !isEmployeeSession) setTab('artifacts')
  }, [obsEnabled, tab, isEmployeeSession])

  const visibleArtifacts = useMemo(
    () => artifacts.filter((it) => it.type !== 'platform'),
    [artifacts],
  )

  // 沿用旧侧栏的三段分组（最新 / 当前轮次 / 已有），别把结构信息压平
  const grouped = useMemo(
    () => partitionArtifacts(artifacts, recentArtifacts, artifactFocusId),
    [artifacts, recentArtifacts, artifactFocusId],
  )
  const latestId = grouped.latestId

  const tabs = useMemo(() => {
    // 计数为 0 时不显示「0」：空 tab 条本身已经说明没有内容，
    // 再挂个「产物 0」只会让人以为是加载失败。
    const withCount = (n: number, label: string) => (n > 0 ? `${label} ${n}` : label)
    const list: Array<{ id: MoreTab; label: string }> = [
      { id: 'artifacts', label: withCount(visibleArtifacts.length, '产物') },
      { id: 'platform', label: withCount(platformEntries.length, '平台') },
    ]
    if (isEmployeeSession) {
      if (employee) list.splice(1, 0, { id: 'employee', label: '岗位' })
      if (task) list.splice(1, 0, { id: 'task', label: '任务' })
    }
    if (obsEnabled) list.push({ id: 'debug', label: '调试' })
    return list
  }, [visibleArtifacts.length, platformEntries.length, isEmployeeSession, employee, task, obsEnabled])

  return (
    <>
      <div className="chat-summary-more-tabs" role="tablist" aria-label="更多">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`chat-summary-more-tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
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
        {tab === 'employee' ? employee : null}
        {tab === 'task' ? task : null}
      </div>
    </>
  )
}

function Section({
  id,
  title,
  open,
  onToggle,
  meta,
  children,
}: {
  id: ChatSummarySectionId
  title: string
  open: boolean
  onToggle: () => void
  meta?: ReactNode
  children: ReactNode
}) {
  const contentId = sectionIdOf(id)
  const Icon = open ? ChevronDown : ChevronRight
  return (
    <section className={`chat-summary-section${open ? ' is-open' : ''}`} data-summary-section={id}>
      <div className="chat-summary-section-head">
        <button
          type="button"
          className="chat-summary-section-trigger"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={onToggle}
        >
          <span className="chat-summary-section-title">{title}</span>
          <Icon className="chat-summary-section-chevron" aria-hidden />
        </button>
        {meta}
      </div>
      <div
        id={contentId}
        className="chat-summary-section-content"
        // 收起时保留子树：grid 0fr 折叠动画需要真实高度可测量
        aria-hidden={!open}
      >
        <div>
          <div className="chat-summary-section-scroll">{children}</div>
        </div>
      </div>
    </section>
  )
}

/** 分区头计数：5/5 · 进行中 · 失败 */
function ProcessCount({ summary }: { summary: ProcessSummary }) {
  if (!summary.items.length) return null
  return (
    <div className="chat-summary-section-meta" aria-live="polite">
      <span className="chat-summary-section-count">
        {summary.completed}/{summary.total}
      </span>
      {summary.running > 0 ? <span>{summary.running} 进行中</span> : null}
      {summary.failed > 0 ? (
        <span style={{ color: 'var(--ef-color-error, #c94a4a)' }}>{summary.failed} 失败</span>
      ) : null}
    </div>
  )
}

function ProcessList({
  summary,
  onOpenItem,
}: {
  summary: ProcessSummary
  onOpenItem?: (item: ProcessItem) => void
}) {
  if (!summary.items.length) {
    return <div className="chat-summary-empty">当前没有运行中的进程。</div>
  }
  return (
    <ul className="chat-summary-process-list">
      {summary.items.map((it) => {
        const StateIcon = PROCESS_STATE_ICON[it.state]
        return (
          <li key={it.id}>
            <button
              type="button"
              className={`chat-summary-process-item is-${it.state}`}
              title={`${it.label} · ${PROCESS_STATE_LABEL[it.state]}`}
              onClick={() => onOpenItem?.(it)}
            >
              <StateIcon className="chat-summary-process-icon" data-state={it.state} aria-hidden />
              <span className="chat-summary-process-main">
                <span className="chat-summary-process-label">{it.label}</span>
                {it.detail ? <span className="chat-summary-process-detail">{it.detail}</span> : null}
              </span>
            </button>
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
  onOpenProcessItem,
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
  tokenTotals = null,
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
  const [sections, setSections] = useState(DEFAULT_CHAT_SUMMARY_SECTIONS)
  const policyRef = useRef<HTMLDivElement | null>(null)
  const hydrated = useRef(false)

  // 分区展开态 / 展开策略在挂载时读一次偏好，之后由本组件持有并写回。
  // displayMode 由 ChatApp 侧 useState 初始化读同一份偏好，这里不再重复对齐。
  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true
    const prefs = loadChatSummaryPrefs()
    setPolicy(prefs.expandPolicy)
    setSections(prefs.sections)
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
      }),
    [terminalStreams, subagentTasks, workflowSubtasks],
  )

  const hasMoreContent =
    artifacts.length > 0 ||
    platformEntries.length > 0 ||
    Boolean(obsEnabled) ||
    Boolean(employeePane) ||
    Boolean(taskPane)

  const toggleSection = useCallback((id: ChatSummarySectionId) => {
    setSections((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      saveChatSummarySections(next)
      return next
    })
  }, [])

  const pickPolicy = useCallback((next: ChatSummaryExpandPolicy) => {
    setPolicy(next)
    saveChatSummaryExpandPolicy(next)
    setPolicyOpen(false)
  }, [])

  // 展开策略：胶囊态 + 有进程在跑时自动撑成面板
  const effectiveMode = useMemo<ChatSummaryDisplayMode>(() => {
    if (displayMode === 'hidden') return 'hidden'
    if (displayMode === 'panel') return 'panel'
    if (policy === 'auto-expand' && (summary.running > 0 || isRunning)) return 'panel'
    return 'capsule'
  }, [displayMode, policy, summary.running, isRunning])

  const goPanel = useCallback(() => onDisplayModeChange('panel'), [onDisplayModeChange])
  const goCapsule = useCallback(() => onDisplayModeChange('capsule'), [onDisplayModeChange])

  if (effectiveMode === 'hidden') return null

  const isCapsule = effectiveMode === 'capsule'
  const displayName = String(agentLabel || '').trim() || '未选择 Agent'
  const bio = String(agentDescription || '').trim()
  const tokenTotal = Number(tokenTotals?.total || 0)
  const modelText = String(modelLabel || modelName || '').trim()
  const sessionTitleText = String(sessionTitle || '').trim()

  // 胶囊摘要：没有进程时退到会话标题，避免出现无意义的「空闲」
  const capsuleText = summary.items.length ? summary.capsuleLabel : sessionTitleText || '空闲'

  const CapsuleIcon =
    summary.capsuleState === 'running'
      ? CircleDashed
      : summary.capsuleState === 'failed'
        ? TriangleAlert
        : CircleCheck

  return (
    <aside
      className={`chat-summary-panel ${isCapsule ? 'is-capsule' : 'is-panel'}`}
      data-testid="chat-summary-panel"
      data-state={isCapsule ? 'capsule' : 'panel'}
      data-display-mode={effectiveMode}
      data-running-count={summary.running}
      aria-label="状态"
    >
      {isCapsule ? (
        <div className="chat-summary-capsule-hit-wrap">
          <button
            type="button"
            className="chat-summary-capsule-hit"
            aria-label="展开状态"
            onClick={goPanel}
          >
            <span className="chat-summary-capsule-icon" aria-hidden>
              <CapsuleIcon
                style={{ color: 'var(--ef-color-success, #26875a)' }}
              />
              <Maximize2 style={{ color: 'var(--text-primary)' }} />
            </span>
            <span className="chat-summary-capsule-label">{capsuleText}</span>
          </button>
        </div>
      ) : (
        <>
          <div className="chat-summary-panel-head">
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
              aria-label="收起为胶囊"
              onClick={goCapsule}
            >
              <Minimize2 aria-hidden />
            </button>
          </div>

          <div className="chat-summary-panel-scroll">
            <Section
              id="process"
              title="进程"
              open={sections.process}
              onToggle={() => toggleSection('process')}
              meta={<ProcessCount summary={summary} />}
            >
              <ProcessList summary={summary} onOpenItem={onOpenProcessItem} />
            </Section>

            <Section
              id="agent"
              title="智能体"
              open={sections.agent}
              onToggle={() => toggleSection('agent')}
              meta={
                <div className="chat-summary-section-meta">
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {displayName}
                  </span>
                </div>
              }
            >
              <div
                className={`chat-summary-agent-header${onEditAgent ? ' is-editable' : ''}`}
                role={onEditAgent ? 'button' : undefined}
                tabIndex={onEditAgent ? 0 : undefined}
                title={onEditAgent ? '点击编辑此智能体' : undefined}
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
                    {onSwitchAgent ? (
                      <button
                        type="button"
                        className="chat-summary-panel-icon-btn"
                        aria-label="切换 Agent"
                        title="切换 Agent"
                        onClick={onSwitchAgent}
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
              {tokenTotal > 0 ? (
                <div className="chat-summary-empty">
                  本轮 Token {formatCompactCount(tokenTotal)}
                </div>
              ) : null}
            </Section>

            {hasMoreContent ? (
              <Section
                id="more"
                title="更多"
                open={sections.more}
                onToggle={() => toggleSection('more')}
                // meta 不再复述 tab 名（产物 N / 平台 N / 调试），那正是下面 tab 条的内容，
                // 重复一遍会让人以为坏了两套导航。这里只报「有内容的项数」。
                meta={<MoreCount artifacts={artifacts} platformEntries={platformEntries} />}
              >
                <MorePane
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
                  isEmployeeSession={isEmployeeSession}
                  employee={employeePane}
                  task={taskPane}
                />
              </Section>
            ) : null}
          </div>
        </>
      )}
    </aside>
  )
}

export const ChatSummaryPanel = memo(ChatSummaryPanelInner)

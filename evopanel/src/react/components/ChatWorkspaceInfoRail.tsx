import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ContextUsageSnapshot } from '../lib/context-usage.js'
import type { CollabTaskSnapshot, TokenTotals } from '../chat-types.js'
import AgentAvatar from './AgentAvatar.js'
import type { AgentAvatarAgent } from '../lib/agent-avatar.js'
import { ContextOccupancyPanel } from './ContextOccupancyPanel.js'
import {
  ArtifactContextMenuPortal,
  type ArtifactContextMenuState,
} from './ArtifactContextMenuPortal.js'
import {
  chatArtifactDisplayLabel,
  type ChatArtifact,
} from '../lib/chat-artifact.js'
import {
  artifactTimestampMs,
  formatCompactCount,
  formatDutyRoundClock,
  formatInfoRailTime,
  inferEmployeeTaskKind,
  infoRailScopeLabel,
  proactiveBusySessionHint,
  shortenTaskId,
  type InfoRailScope,
} from '../lib/info-rail-format.js'
import {
  AgentCapabilityTabs,
  type AgentCapabilityPatch,
} from './AgentCapabilityTabs.js'
import { PlatformRunTable } from './PlatformRunTable.js'
import { SessionDebugPane } from './SessionDebugPane.js'
import {
  normalizePlatformRunEntries,
  type PlatformRunEntry,
} from '../../lib/right-stage/platform-feedback.js'
import { parseProactiveSessionKey } from '../lib/session-list/workspace-groups.js'
import {
  boardTaskId,
  listSessionBoardTasks,
  pickBoardTask,
  resolveOverlayLiveTask,
  taskSourceLabel,
  type EmployeeBoardTask,
} from '../lib/employee-current-task.js'

/** 普通对话：Agent / 产物 / 调试 / 平台；员工对话：员工(岗位) / 任务 / 产物 / 运行 / 调试 / 平台 */
export type InfoRailTab = 'artifacts' | 'context' | 'agent' | 'task' | 'run' | 'employee' | 'platform' | 'debug'

export type EmployeeRailInfo = {
  agentCode: string
  roleName: string
  department?: string
  status?: string
  responsibilities?: string[]
  workspacePath?: string
  modelName?: string
  autonomyLabel?: string
  thinkModeLabel?: string
  knowledgeVaultIds?: string[]
}

/** @deprecated prefer ChatArtifact */
export type ArtifactListItem = {
  id: string
  label: string
  kind?: string
}

type Props = {
  tab: InfoRailTab
  isEmployeeSession?: boolean
  sessionTitle: string
  isRunning: boolean
  contextUsage: ContextUsageSnapshot | null
  tokenTotals: TokenTotals | null
  agentLabel: string
  modelLabel: string
  agentCode?: string
  agentDescription?: string
  agent?: AgentAvatarAgent | null
  skillCount?: number
  toolCount?: number
  skillNames?: string[]
  /** null = 全部工具；[] = 未连接 */
  toolNames?: string[] | null
  /** null = 全部 MCP；[] = 未连接 */
  mcpServers?: string[] | null
  knowledgeVaultIds?: string[]
  onPatchCapabilities?: (patch: AgentCapabilityPatch) => Promise<void>
  capabilityBusy?: boolean
  modelName?: string
  artifacts?: ChatArtifact[]
  recentArtifacts?: ChatArtifact[]
  artifactFocusId?: string
  platformEntries?: PlatformRunEntry[]
  recentPlatformEntries?: PlatformRunEntry[]
  platformFocusEntryId?: string
  onOpenArtifact?: (item: ChatArtifact) => void
  onRevealArtifact?: (item: ChatArtifact) => void
  onTabChange?: (tab: InfoRailTab) => void
  onSwitchAgent?: () => void
  /** 打开当前 Agent 编辑器；保存后由 ChatApp 刷新列表 */
  onEditAgent?: () => void
  onManualCompact?: () => void
  manualCompactDisabled?: boolean
  onClose?: () => void
  /** 资产沉淀：记录过程 / 沉淀经验 / 反思（侧栏上下文下方） */
  onAssetQuickAction?: (kind: 'episode' | 'craft' | 'journal') => void
  assetQuickBusy?: boolean
  /** 员工会话：岗位详情 */
  employeeInfo?: EmployeeRailInfo | null
  /** 当前会话 key（解析 taskId / kind） */
  sessionKey?: string
  /** 协作侧栏里已有的主任务快照（优先于 work-board 轮询） */
  liveTask?: CollabTaskSnapshot | null
  /** 运维观测已开启时展示调试 Tab */
  obsEnabled?: boolean
  /** 当前会话 LangGraph thread_id */
  threadId?: string
}

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="react-chat-info-rail-row">
      <span className="react-chat-info-rail-row-label">{label}</span>
      <span
        className="react-chat-info-rail-row-value"
        title={title || value}
      >
        {value}
      </span>
    </div>
  )
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="react-chat-info-rail-empty">{children}</div>
}

function AssetQuickActions({
  onAction,
  busy = false,
}: {
  onAction: (kind: 'episode' | 'craft' | 'journal') => void
  busy?: boolean
}) {
  return (
    <section className="react-chat-asset-quick" aria-label="资产沉淀">
      <div className="react-chat-asset-quick-label">资产沉淀</div>
      <div className="react-chat-asset-quick-actions">
        <button
          type="button"
          className="react-chat-asset-quick-btn"
          disabled={busy}
          title="把当前对话过程记下来，方便以后回顾"
          onClick={() => onAction('episode')}
        >
          记录过程
        </button>
        <button
          type="button"
          className="react-chat-asset-quick-btn"
          disabled={busy}
          title="让 Agent 根据对话沉淀经验"
          onClick={() => onAction('craft')}
        >
          沉淀经验
        </button>
        <button
          type="button"
          className="react-chat-asset-quick-btn"
          disabled={busy}
          title="让 Agent 根据对话写反思"
          onClick={() => onAction('journal')}
        >
          反思
        </button>
      </div>
      <a className="react-chat-asset-quick-link" href="#/assets" title="打开资产中心">
        查看资产中心 →
      </a>
    </section>
  )
}

function typeGlyph(type?: string): string {
  const t = String(type || '').toLowerCase()
  if (t === 'image') return '🖼'
  if (t === 'video') return '🎬'
  if (t === 'url') return '🔗'
  if (t === 'html') return '🌐'
  if (t === 'text') return '📝'
  return '📄'
}

function ArtifactList({
  items,
  focusArtifactId = '',
  recentIds = new Set<string>(),
  latestId = '',
  onOpenArtifact,
  onRevealArtifact: _onRevealArtifact,
  onMenu,
}: {
  items: ChatArtifact[]
  focusArtifactId?: string
  recentIds?: Set<string>
  latestId?: string
  onOpenArtifact?: (item: ChatArtifact) => void
  onRevealArtifact?: (item: ChatArtifact) => void
  onMenu: (menu: ArtifactContextMenuState) => void
}) {
  return (
    <ul className="react-chat-info-rail-artifact-list">
      {items.map((it) => {
        const label = chatArtifactDisplayLabel(it)
        const meta = it.url && !it.path ? it.url : it.path || it.type
        const active = focusArtifactId && focusArtifactId === it.id
        const timeStr = formatInfoRailTime(it.updatedAt || it.createdAt)
        const isLatest = latestId && latestId === it.id
        const isTurn = recentIds.has(it.id)
        const scope: InfoRailScope = isLatest ? 'latest' : isTurn ? 'turn' : 'existing'
        const titleParts = [meta, timeStr ? `时间 ${timeStr}` : '', infoRailScopeLabel(scope)].filter(Boolean)
        return (
          <li key={it.id} className={`react-chat-info-rail-artifact-item${active ? ' is-active' : ''}`}>
            <button
              type="button"
              className="react-chat-info-rail-artifact-btn"
              title={titleParts.join(' · ')}
              onClick={() => onOpenArtifact?.(it)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onMenu({ item: it, x: e.clientX, y: e.clientY })
              }}
            >
              <span className="react-chat-info-rail-artifact-glyph" aria-hidden>
                {typeGlyph(it.type)}
              </span>
              <span className="react-chat-info-rail-artifact-main">
                <span className="react-chat-info-rail-artifact-label">{label}</span>
                <span className="react-chat-info-rail-artifact-meta">
                  {timeStr ? (
                    <span className="react-chat-info-rail-artifact-time">{timeStr}</span>
                  ) : (
                    <span className="react-chat-info-rail-artifact-time is-empty">—</span>
                  )}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function partitionArtifacts(items: ChatArtifact[], recentItems: ChatArtifact[], focusArtifactId: string) {
  const all = items.filter((it) => it.type !== 'platform')
  const recent = recentItems.filter((it) => it.type !== 'platform')
  const recentIds = new Set(recent.map((it) => it.id))

  let latestId = String(focusArtifactId || '').trim()
  if (!latestId && all.length) {
    let bestMs = -1
    for (const it of all) {
      const ms = artifactTimestampMs(it)
      if (ms >= bestMs) {
        bestMs = ms
        latestId = it.id
      }
    }
    if (bestMs <= 0) latestId = all[all.length - 1]?.id || ''
  }

  // 最新产物单独置顶展示后，就不再重复出现在「当前轮次 / 已有产物」分区
  const existing = all.filter((it) => it.id !== latestId && !recentIds.has(it.id))
  const turnItems = recent.filter((it) => it.id !== latestId)
  const latestItem = latestId ? all.find((it) => it.id === latestId) || null : null

  return { all, recentIds, existing, turnItems, latestItem, latestId }
}

function ArtifactsPane({
  items,
  recentItems = [],
  focusArtifactId = '',
  onOpenArtifact,
  onRevealArtifact,
}: {
  items: ChatArtifact[]
  recentItems?: ChatArtifact[]
  focusArtifactId?: string
  onOpenArtifact?: (item: ChatArtifact) => void
  onRevealArtifact?: (item: ChatArtifact) => void
}) {
  const [menu, setMenu] = useState<ArtifactContextMenuState | null>(null)

  if (!items.length) {
    return <EmptyHint>本次对话暂无产物。Agent 交付时会出现在这里。</EmptyHint>
  }

  const openUrl = (item: ChatArtifact) => {
    const url = String(item.url || '').trim()
    if (!url) return
    try {
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      /* ignore */
    }
  }

  const { all, recentIds, existing, turnItems, latestItem, latestId } = partitionArtifacts(
    items,
    recentItems,
    focusArtifactId,
  )

  const renderList = (listItems: ChatArtifact[]) => (
    <ArtifactList
      items={listItems}
      focusArtifactId={focusArtifactId}
      recentIds={recentIds}
      latestId={latestId}
      onOpenArtifact={onOpenArtifact}
      onRevealArtifact={onRevealArtifact}
      onMenu={setMenu}
    />
  )

  return (
    <>
      {latestItem ? (
        <>
          <div className="react-chat-info-rail-subsection-label">最新产物</div>
          {renderList([latestItem])}
        </>
      ) : null}
      {turnItems.length > 0 ? (
        <>
          <div className="react-chat-info-rail-subsection-label">当前轮次</div>
          {renderList(turnItems)}
        </>
      ) : null}
      {existing.length > 0 ? (
        <>
          <div className="react-chat-info-rail-subsection-label">已有产物</div>
          {renderList(existing)}
        </>
      ) : null}
      {!latestItem && turnItems.length === 0 && existing.length === 0 && all.length > 0
        ? renderList(all)
        : null}
      <ArtifactContextMenuPortal
        menu={menu}
        onClose={() => setMenu(null)}
        onOpen={onOpenArtifact}
        onReveal={onRevealArtifact}
        onOpenUrl={openUrl}
      />
    </>
  )
}

function AgentPane({
  agentLabel,
  modelLabel,
  modelName,
  agentCode,
  agentDescription,
  agent,
  skillNames,
  toolNames,
  mcpServers = null,
  knowledgeVaultIds = [],
  onSwitchAgent,
  onEditAgent,
  onPatchCapabilities,
  capabilityBusy = false,
  contextUsage = null,
  tokenTotals = null,
  onManualCompact,
  manualCompactDisabled = false,
  onAssetQuickAction,
  assetQuickBusy = false,
}: {
  agentLabel: string
  modelLabel: string
  modelName?: string
  agentCode?: string
  agentDescription?: string
  agent?: AgentAvatarAgent | null
  skillNames: string[]
  toolNames?: string[] | null
  mcpServers?: string[] | null
  knowledgeVaultIds?: string[]
  onSwitchAgent?: () => void
  onEditAgent?: () => void
  onPatchCapabilities?: (patch: AgentCapabilityPatch) => Promise<void>
  capabilityBusy?: boolean
  contextUsage?: ContextUsageSnapshot | null
  tokenTotals?: TokenTotals | null
  onManualCompact?: () => void
  manualCompactDisabled?: boolean
  onAssetQuickAction?: (kind: 'episode' | 'craft' | 'journal') => void
  assetQuickBusy?: boolean
}) {
  const displayName = String(agentLabel || '').trim() || '未选择 Agent'
  const bio = String(agentDescription || '').trim()
  const code = String(agentCode || '').trim()
  const tokenizerModel = String(modelName || modelLabel || '').trim()

  return (
    <div className="react-chat-agent-pane">
      <header className="react-chat-agent-profile">
        <div
          className={`react-chat-agent-profile-top${onEditAgent ? ' is-editable' : ''}`}
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
          <div className="react-chat-agent-profile-portrait">
            <AgentAvatar
              agent={agent}
              agentCode={code || undefined}
              size={44}
              className="react-chat-agent-profile-avatar"
              title={onEditAgent ? '点击编辑此智能体' : displayName}
            />
            <span className="react-chat-agent-profile-live is-online" title="在线" aria-hidden />
          </div>
          <div className="react-chat-agent-profile-main">
            <div className="react-chat-agent-profile-name-row">
              <h2 className="react-chat-agent-profile-name" title={displayName}>
                {displayName}
              </h2>
              {onSwitchAgent ? (
                <button
                  type="button"
                  className="react-chat-agent-switch"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSwitchAgent()
                  }}
                  aria-label="切换 Agent"
                  title="切换 Agent"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M3.5 5.5h7.2M8.2 3l2.5 2.5L8.2 8M12.5 10.5H5.3M7.8 8l-2.5 2.5L7.8 13"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ) : null}
            </div>
            {modelLabel ? (
              <div className="react-chat-agent-profile-meta" title={modelLabel}>
                {modelLabel}
              </div>
            ) : null}
          </div>
        </div>
        {bio ? (
          <p
            className={`react-chat-agent-profile-bio${onEditAgent ? ' is-editable' : ''}`}
            title={onEditAgent ? '点击编辑此智能体' : bio}
            role={onEditAgent ? 'button' : undefined}
            tabIndex={onEditAgent ? 0 : undefined}
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
            {bio}
          </p>
        ) : null}
      </header>

      <AgentCapabilityTabs
        skillNames={skillNames}
        toolNames={toolNames}
        mcpServers={mcpServers}
        knowledgeVaultIds={knowledgeVaultIds}
        modelName={tokenizerModel}
        editable={Boolean(onPatchCapabilities && code)}
        busy={capabilityBusy}
        onPatch={onPatchCapabilities}
      />

      <section className="react-chat-agent-context" aria-label="上下文占用">
        <ContextOccupancyPanel
          usage={contextUsage}
          tokenTotals={tokenTotals}
          onManualCompact={onManualCompact}
          manualCompactDisabled={manualCompactDisabled}
        />
      </section>

      {onAssetQuickAction ? (
        <AssetQuickActions onAction={onAssetQuickAction} busy={assetQuickBusy} />
      ) : null}
    </div>
  )
}

const TASK_STATUS_ZH: Record<string, string> = {
  executing: '执行中',
  in_progress: '执行中',
  running: '执行中',
  active: '执行中',
  pending: '待开始',
  proposed: '待开始',
  todo: '待开始',
  paused: '已暂停',
  pending_approval: '待审批',
  req_confirm: '待审批',
  waiting_user: '待你确认',
  completed: '已完成',
  done: '已完成',
  success: '已完成',
  reviewed: '已完成',
  failed: '失败',
  error: '失败',
  timed_out: '超时',
  cancelled: '已取消',
  canceled: '已取消',
  rejected: '已拒绝',
}

function normalizeTaskStatus(raw: string | undefined | null): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
}

function taskStatusLabel(raw: string | undefined | null): string {
  const s = normalizeTaskStatus(raw)
  if (!s) return '未知'
  return TASK_STATUS_ZH[s] || s
}

function taskStatusTone(raw: string | undefined | null): string {
  const s = normalizeTaskStatus(raw)
  if (/execut|progress|running|active/.test(s)) return 'progress'
  if (/complete|done|success|reviewed/.test(s)) return 'completed'
  if (/fail|error|timed|reject/.test(s)) return 'failed'
  if (/pending_approval|confirm|waiting/.test(s)) return 'pending'
  if (/cancel/.test(s)) return 'cancelled'
  if (/pause/.test(s)) return 'paused'
  return 'pending'
}

function coerceProgress(raw: unknown): number | null {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  if (n <= 1) return Math.round(n * 100)
  return Math.min(100, Math.round(n))
}

function roleStatusLabel(
  roleBusy: boolean,
  isRunning: boolean,
  busyOnOtherSession: boolean,
): string {
  if (isRunning) return '执行中'
  if (roleBusy && busyOnOtherSession) return '值班中'
  if (roleBusy) return '忙碌'
  return '空闲'
}

function TaskPane({
  sessionTitle,
  isRunning,
  tokenTotals,
  agentCode,
  sessionKey,
  liveTask = null,
}: {
  sessionTitle: string
  isRunning: boolean
  tokenTotals: TokenTotals | null
  agentCode?: string
  sessionKey?: string
  liveTask?: CollabTaskSnapshot | null
}) {
  const parsed = useMemo(
    () => parseProactiveSessionKey(sessionKey),
    [sessionKey],
  )
  // 只对 proactive:* 会话 / 明确员工 agentCode 拉 busy·work-board；跳过 main 等普通智能体
  const code = String(parsed.agentCode || '').trim() || (
    String(sessionKey || '').trim().startsWith('proactive:')
      ? String(agentCode || '').trim()
      : ''
  )
  /** 会话可关联多任务：手动 focus；默认跟最近活跃 */
  const hintTaskId = String(parsed.taskId || '').trim()
  const [focusTaskId, setFocusTaskId] = useState('')
  const [boardTasks, setBoardTasks] = useState<EmployeeBoardTask[]>([])
  const [boardTask, setBoardTask] = useState<EmployeeBoardTask | null>(null)
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [boardCount, setBoardCount] = useState(0)
  const [showTechDetails, setShowTechDetails] = useState(false)
  const [roleMissing, setRoleMissing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [roleBusy, setRoleBusy] = useState(false)
  const [busySessionKey, setBusySessionKey] = useState('')
  const [busyRoundId, setBusyRoundId] = useState('')

  useEffect(() => {
    setFocusTaskId('')
  }, [sessionKey])

  useEffect(() => {
    setRoleMissing(false)
  }, [code])

  const sessionTaskList = useMemo(() => {
    const liveHint = String(liveTask?.taskId || '').trim()
    return listSessionBoardTasks(
      boardTasks,
      String(sessionKey || ''),
      [hintTaskId, focusTaskId, liveHint].filter(Boolean),
      10,
    )
  }, [boardTasks, sessionKey, hintTaskId, focusTaskId, liveTask?.taskId])

  const preferredTaskId = String(focusTaskId || hintTaskId || '').trim()
  const pinnedLive = useMemo(
    () =>
      resolveOverlayLiveTask(
        String(boardTaskId(boardTask) || preferredTaskId),
        liveTask,
      ),
    [boardTask, preferredTaskId, liveTask],
  )

  useEffect(() => {
    if (!code || roleMissing) {
      setBoardTask(null)
      setBoardTasks([])
      setRoleBusy(false)
      setBusySessionKey('')
      setBusyRoundId('')
      setPendingApprovals(0)
      setBoardCount(0)
      return
    }
    let cancelled = false
    let busyTimer: ReturnType<typeof setInterval> | null = null
    let boardTimer: ReturnType<typeof setInterval> | null = null

    const isRoleNotFound = (err: unknown) => {
      const e = err as { status?: number; message?: string } | null
      if (Number(e?.status) === 404) return true
      return /role\s+['"]?[\w.-]+['"]?\s+not found/i.test(String(e?.message || err || ''))
    }

    const applyBusy = (busyRes: any) => {
      setRoleBusy(Boolean(busyRes?.busy || busyRes?.is_busy))
      setBusySessionKey(String(busyRes?.current_session_key || '').trim())
      setBusyRoundId(String(busyRes?.current_round_id || '').trim())
      return busyRes
    }

    const applyBoard = (boardRes: any, busySessionHint: string) => {
      const tasks = Array.isArray(boardRes?.tasks)
        ? (boardRes.tasks as EmployeeBoardTask[])
        : []
      setBoardTasks(tasks)
      setBoardCount(tasks.filter((t) => t && !t.is_subtask && !t.subtask_id).length)
      setPendingApprovals(
        Array.isArray(boardRes?.pending_approvals)
          ? boardRes.pending_approvals.length
          : Number(boardRes?.counts?.pending_approvals || 0) || 0,
      )
      const liveHint = String(liveTask?.taskId || '').trim()
      const listed = listSessionBoardTasks(
        tasks,
        String(sessionKey || ''),
        [hintTaskId, focusTaskId, liveHint].filter(Boolean),
        10,
      )
      // 新对话/无关联任务时置空：当前任务卡片显示空态，不把岗位其他任务顶上来
      setBoardTask(
        listed.scoped
          ? pickBoardTask(
              listed.items,
              hintTaskId,
              busySessionHint,
              focusTaskId,
            )
          : null,
      )
    }

    const loadBusy = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const { api } = await import('../../lib/tauri-api.js')
        const busyRes = await api.proactiveRoleBusy(code)
        if (cancelled || !busyRes) return
        if (busyRes.missing) {
          setRoleMissing(true)
          return
        }
        applyBusy(busyRes)
      } catch (err) {
        if (isRoleNotFound(err)) {
          setRoleMissing(true)
          return
        }
        /* ignore transient */
      }
    }

    const loadBoard = async (silent: boolean) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (!silent) setLoading(true)
      try {
        const { api } = await import('../../lib/tauri-api.js')
        const [busyRes, boardRes] = await Promise.all([
          api.proactiveRoleBusy(code).catch((err: unknown) => {
            if (isRoleNotFound(err)) throw err
            return null
          }),
          api.proactiveRoleWorkBoard(code, 80).catch((err: unknown) => {
            if (isRoleNotFound(err)) throw err
            return null
          }),
        ])
        if (cancelled) return
        if (busyRes?.missing || boardRes?.missing) {
          setRoleMissing(true)
          setBoardTask(null)
          setBoardTasks([])
          return
        }
        const hint = String(applyBusy(busyRes)?.current_session_key || '').trim()
        if (boardRes) applyBoard(boardRes, hint)
      } catch (err) {
        if (isRoleNotFound(err)) {
          setRoleMissing(true)
          if (!cancelled) {
            setBoardTask(null)
            setBoardTasks([])
          }
          return
        }
        if (!cancelled) {
          setBoardTask(null)
          setBoardTasks([])
        }
      } finally {
        if (!cancelled && !silent) setLoading(false)
      }
    }

    const clearTimers = () => {
      if (busyTimer) {
        clearInterval(busyTimer)
        busyTimer = null
      }
      if (boardTimer) {
        clearInterval(boardTimer)
        boardTimer = null
      }
    }

    const startTimers = () => {
      clearTimers()
      // 员工任务看板 SSOT：对话执行中加快刷新，便于 tasks.progress/state 尽快反映到侧栏
      const busyMs = isRunning ? 8_000 : 20_000
      const boardMs = isRunning ? 10_000 : 25_000
      busyTimer = setInterval(() => {
        void loadBusy()
      }, busyMs)
      boardTimer = setInterval(() => {
        void loadBoard(true)
      }, boardMs)
    }

    void loadBoard(false)
    startTimers()

    const onVisibility = () => {
      if (typeof document === 'undefined') return
      if (document.visibilityState === 'hidden') {
        clearTimers()
        return
      }
      void loadBusy()
      startTimers()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }

    return () => {
      cancelled = true
      clearTimers()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }
  }, [code, hintTaskId, focusTaskId, isRunning, sessionKey, liveTask?.taskId, roleMissing])

  const focusedId = boardTaskId(boardTask)
  const title =
    String(pinnedLive?.name || boardTask?.name || sessionTitle || '').trim() ||
    (parsed.kind === 'chat' ? '自由对话' : '未命名任务')
  const taskKind = inferEmployeeTaskKind(title, parsed.kind)
  const statusRaw =
    String(pinnedLive?.status || boardTask?.status || '').trim() ||
    (isRunning ? 'executing' : parsed.kind === 'chat' ? 'idle' : 'pending')
  const statusZh =
    statusRaw === 'idle' ? '空闲' : taskStatusLabel(statusRaw)
  const tone = statusRaw === 'idle' ? 'idle' : taskStatusTone(statusRaw)
  const taskDone = /complete|done|success|reviewed/i.test(statusRaw)
  const currentSk = String(sessionKey || '').trim()
  const busyOnOtherSession = Boolean(
    roleBusy && busySessionKey && busySessionKey !== currentSk,
  )
  const busyHint = proactiveBusySessionHint(busySessionKey, currentSk)
  const roundClock = formatDutyRoundClock(busyRoundId || boardTask?.round_id)
  const progress =
    coerceProgress(pinnedLive?.progress) ??
    coerceProgress(boardTask?.progress) ??
    (isRunning
      ? null
      : taskDone
        ? 100
        : null)
  const desc = String(
    boardTask?.description || boardTask?.plan_goal || pinnedLive?.planGoal || '',
  ).trim()
  const summary = String(boardTask?.summary || boardTask?.result || '').trim()
  const taskId = String(focusedId || preferredTaskId || pinnedLive?.taskId || '').trim()
  const working = isRunning || (!taskDone && tone === 'progress')
  const roleStatus = roleStatusLabel(roleBusy, isRunning, busyOnOtherSession)
  const tokenTotal = Number(tokenTotals?.total || 0)
  const hasStats = boardCount > 0 || pendingApprovals > 0 || tokenTotal > 0
  const hasTechDetails = Boolean(taskId || busyRoundId)
  const sourceLabel =
    String(boardTask?.source_zh || '').trim() ||
    taskSourceLabel(boardTask?.source || boardTask?.source_channel)
  const roleName = String(boardTask?.assigned_role || '').trim()
  const assignee = String(boardTask?.assigned_to || '').trim()
  const raisedBy = String(boardTask?.raised_by || '').trim()
  const updatedLabel = formatInfoRailTime(boardTask?.updated_at || pinnedLive?.updatedAt)
  const startedLabel = formatInfoRailTime(boardTask?.started_at)
  const completedLabel = formatInfoRailTime(boardTask?.completed_at)
  const risk = String(boardTask?.risk_level || '').trim()
  const relatedTasks = sessionTaskList.items
  const showRelatedList = relatedTasks.length > 1
  const relatedHead = sessionTaskList.scoped ? '本会话任务' : '岗位任务'
  const pct =
    progress != null ? progress : taskDone ? 100 : working ? 8 : 0
  const buffering = working && !taskDone && pct < 100
  const failed = tone === 'failed'
  const cancelled = /cancel/.test(statusRaw)
  const progBarClass = [
    'tl-progbar',
    'tl-progbar--card',
    buffering ? 'is-live' : '',
    taskDone ? 'is-done' : '',
    failed ? 'is-failed' : '',
    cancelled ? 'is-muted' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const pctLabel =
    progress != null
      ? `${progress}%`
      : working
        ? '进行中'
        : loading
          ? '…'
          : '—'

  // 会话无关联任务（新对话）：显示空态，不把岗位其他任务顶上来
  const noAssociatedTask = !boardTask && !pinnedLive && !busyRoundId && !isRunning

  if (noAssociatedTask) {
    return (
      <div className="react-chat-current-task-pane">
        <section className="react-chat-current-task-card react-chat-current-task-card--empty" aria-label="当前任务">
          <div className="react-chat-current-task-kicker">
            <span>{taskKind}</span>
            <span className="react-chat-current-task-badge task-status-idle">空闲</span>
          </div>
          <h2 className="react-chat-current-task-title" title={title}>
            {title}
          </h2>
          <p className="react-chat-current-task-empty" role="status">
            {loading ? '加载中…' : '暂无关联任务'}
          </p>
        </section>
      </div>
    )
  }

  return (
    <div className="react-chat-current-task-pane">
      <section
        className={`react-chat-current-task-card${working ? ' is-working' : ''}`}
        aria-label="当前任务"
      >
        <div className="react-chat-current-task-kicker">
          <span>{taskKind}</span>
          <span
            className={`react-chat-current-task-badge task-status-${tone}`}
          >
            {working && tone === 'progress' ? '执行中' : statusZh}
          </span>
        </div>
        <h2 className="react-chat-current-task-title" title={title}>
          {title}
        </h2>
        {desc && desc !== title ? (
          <p className="react-chat-current-task-desc" title={desc}>
            {desc.length > 220 ? `${desc.slice(0, 220)}…` : desc}
          </p>
        ) : null}

        <div className="react-chat-current-task-progress-block">
          <div
            className={progBarClass}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ?? undefined}
            aria-label={`进度 ${pctLabel}`}
          >
            <div className="tl-progbar__track">
              <div
                className={`tl-progbar__fill${buffering ? ' is-buffering' : ''}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="tl-progbar__pct">{pctLabel}</span>
          </div>
        </div>

        {summary && summary !== desc && summary !== title ? (
          <p className="react-chat-current-task-summary" title={summary}>
            {summary.length > 200 ? `${summary.slice(0, 200)}…` : summary}
          </p>
        ) : null}
      </section>

      {showRelatedList ? (
        <section className="react-chat-session-task-list" aria-label={relatedHead}>
          <div className="react-chat-session-task-list-head">
            {relatedHead}
            <span className="react-chat-session-task-list-count">{relatedTasks.length}</span>
          </div>
          <ul className="react-chat-session-task-list-body">
            {relatedTasks.map((t, idx) => {
              const id = boardTaskId(t)
              const name = String(t.name || '').trim() || '未命名'
              const st = taskStatusLabel(t.status)
              const active = Boolean(id && id === focusedId)
              return (
                <li key={id || `session-task-${idx}`}>
                  <button
                    type="button"
                    className={`react-chat-session-task-item${active ? ' is-active' : ''}`}
                    title={id || name}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => {
                      if (id) setFocusTaskId(id)
                    }}
                  >
                    <span className="react-chat-session-task-item-name">{name}</span>
                    <span className="react-chat-session-task-item-status">{st}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {busyHint ? (
        <div className="react-chat-current-task-notice" role="status">
          {busyHint}
          {roundClock ? ` · ${roundClock}` : ''}
        </div>
      ) : null}

      {hasStats ? (
        <section className="react-chat-current-task-stats" aria-label="工作概览">
          {boardCount > 0 ? (
            <span className="react-chat-current-task-stat">
              <strong>{boardCount}</strong> 工作项
            </span>
          ) : null}
          {pendingApprovals > 0 ? (
            <span className="react-chat-current-task-stat react-chat-current-task-stat--warn">
              <strong>{pendingApprovals}</strong> 待审批
            </span>
          ) : null}
          {tokenTotal > 0 ? (
            <span className="react-chat-current-task-stat">
              <strong>{formatCompactCount(tokenTotal)}</strong> Token
            </span>
          ) : null}
        </section>
      ) : null}

      <section className="react-chat-current-task-meta" aria-label="任务状态">
        <Row label="岗位状态" value={roleStatus} />
        <Row label="任务状态" value={statusZh} />
        {updatedLabel ? <Row label="最近更新" value={updatedLabel} /> : null}
        {startedLabel ? <Row label="开始" value={startedLabel} /> : null}
        {completedLabel ? <Row label="完成" value={completedLabel} /> : null}
        {roleName ? <Row label="指派岗位" value={roleName} /> : null}
        {assignee && assignee !== roleName ? (
          <Row label="执行人" value={assignee} />
        ) : null}
        {raisedBy ? <Row label="提起人" value={raisedBy} /> : null}
        {sourceLabel ? <Row label="来源" value={sourceLabel} /> : null}
        {risk ? <Row label="风险" value={risk} /> : null}
        {roundClock && !busyHint ? <Row label="值班时间" value={roundClock} /> : null}
      </section>

      {hasTechDetails ? (
        <div className="react-chat-current-task-tech">
          <button
            type="button"
            className="react-chat-current-task-tech-toggle"
            aria-expanded={showTechDetails}
            onClick={() => setShowTechDetails((v) => !v)}
          >
            {showTechDetails ? '收起技术信息' : '技术信息'}
          </button>
          {showTechDetails ? (
            <div className="react-chat-current-task-tech-body">
              {taskId ? (
                <Row label="任务 ID" value={shortenTaskId(taskId)} title={taskId} />
              ) : null}
              {busyRoundId ? (
                <Row label="轮次 ID" value={shortenTaskId(busyRoundId)} title={busyRoundId} />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const AUTONOMY_ZH: Record<string, string> = {
  full_auto: '全自动',
  approval_for_risky: '风险需审批',
  approval_for_all: '全部需审批',
}

function EmployeePane({
  employeeInfo,
  sessionTitle: _sessionTitle,
  isRunning,
  agentLabel,
  modelLabel,
  agentCode,
  agentDescription,
  agent,
  skillNames,
  toolNames,
  mcpServers,
  knowledgeVaultIds,
  onPatchCapabilities,
  capabilityBusy,
  modelName,
  contextUsage,
  tokenTotals,
  onManualCompact,
  manualCompactDisabled,
  onEditAgent,
  onAssetQuickAction,
  assetQuickBusy = false,
}: {
  employeeInfo?: EmployeeRailInfo | null
  sessionTitle: string
  isRunning: boolean
  agentLabel: string
  modelLabel: string
  agentCode?: string
  agentDescription?: string
  agent?: AgentAvatarAgent | null
  skillNames: string[]
  toolNames?: string[] | null
  mcpServers?: string[] | null
  knowledgeVaultIds?: string[]
  onPatchCapabilities?: (patch: AgentCapabilityPatch) => Promise<void>
  capabilityBusy?: boolean
  modelName?: string
  contextUsage?: ContextUsageSnapshot | null
  tokenTotals?: TokenTotals | null
  onManualCompact?: () => void
  manualCompactDisabled?: boolean
  onEditAgent?: () => void
  onAssetQuickAction?: (kind: 'episode' | 'craft' | 'journal') => void
  assetQuickBusy?: boolean
}) {
  const [dutyExpanded, setDutyExpanded] = useState(false)
  const code = String(employeeInfo?.agentCode || agentCode || '').trim()
  const roleName = String(employeeInfo?.roleName || '').trim() || '未命名岗位'
  const employeeName = String(agentLabel || '').trim() || code || '智能体员工'
  const department = String(employeeInfo?.department || '').trim()
  const bio = String(agentDescription || '').trim()
  const responsibilities = (employeeInfo?.responsibilities || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
  const workspacePath = String(employeeInfo?.workspacePath || '').trim()
  const roleModel = String(employeeInfo?.modelName || '').trim()
  const thinkLabel = String(employeeInfo?.thinkModeLabel || '').trim()
  const autonomyRaw = String(employeeInfo?.autonomyLabel || '').trim()
  const autonomy = AUTONOMY_ZH[autonomyRaw] || autonomyRaw
  const kbIds = Array.isArray(employeeInfo?.knowledgeVaultIds)
    ? employeeInfo!.knowledgeVaultIds!
    : knowledgeVaultIds || []
  const briefDuties = responsibilities.slice(0, 2)
  const hasMoreDuties = responsibilities.length > 2
  const hasExtraMeta = Boolean(autonomy || thinkLabel || workspacePath)
  const anyTruncated = briefDuties.some((r) => r.length > 48)
  const showDutyToggle = hasMoreDuties || hasExtraMeta || anyTruncated

  return (
    <div className="react-chat-agent-pane react-chat-employee-pane">
      <header className="react-chat-agent-profile">
        <div
          className={`react-chat-agent-profile-top${onEditAgent ? ' is-editable' : ''}`}
          role={onEditAgent ? 'button' : undefined}
          tabIndex={onEditAgent ? 0 : undefined}
          title={onEditAgent ? '点击编辑绑定智能体' : undefined}
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
          <div className="react-chat-agent-profile-portrait">
            <AgentAvatar
              agent={agent}
              agentCode={code || undefined}
              size={44}
              className="react-chat-agent-profile-avatar"
              title={employeeName}
            />
            <span
              className={`react-chat-agent-profile-live${isRunning ? ' is-online' : ' is-online'}`}
              title={isRunning ? '执行中' : '在线'}
              aria-hidden
            />
          </div>
          <div className="react-chat-agent-profile-main">
            <div className="react-chat-agent-profile-name-row">
              <h2 className="react-chat-agent-profile-name" title={employeeName}>
                {employeeName}
              </h2>
            </div>
            <div className="react-chat-agent-profile-meta" title={roleName}>
              {department ? `${department} · ` : ''}
              {roleName}
            </div>
          </div>
        </div>
        {bio ? (
          <p className="react-chat-agent-profile-bio" title={bio}>
            {bio}
          </p>
        ) : null}
      </header>

      {(responsibilities.length || hasExtraMeta) ? (
        <section className="react-chat-employee-meta" aria-label="岗位职责">
          {responsibilities.length ? (
            <div className="react-chat-employee-responsibilities">
              <div className="react-chat-info-rail-row-label">职责</div>
              <ul>
                {(dutyExpanded ? responsibilities : briefDuties).map((r) => (
                  <li key={r} title={r}>
                    {dutyExpanded || r.length <= 48 ? r : `${r.slice(0, 48)}…`}
                  </li>
                ))}
              </ul>
              {!dutyExpanded && hasMoreDuties ? (
                <div className="react-chat-employee-duty-more">
                  另有 {responsibilities.length - briefDuties.length} 项…
                </div>
              ) : null}
            </div>
          ) : null}
          {dutyExpanded && hasExtraMeta ? (
            <div className="react-chat-employee-extra-meta">
              {autonomy ? <Row label="审批策略" value={autonomy} /> : null}
              {thinkLabel ? <Row label="工作方式" value={thinkLabel} /> : null}
              {workspacePath ? <Row label="工作空间" value={workspacePath} /> : null}
            </div>
          ) : null}
          {showDutyToggle ? (
            <button
              type="button"
              className="react-chat-info-rail-action react-chat-employee-duty-toggle"
              onClick={() => setDutyExpanded((v) => !v)}
            >
              {dutyExpanded ? '收起详情' : '查看详情'}
            </button>
          ) : null}
        </section>
      ) : null}

      <AgentCapabilityTabs
        skillNames={skillNames}
        toolNames={toolNames}
        mcpServers={mcpServers}
        knowledgeVaultIds={kbIds}
        modelName={String(modelName || roleModel || modelLabel || '').trim()}
        editable={Boolean(onPatchCapabilities && code)}
        busy={capabilityBusy}
        onPatch={onPatchCapabilities}
      />

      <section className="react-chat-agent-context" aria-label="上下文占用">
        <ContextOccupancyPanel
          usage={contextUsage || null}
          tokenTotals={tokenTotals || null}
          onManualCompact={onManualCompact}
          manualCompactDisabled={manualCompactDisabled}
        />
      </section>

      {onAssetQuickAction ? (
        <AssetQuickActions onAction={onAssetQuickAction} busy={assetQuickBusy} />
      ) : null}
    </div>
  )
}

function RunPane({ isRunning }: { isRunning: boolean }) {
  return (
    <>
      <Row label="运行状态" value={isRunning ? 'Running' : '已结束'} />
      <EmptyHint>完整 Tool / Debug 信息可在详细运行中查看</EmptyHint>
    </>
  )
}

function tabTitle(tab: InfoRailTab, isEmployee: boolean): string {
  if (tab === 'artifacts') return '产物'
  if (tab === 'platform') return '平台'
  if (tab === 'debug') return '调试'
  if (tab === 'context') return '上下文'
  if (tab === 'agent') return 'Agent'
  if (tab === 'employee') return '员工'
  if (tab === 'task') return isEmployee ? '任务' : '产物'
  if (tab === 'run') return '运行'
  return '详情'
}

function ChatWorkspaceInfoRailInner({
  tab,
  isEmployeeSession = false,
  sessionTitle,
  isRunning,
  contextUsage,
  tokenTotals,
  agentLabel,
  modelLabel,
  agentCode,
  agentDescription,
  agent,
  skillCount: _skillCount = 0,
  toolCount: _toolCount = 0,
  skillNames = [],
  toolNames = null,
  mcpServers = null,
  knowledgeVaultIds = [],
  onPatchCapabilities,
  capabilityBusy = false,
  modelName,
  artifacts = [],
  recentArtifacts = [],
  artifactFocusId = '',
  platformEntries = [],
  recentPlatformEntries = [],
  platformFocusEntryId = '',
  onOpenArtifact,
  onRevealArtifact,
  onTabChange,
  onSwitchAgent,
  onEditAgent,
  onManualCompact,
  manualCompactDisabled,
  onClose,
  onAssetQuickAction,
  assetQuickBusy = false,
  employeeInfo = null,
  sessionKey = '',
  liveTask = null,
  obsEnabled = false,
  threadId = '',
}: Props) {
  // 普通对话：旧 context / 员工专用 tab 归到 Agent，避免切会话后仍停在 task 触发 proactive 轮询
  const effectiveTab: InfoRailTab = !isEmployeeSession
    ? tab === 'context' || tab === 'employee' || tab === 'task' || tab === 'run'
      ? 'agent'
      : tab
    : tab === 'context'
      ? 'task'
      : tab
  // 员工：岗位（员工 tab）最左、任务紧挨其右；平台一律置后
  const tabs: InfoRailTab[] = isEmployeeSession
    ? [
        'employee',
        'task',
        'artifacts',
        'run',
        ...(obsEnabled ? (['debug'] as InfoRailTab[]) : []),
        'platform',
      ]
    : [
        'agent',
        'artifacts',
        ...(obsEnabled ? (['debug'] as InfoRailTab[]) : []),
        'platform',
      ]

  let body: ReactNode = null
  if (effectiveTab === 'artifacts')
    body = (
      <ArtifactsPane
        items={artifacts}
        recentItems={recentArtifacts}
        focusArtifactId={artifactFocusId}
        onOpenArtifact={onOpenArtifact}
        onRevealArtifact={onRevealArtifact}
      />
    )
  else if (effectiveTab === 'platform')
    body = (
      <PlatformRunTable
        entries={normalizePlatformRunEntries(platformEntries)}
        recentEntries={normalizePlatformRunEntries(recentPlatformEntries)}
        focusEntryId={platformFocusEntryId}
        emptyText="本次对话暂无平台操作。创建待办、修改设置等成功后会出现在这里。"
      />
    )
  else if (effectiveTab === 'debug' && obsEnabled)
    body = <SessionDebugPane threadId={threadId} isRunning={isRunning} />
  else if (effectiveTab === 'agent')
    body = (
      <AgentPane
        agentLabel={agentLabel}
        modelLabel={modelLabel}
        modelName={modelName}
        agentCode={agentCode}
        agentDescription={agentDescription}
        agent={agent}
        skillNames={skillNames}
        toolNames={toolNames}
        mcpServers={mcpServers}
        knowledgeVaultIds={knowledgeVaultIds}
        onSwitchAgent={onSwitchAgent}
        onEditAgent={onEditAgent}
        onPatchCapabilities={onPatchCapabilities}
        capabilityBusy={capabilityBusy}
        contextUsage={contextUsage}
        tokenTotals={tokenTotals}
        onManualCompact={onManualCompact}
        manualCompactDisabled={manualCompactDisabled}
        onAssetQuickAction={onAssetQuickAction}
        assetQuickBusy={assetQuickBusy}
      />
    )
  else if (effectiveTab === 'employee')
    body = (
      <EmployeePane
        employeeInfo={employeeInfo}
        sessionTitle={sessionTitle}
        isRunning={isRunning}
        agentLabel={agentLabel}
        modelLabel={modelLabel}
        agentCode={agentCode}
        agentDescription={agentDescription}
        agent={agent}
        skillNames={skillNames}
        toolNames={toolNames}
        mcpServers={mcpServers}
        knowledgeVaultIds={knowledgeVaultIds}
        onPatchCapabilities={onPatchCapabilities}
        capabilityBusy={capabilityBusy}
        modelName={modelName}
        contextUsage={contextUsage}
        tokenTotals={tokenTotals}
        onManualCompact={onManualCompact}
        manualCompactDisabled={manualCompactDisabled}
        onEditAgent={onEditAgent}
        onAssetQuickAction={onAssetQuickAction}
        assetQuickBusy={assetQuickBusy}
      />
    )
  else if (effectiveTab === 'task')
    body = (
      <TaskPane
        key={String(sessionKey || agentCode || employeeInfo?.agentCode || 'task-pane')}
        sessionTitle={sessionTitle}
        isRunning={isRunning}
        tokenTotals={tokenTotals}
        agentCode={agentCode || employeeInfo?.agentCode}
        sessionKey={sessionKey}
        liveTask={liveTask}
      />
    )
  else if (effectiveTab === 'run') body = <RunPane isRunning={isRunning} />

  return (
    <aside
      className={`react-chat-info-rail${isEmployeeSession ? ' is-employee' : ' is-conversation'}`}
      role="complementary"
      aria-label={tabTitle(effectiveTab, isEmployeeSession)}
    >
      <header className="react-chat-info-rail-header">
        <div className="react-chat-info-rail-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={effectiveTab === t}
              className={`react-chat-info-rail-tab${effectiveTab === t ? ' is-active' : ''}`}
              onClick={() => onTabChange?.(t)}
            >
              {tabTitle(t, isEmployeeSession)}
            </button>
          ))}
        </div>
        {onClose ? (
          <button type="button" className="react-chat-info-rail-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        ) : null}
      </header>
      <div className="react-chat-info-rail-body">
        {effectiveTab === 'artifacts' ? (
          <div className="react-chat-info-rail-panel-title">
            {artifacts.length > 0 ? `产物 ${artifacts.length}` : '产物'}
          </div>
        ) : effectiveTab === 'platform' ? (
          <div className="react-chat-info-rail-panel-title">
            {platformEntries.length > 0 ? `平台 ${platformEntries.length}` : '平台'}
          </div>
        ) : effectiveTab === 'debug' ? (
          <div className="react-chat-info-rail-panel-title">调试</div>
        ) : effectiveTab === 'agent' || effectiveTab === 'employee' || effectiveTab === 'task' ? null : (
          <div className="react-chat-info-rail-panel-title">
            {tabTitle(effectiveTab, isEmployeeSession)}
          </div>
        )}
        {body}
      </div>
    </aside>
  )
}

export const ChatWorkspaceInfoRail = memo(ChatWorkspaceInfoRailInner)

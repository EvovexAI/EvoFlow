import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { positionMenuAboveAnchor, positionMenuAbovePoint } from '../lib/session-list/menu-position.js'
import type { ShellSidebarSyncRow } from '../lib/session-list/types.js'
import type { ResolvedLiveStreamActivity } from '../lib/resolve-live-stream-activity.js'
import type { RunningSessionSummary } from '../hooks/useRunningSessionSummaries.js'
import { useShellSessionRunningPreview } from '../hooks/useShellSessionRunningPreview.js'
import { useRunningElapsedLabel } from '../hooks/useRunningElapsedLabel.js'
import { isProactiveSessionKey, proactiveAgentCodeFromSessionKey } from '../lib/session-list/workspace-groups.js'
import {
  resolveSessionListIdentity,
  sessionTriggerLabel,
} from '../lib/session-list/session-identity.js'
import { AssignedAgentAvatar } from './AssignedAgentAvatar.js'
import {
  ShellLoaderIcon,
  ShellPinIcon,
  ShellSessionIcon,
} from './ShellSidebarIcons.js'
import { resolveAssignedAgentDisplayName } from '../../lib/tool-display.js'
import { SessionTitleOverflowText } from './SessionTitleOverflowText.js'

type SessionContextMenuState = {
  sessionKey: string
  x: number
  y: number
}

/** 侧栏会话行菜单动作（对齐 zcode task context menu + EvoFlow 原有项） */
export type SessionMenuAction =
  | 'pin'
  | 'rename'
  | 'stop'
  | 'delete'
  | 'fork'
  | 'refresh'
  | 'top'
  | 'archive'
  | 'unarchive'
  | 'mark-unread'
  | 'copy-id'
  | 'copy-path'
  | 'reveal'

/** 「移动到工作空间」子菜单目标 */
export type SessionMoveTarget = {
  workspaceKey: string
  label: string
}

type ShellSessionListRowProps = {
  row: ShellSidebarSyncRow
  active: boolean
  moreOpen: boolean
  editingTitle: boolean
  /** 已归档（菜单切换为「取消归档」；归档区行也用它） */
  archived?: boolean
  /** 手动「标为未读」（点开会话即清除） */
  unreadMarked?: boolean
  /** 「移动到工作空间」子菜单目标（排除当前组）；空 = 隐藏该项 */
  moveTargets?: SessionMoveTarget[]
  onMoveToWorkspace?: (workspaceKey: string) => void
  /** ``/api/agents`` 列表，供员工会话行解析岗位头像 */
  agents?: unknown[] | null
  /** 雇佣花名册，agents 未命中时用于显示员工名 */
  employeeRoles?: Array<{
    agent_code: string
    role_name: string
    agent_name?: string
  }> | null
  runningSummary?: RunningSessionSummary | null
  resolveLiveStreamActivity?: (
    sessionKey: string,
    isSelectedRow: boolean,
  ) => ResolvedLiveStreamActivity | null
  /** chat=普通对话；employee=员工对话（单行，标题为员工名） */
  variant?: 'chat' | 'employee'
  onSelect: () => void
  onMoreToggle: () => void
  /** 会话行是否有可解析的本地工作空间路径（决定「在文件管理器打开 / 复制路径」可用） */
  hasWorkspacePath?: boolean
  onRefresh: () => void
  onMenuAction: (action: SessionMenuAction) => void
  onTitleCommit: (title: string) => void
  onTitleCancel: () => void
  onStartTitleEdit: () => void
  onContextMenu: (x: number, y: number) => void
  onPinnedReorder: (dragKey: string, dropKey: string) => void
  /** Hover prefetch: warm idle runtime cache before click. */
  onPrefetch?: () => void
}

function normalizeAgentCodeKey(code: string): string {
  return String(code || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
}

/** 侧栏会话标题：输入/落库上限 */
export const SIDEBAR_SESSION_TITLE_INPUT_MAX = 30

export function clipSidebarSessionTitle(
  text: string,
  max = SIDEBAR_SESSION_TITLE_INPUT_MAX,
): string {
  const chars = Array.from(String(text || '').trim())
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, max).join('')
}

/** 侧栏员工行：只显示智能体名，不用岗位名 */
function resolveEmployeeName(
  agentCode: string,
  agents: unknown[] | null | undefined,
  fallbackTitle: string,
  roles?: Array<{ agent_code: string; role_name: string; agent_name?: string }> | null,
): string {
  const code = String(agentCode || '').trim()
  const fromAgents = resolveAssignedAgentDisplayName(code, agents)
  if (fromAgents && fromAgents !== code) return fromAgents

  const role = (roles || []).find(
    (r) => normalizeAgentCodeKey(r.agent_code) === normalizeAgentCodeKey(code),
  )
  const fromRoleAgent = String(role?.agent_name || '').trim()
  if (fromRoleAgent) return fromRoleAgent

  // role_name 在 proactiveRolesDisplay 里可能已被替换为 agent_name；仅当与 code 不同且不像岗位兜底时使用
  // 仍优先 code，避免把「前端架构负责人」这类岗位名当做人名
  if (code) return code
  return fallbackTitle || 'BOT'
}

function eventTargetElement(ev: Event): Element | null {
  const t = ev.target
  if (t instanceof Element) return t
  if (t && typeof (t as Node).parentElement !== 'undefined') {
    return (t as Node).parentElement
  }
  return null
}

/** 菜单项绑定（pointerdown/click 双通道去重， portals 下防止事件穿透） */
type SessionMenuItemBinder = (action: SessionMenuAction) => {
  onPointerDown: (e: ReactPointerEvent) => void
  onClick: (e: ReactMouseEvent) => void
}

/** 「移动到工作空间」子菜单（对齐 zcode taskGroup.moveToGroup）：hover / 点击展开，目标 = 其余工作空间 */
function MoveToWorkspaceSubmenu({
  moveTargets,
  onMoveToWorkspace,
  onCloseMenu,
}: {
  moveTargets: SessionMoveTarget[]
  onMoveToWorkspace?: (workspaceKey: string) => void
  onCloseMenu: () => void
}) {
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef(0)
  const openNow = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = 0
    }
    setOpen(true)
  }
  const closeSoon = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = 0
      setOpen(false)
    }, 160)
  }
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    }
  }, [])

  const pickTarget = (workspaceKey: string) => {
    setOpen(false)
    onCloseMenu()
    onMoveToWorkspace?.(workspaceKey)
  }

  return (
    <div
      className="react-chat-session-menu-sub"
      onMouseEnter={openNow}
      onMouseLeave={closeSoon}
    >
      <button
        type="button"
        className="react-chat-session-more-item react-chat-session-menu-sub-trigger"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <span>移动到工作空间</span>
        <span className="react-chat-session-menu-sub-arrow" aria-hidden="true">›</span>
      </button>
      {open ? (
        <div className="react-chat-session-submenu" role="menu" aria-label="移动到工作空间">
          {moveTargets.map((t) => (
            <button
              key={t.workspaceKey}
              type="button"
              className="react-chat-session-more-item react-chat-session-submenu-item"
              title={t.label}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                pickTarget(t.workspaceKey)
              }}
              onPointerDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                e.nativeEvent.stopImmediatePropagation?.()
              }}
            >
              <span className="react-chat-session-submenu-label">{t.label}</span>
            </button>
          ))}
          {moveTargets.length === 0 ? (
            <div className="react-chat-session-submenu-empty">暂无其他工作空间</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 会话菜单公共项（对齐 zcode GroupedTaskContextMenuContent / TaskActionMenuContent）：
 * 固定 / 移到顶部 / 重命名 / 归档 / 标为未读 · 移动到工作空间 · 文件夹与复制 · 分叉 / 刷新 / 停止 / 删除
 */
function SessionMenuItems({
  row,
  archived = false,
  hasWorkspacePath = false,
  moveTargets,
  bindMenuItem,
  onMoveToWorkspace,
  onCloseMenu,
}: {
  row: ShellSidebarSyncRow
  archived?: boolean
  hasWorkspacePath?: boolean
  moveTargets?: SessionMoveTarget[]
  bindMenuItem: SessionMenuItemBinder
  onMoveToWorkspace?: (workspaceKey: string) => void
  onCloseMenu: () => void
}) {
  /** 禁用项：吞掉事件但不触发动作（对齐 zcode disabled ContextMenuItem） */
  const guardBind = (action: SessionMenuAction, enabled: boolean) => {
    const bound = bindMenuItem(action)
    if (enabled) return bound
    return {
      onPointerDown: (e: ReactPointerEvent) => {
        e.preventDefault()
        e.stopPropagation()
        e.nativeEvent.stopImmediatePropagation?.()
      },
      onClick: (e: ReactMouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        e.nativeEvent.stopImmediatePropagation?.()
      },
    }
  }
  return (
    <>
      <button type="button" className="react-chat-session-more-item" {...bindMenuItem('pin')}>
        {row.isPinned ? '取消固定' : '固定'}
      </button>
      <button type="button" className="react-chat-session-more-item" {...bindMenuItem('top')}>
        移到顶部
      </button>
      <button type="button" className="react-chat-session-more-item" {...bindMenuItem('rename')}>
        修改标题
      </button>
      <button
        type="button"
        className="react-chat-session-more-item"
        {...bindMenuItem(archived ? 'unarchive' : 'archive')}
      >
        {archived ? '取消归档' : '归档'}
      </button>
      <button
        type="button"
        className="react-chat-session-more-item"
        {...bindMenuItem('mark-unread')}
      >
        标为未读
      </button>
      {moveTargets ? (
        <>
          <div className="react-chat-session-menu-sep" role="separator" />
          <MoveToWorkspaceSubmenu
            moveTargets={moveTargets}
            onMoveToWorkspace={onMoveToWorkspace}
            onCloseMenu={onCloseMenu}
          />
        </>
      ) : null}
      <div className="react-chat-session-menu-sep" role="separator" />
      <button
        type="button"
        className={`react-chat-session-more-item${hasWorkspacePath ? '' : ' react-chat-session-more-item--disabled'}`}
        {...guardBind('reveal', hasWorkspacePath)}
      >
        在文件管理器打开
      </button>
      <button
        type="button"
        className={`react-chat-session-more-item${hasWorkspacePath ? '' : ' react-chat-session-more-item--disabled'}`}
        {...guardBind('copy-path', hasWorkspacePath)}
      >
        复制路径
      </button>
      <button type="button" className="react-chat-session-more-item" {...bindMenuItem('copy-id')}>
        复制会话 ID
      </button>
      <div className="react-chat-session-menu-sep" role="separator" />
      <button type="button" className="react-chat-session-more-item" {...bindMenuItem('fork')}>
        分叉会话
      </button>
      <button type="button" className="react-chat-session-more-item" {...bindMenuItem('refresh')}>
        刷新
      </button>
      {row.executing ? (
        <button
          type="button"
          className="react-chat-session-more-item react-chat-session-more-item--warning"
          {...bindMenuItem('stop')}
        >
          停止执行
        </button>
      ) : null}
      {row.canDelete !== false ? (
        <button
          type="button"
          className="react-chat-session-more-item react-chat-session-more-item--danger"
          {...bindMenuItem('delete')}
        >
          删除会话
        </button>
      ) : null}
    </>
  )
}

function MoreMenu({
  row,
  archived = false,
  hasWorkspacePath = false,
  moveTargets,
  open,
  anchorRef,
  onAction,
  onMoveToWorkspace,
  onCloseMenu,
}: {
  row: ShellSidebarSyncRow
  archived?: boolean
  hasWorkspacePath?: boolean
  moveTargets?: SessionMoveTarget[]
  open: boolean
  anchorRef: RefObject<HTMLButtonElement | null>
  onAction: (action: SessionMenuAction) => void
  onMoveToWorkspace?: (workspaceKey: string) => void
  /** 关闭整个菜单（子菜单选中目标后调用） */
  onCloseMenu?: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const activateOnceRef = useRef(false)

  useLayoutEffect(() => {
    if (!open) {
      // Defer state update to avoid cascading renders
      requestAnimationFrame(() => {
        setPos(null)
      })
      return
    }
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return
    const rect = anchor.getBoundingClientRect()
    setPos(
      positionMenuAboveAnchor(rect, menu.offsetWidth, menu.offsetHeight, { gap: 6, preferAbove: true }),
    )
  }, [open, anchorRef, row.isPinned, row.executing])

  if (!open) return null
  const bindMenuItem = (action: SessionMenuAction) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation?.()
      if (activateOnceRef.current) return
      activateOnceRef.current = true
      onAction(action)
      window.setTimeout(() => { activateOnceRef.current = false }, 0)
    },
    onClick: (e: ReactMouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation?.()
      if (activateOnceRef.current) return
      activateOnceRef.current = true
      onAction(action)
      window.setTimeout(() => { activateOnceRef.current = false }, 0)
    },
  })

  const menu = (
    <div
      ref={menuRef}
      className="react-chat-session-more-menu react-chat-session-more-menu--portal"
      role="menu"
      style={
        pos
          ? { position: 'fixed', left: pos.left, top: pos.top, zIndex: 12000, visibility: 'visible' }
          : { position: 'fixed', left: -9999, top: 0, visibility: 'hidden' }
      }
    >
      <SessionMenuItems
        row={row}
        archived={archived}
        hasWorkspacePath={hasWorkspacePath}
        moveTargets={moveTargets}
        bindMenuItem={bindMenuItem}
        onMoveToWorkspace={onMoveToWorkspace}
        onCloseMenu={() => {
          if (onCloseMenu) onCloseMenu()
        }}
      />
    </div>
  )

  return createPortal(menu, document.body)
}

function ShellSessionListRowInner({
  row,
  active,
  moreOpen,
  editingTitle,
  archived = false,
  unreadMarked = false,
  moveTargets,
  hasWorkspacePath = false,
  agents = null,
  employeeRoles = null,
  runningSummary,
  resolveLiveStreamActivity,
  variant = 'chat',
  onSelect,
  onMoreToggle,
  onRefresh: _onRefresh,
  onMenuAction,
  onMoveToWorkspace,
  onTitleCommit,
  onTitleCancel,
  onStartTitleEdit,
  onContextMenu,
  onPinnedReorder,
  onPrefetch,
}: ShellSessionListRowProps) {
  const sessionKey = String(row.sessionKey || '')
  const identity = resolveSessionListIdentity(sessionKey)
  const triggerLabel = sessionTriggerLabel(identity.trigger)
  const proactiveAgentCode = isProactiveSessionKey(sessionKey)
    ? proactiveAgentCodeFromSessionKey(sessionKey)
    : identity.ownerKind === 'agent'
      ? identity.ownerCode
      : ''
  /** 仅「员工」变体用员工名当标题；会话行与普通对话一致用 row.title */
  const useEmployeeTitle = variant === 'employee'
  const employeeName = useEmployeeTitle
    ? resolveEmployeeName(proactiveAgentCode, agents, row.title, employeeRoles)
    : ''
  const [titleDraft, setTitleDraft] = useState(row.title)
  const inputRef = useRef<HTMLInputElement>(null)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const dragRef = useRef<{ key: string; dragging: boolean; startY: number } | null>(null)
  const suppressClickRef = useRef(false)

  useEffect(() => {
    if (!editingTitle) return
    // Defer state update to avoid cascading renders
    requestAnimationFrame(() => {
      setTitleDraft(clipSidebarSessionTitle(row.title))
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    })
  }, [editingTitle, row.title])

  const resolveActivity =
    resolveLiveStreamActivity ||
    ((_sk: string, _sel: boolean) => null as ResolvedLiveStreamActivity | null)
  // 运行中只显示齿轮 + 已运行时长；不展示工具/活动文案。
  // 仍保留 hook 调用以维持 1Hz tick（驱动时长刷新），但不再读取其文案输出。
  useShellSessionRunningPreview({
    sessionKey,
    executing: !!row.executing,
    isSelectedRow: active,
    staticPreviewLine: row.runningPreviewLine,
    runningSummary,
    resolveLiveStreamActivity: resolveActivity,
  })
  const runningElapsed = useRunningElapsedLabel(row.executing ? row.runningStartedAtMs : undefined)
  const isPinned = !!row.isPinned
  const unseen = !!row.hasUnseenRunningUpdate && !active
  // 「标为未读」手动标记：点开会话即清除（handleSelect 侧同步）
  const showUnreadDot = unreadMarked && !active

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onSelect()
  }

  const handleTitleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onTitleCommit(titleDraft)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onTitleCancel()
    }
  }

  /** 置顶行整行拖拽把手（对齐 zcode 整行可拖；仍限置顶区内换序）。
   *  行内交互元素（按钮/菜单/标题编辑/输入框）优先，不启动拖拽。 */
  const handlePinnedRowPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (
      target.closest(
        '[data-shell-more-btn], .react-chat-session-more-menu, .react-chat-history-item-title-edit, .react-chat-session-refresh-btn, button, input, a',
      )
    ) {
      return
    }
    const host = e.currentTarget.closest('[data-shell-session]') as HTMLDivElement | null
    if (!host) return
    dragRef.current = { key: sessionKey, dragging: false, startY: e.clientY }
    host.classList.add('react-chat-history-item--dragging')
    document.body.classList.add('react-chat-session-row-dragging')

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      if (Math.abs(ev.clientY - drag.startY) > 5) drag.dragging = true
      document.querySelectorAll('.react-chat-history-item--drag-over').forEach((n) => {
        n.classList.remove('react-chat-history-item--drag-over')
      })
      const under = document.elementFromPoint(ev.clientX, ev.clientY)
      const target = under?.closest?.('[data-shell-session].react-chat-history-item--pinned')
      if (target && target !== host) target.classList.add('react-chat-history-item--drag-over')
    }

    const onUp = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.classList.remove('react-chat-session-row-dragging')
      host.classList.remove('react-chat-history-item--dragging')
      document.querySelectorAll('.react-chat-history-item--drag-over').forEach((n) => {
        n.classList.remove('react-chat-history-item--drag-over')
      })
      const drag = dragRef.current
      dragRef.current = null
      if (!drag?.dragging) return
      const under = document.elementFromPoint(ev.clientX, ev.clientY)
      const target = under?.closest?.('[data-shell-session].react-chat-history-item--pinned') as HTMLElement | null
      const dropKey = String(target?.dataset?.shellSession || '').trim()
      if (dropKey && dropKey !== sessionKey) {
        onPinnedReorder(sessionKey, dropKey)
        suppressClickRef.current = true
      }
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  return (
    <li
      className={`react-chat-session-list-item${isPinned ? ' react-chat-session-list-item--pinned' : ''}${useEmployeeTitle ? ' is-employee' : ' is-chat'}`}
      data-session-pinned={isPinned ? '1' : '0'}
    >
      <div
        className={[
          'react-chat-history-item',
          useEmployeeTitle ? 'react-chat-history-item--employee' : 'react-chat-history-item--chat',
          active ? 'active' : '',
          moreOpen ? 'session-menu-open' : '',
          isPinned ? 'react-chat-history-item--pinned' : '',
          unseen ? 'react-chat-history-item--unseen' : '',
          showUnreadDot ? 'react-chat-history-item--unread-marked' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="button"
        tabIndex={0}
        data-shell-session={sessionKey}
        onClick={(e) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false
            return
          }
          if (
            (e.target as HTMLElement).closest(
              '[data-shell-more-btn], .react-chat-session-more-menu, .react-chat-history-item-title-edit, .react-chat-session-refresh-btn',
            )
          ) {
            return
          }
          onSelect()
        }}
        onKeyDown={handleKeyDown}
        onDoubleClick={(e) => {
          const titleEl = (e.target as HTMLElement).closest('.react-chat-history-item-title')
          if (!titleEl) return
          e.preventDefault()
          e.stopPropagation()
          onStartTitleEdit()
        }}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('[data-shell-more-btn], .react-chat-session-more-menu')) return
          e.preventDefault()
          onContextMenu(e.clientX, e.clientY)
        }}
        onMouseEnter={() => {
          if (!active) onPrefetch?.()
        }}
        onPointerDown={(e) => {
          // Start warm before click selection / history effect — covers fast clicks with no hover dwell.
          if (e.button === 0 && !active) onPrefetch?.()
          // 置顶行整行可拖（对齐 zcode）；未置顶行只 prefetch。
          if (isPinned) handlePinnedRowPointerDown(e)
        }}
      >
        {isPinned ? (
          <span
            className="react-chat-session-pin-badge"
            title="已置顶，按住行拖动可调整顺序"
            aria-hidden="true"
          >
            <ShellPinIcon size={11} />
          </span>
        ) : null}

        {useEmployeeTitle || row.executing ? (
          <span
            className={`react-chat-session-type-ic${active ? ' is-active' : ''}${row.executing ? ' is-running' : ''}${useEmployeeTitle && proactiveAgentCode ? ' react-chat-session-type-ic--avatar' : ''}`}
            aria-hidden="true"
          >
            {row.executing ? (
              <ShellLoaderIcon size={13} className="react-chat-session-spinner-ic animate-spin" />
            ) : useEmployeeTitle && proactiveAgentCode ? (
              <AssignedAgentAvatar
                agentCode={proactiveAgentCode}
                agents={agents}
                size={16}
                className="react-chat-session-agent-avatar"
              />
            ) : (
              <ShellSessionIcon size={12} />
            )}
          </span>
        ) : null}

        {editingTitle ? (
          <div className="react-chat-history-item-title-edit" data-shell-title-edit={sessionKey}>
            <input
              ref={inputRef}
              type="text"
              className="react-chat-history-item-title-input"
              value={titleDraft}
              maxLength={SIDEBAR_SESSION_TITLE_INPUT_MAX}
              aria-label="会话标题"
              onChange={(ev) => setTitleDraft(ev.target.value)}
              onKeyDown={handleTitleKeyDown}
              onClick={(e) => e.stopPropagation()}
            />
            <span className="react-chat-history-item-title-actions" role="group" aria-label="标题编辑">
              <button
                type="button"
                className="react-chat-title-edit-btn react-chat-title-edit-btn--ok"
                title="保存"
                aria-label="保存"
                onClick={(e) => {
                  e.stopPropagation()
                  onTitleCommit(titleDraft)
                }}
              >
                ✓
              </button>
              <button
                type="button"
                className="react-chat-title-edit-btn react-chat-title-edit-btn--cancel"
                title="取消"
                aria-label="取消"
                onClick={(e) => {
                  e.stopPropagation()
                  onTitleCancel()
                }}
              >
                ×
              </button>
            </span>
          </div>
        ) : useEmployeeTitle ? (
          <div className="react-chat-history-item-text react-chat-history-item-text--chat">
            <SessionTitleOverflowText>{employeeName}</SessionTitleOverflowText>
            <span
              className="react-chat-session-trigger-chip"
              data-trigger={identity.trigger}
              title={`触发：${triggerLabel}`}
            >
              {triggerLabel}
            </span>
          </div>
        ) : (
          <div className="react-chat-history-item-text react-chat-history-item-text--chat">
            <SessionTitleOverflowText>{row.title}</SessionTitleOverflowText>
            <span
              className="react-chat-session-trigger-chip"
              data-trigger={identity.trigger}
              title={`触发：${triggerLabel}`}
            >
              {triggerLabel}
            </span>
          </div>
        )}

        <div
          className={`react-chat-history-item-trailing${useEmployeeTitle ? ' react-chat-history-item-trailing--employee' : ''}`}
        >
          {showUnreadDot ? (
            // 对齐 zcode 未读状态点：手动标未读后常驻显示，点开会话清除
            <span
              className="react-chat-session-unread-dot"
              title="标为未读"
              aria-label="未读"
            />
          ) : null}
          {!editingTitle && row.executing && runningElapsed ? (
            // 运行中：只显示已运行时长（左侧齿轮由标题区的 spinner 承担）
            <span
              className="react-chat-history-item-meta is-live"
              title={`已运行 ${runningElapsed}`}
            >
              {runningElapsed}
            </span>
          ) : !editingTitle && row.time ? (
            <span className="react-chat-history-item-meta" title={row.time}>
              {row.time}
            </span>
          ) : null}
          <div className="react-chat-session-more-wrap" data-session-more-root>
            <button
              type="button"
              className="react-chat-session-more-btn"
              ref={moreBtnRef}
              data-shell-more-btn={sessionKey}
              aria-expanded={moreOpen ? 'true' : 'false'}
              aria-label="会话更多操作"
              title="更多操作"
              onClick={(e) => {
                e.stopPropagation()
                onMoreToggle()
              }}
            >
              ···
            </button>
            <MoreMenu
              row={row}
              archived={archived}
              hasWorkspacePath={hasWorkspacePath}
              moveTargets={moveTargets}
              open={moreOpen}
              anchorRef={moreBtnRef}
              onAction={onMenuAction}
              onMoveToWorkspace={onMoveToWorkspace}
              onCloseMenu={onMoreToggle}
            />
          </div>
        </div>
      </div>
    </li>
  )
}

export function SessionContextMenuPortal({
  menu,
  row,
  archived = false,
  hasWorkspacePath = false,
  moveTargets,
  onClose,
  onAction,
  onMoveToWorkspace,
}: {
  menu: SessionContextMenuState | null
  row: ShellSidebarSyncRow | null
  archived?: boolean
  hasWorkspacePath?: boolean
  moveTargets?: SessionMoveTarget[]
  onClose: () => void
  onAction: (action: SessionMenuAction) => void
  onMoveToWorkspace?: (workspaceKey: string) => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const activateOnceRef = useRef(false)

  useEffect(() => {
    if (!menu) return
    const onDocClick = (e: Event) => {
      const el = eventTargetElement(e)
      if (!el?.closest('.react-chat-session-context-menu')) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, onClose])

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      setPos(null)
      return
    }
    const el = menuRef.current
    setPos(
      positionMenuAbovePoint(menu.x, menu.y, el.offsetWidth, el.offsetHeight, { gap: 6 }),
    )
  }, [menu, row?.isPinned, row?.executing, archived])

  if (!menu || !row) return null
  const bindMenuItem = (action: SessionMenuAction) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation?.()
      if (activateOnceRef.current) return
      activateOnceRef.current = true
      onAction(action)
      window.setTimeout(() => { activateOnceRef.current = false }, 0)
    },
    onClick: (e: ReactMouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation?.()
      if (activateOnceRef.current) return
      activateOnceRef.current = true
      onAction(action)
      window.setTimeout(() => { activateOnceRef.current = false }, 0)
    },
  })

  return createPortal(
    <div
      ref={menuRef}
      className="react-chat-session-context-menu"
      role="menu"
      style={
        pos
          ? { position: 'fixed', left: pos.left, top: pos.top, zIndex: 12000, visibility: 'visible' }
          : { position: 'fixed', left: menu.x, top: menu.y, visibility: 'hidden' }
      }
    >
      <SessionMenuItems
        row={row}
        archived={archived}
        hasWorkspacePath={hasWorkspacePath}
        moveTargets={moveTargets}
        bindMenuItem={bindMenuItem}
        onMoveToWorkspace={onMoveToWorkspace}
        onCloseMenu={onClose}
      />
    </div>,
    document.body,
  )
}

export const ShellSessionListRow = memo(ShellSessionListRowInner)

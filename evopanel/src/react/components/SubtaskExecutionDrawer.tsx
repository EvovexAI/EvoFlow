import { createPortal } from 'react-dom'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { copyToClipboard } from '../../lib/subtask-transcript-display.js'
import { normalizeTime } from '../../lib/chat-normalize.js'
import { expandRowsToTrailTurns } from '../../lib/subtask-modal-rows.js'
import { useModalEscapeClose } from '../hooks/useModalEscapeClose.js'
import { SubtaskModalMessageRow } from './SubtaskModalMessageRow.js'
import AgentAvatar from './AgentAvatar.js'

const SCROLL_EDGE_PX = 48

function readNearBottom(el: HTMLElement, edge = SCROLL_EDGE_PX) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= edge
}

function readScrollJumpVisibility(el: HTMLElement) {
  const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
  if (maxScroll <= 8) return { showTop: false, showBottom: false }
  return {
    showTop: el.scrollTop > SCROLL_EDGE_PX,
    showBottom: !readNearBottom(el),
  }
}

/** 工作轨迹左侧时钟：每次模型交互显示 HH:mm:ss */
export function formatTrailRowClock(ts?: number | string | null): string {
  const n = normalizeTime(ts)
  if (n == null) return ''
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return ''
  const h = d.getHours().toString().padStart(2, '0')
  const m = d.getMinutes().toString().padStart(2, '0')
  const s = d.getSeconds().toString().padStart(2, '0')
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isToday) return `${h}:${m}:${s}`
  const mon = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${mon}-${day} ${h}:${m}:${s}`
}

export type SubtaskExecutionDrawerProps = {
  open: boolean
  subtaskId: string
  mode?: 'modal' | 'drawer'
  /** drawer 模式下挂到指定容器（如应用调试坞） */
  portalTarget?: HTMLElement | null
  /** 用于工具详情懒加载 /tool-results（如 proactive:{code}） */
  sessionKey?: string
  statusClass: string
  statusLabel: string
  summaryAgent: string
  shortTitle: string
  rows: any[]
  streamActive?: boolean
  sending: boolean
  canCompose: boolean
  composeText: string
  composeError: string
  copyPlainText: string
  showDetailButton?: boolean
  /** 每条消息左侧显示独立时间（智能体员工工作轨迹） */
  rowTimeLeft?: boolean
  onClose: () => void
  onOpenDetail?: () => void
  onComposeTextChange: (text: string) => void
  onSend: () => void
  onOpenMessageFile?: (rawPath: string, displayName?: string) => void
}

function lastStreamableRowIndex(rows: any[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const role = String(rows[i]?.role || '').trim()
    if (role === 'assistant' || role === '_stream') return i
  }
  return -1
}

function DrawerBody({
  subtaskId,
  sessionKey,
  rows,
  streamActive = false,
  sending,
  canCompose,
  composeText,
  composeError,
  rowTimeLeft = false,
  onComposeTextChange,
  onSend,
  onOpenMessageFile,
}: Pick<
  SubtaskExecutionDrawerProps,
  | 'subtaskId'
  | 'sessionKey'
  | 'rows'
  | 'streamActive'
  | 'sending'
  | 'canCompose'
  | 'composeText'
  | 'composeError'
  | 'rowTimeLeft'
  | 'onComposeTextChange'
  | 'onSend'
  | 'onOpenMessageFile'
>) {
  const streamingRowIndex = streamActive ? lastStreamableRowIndex(rows) : -1
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickBottomRef = useRef(true)
  const [showScrollTopBtn, setShowScrollTopBtn] = useState(false)
  const [showScrollBottomBtn, setShowScrollBottomBtn] = useState(false)

  const syncScrollJumpButtons = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      setShowScrollTopBtn(false)
      setShowScrollBottomBtn(false)
      return
    }
    const { showTop, showBottom } = readScrollJumpVisibility(el)
    setShowScrollTopBtn(showTop)
    setShowScrollBottomBtn(showBottom)
  }, [])

  const scrollToBottom = useCallback(
    (opts?: { stick?: boolean }) => {
      const el = scrollRef.current
      if (!el) return
      if (opts?.stick !== false) stickBottomRef.current = true
      el.scrollTop = el.scrollHeight
      syncScrollJumpButtons()
    },
    [syncScrollJumpButtons],
  )

  const scrollToTop = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickBottomRef.current = false
    el.scrollTop = 0
    syncScrollJumpButtons()
  }, [syncScrollJumpButtons])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickBottomRef.current = readNearBottom(el)
    syncScrollJumpButtons()
  }, [syncScrollJumpButtons])

  // 打开 / 内容更新：默认贴底；用户上翻后不再强跟，流式时若仍贴底则持续跟底
  useLayoutEffect(() => {
    if (stickBottomRef.current) {
      scrollToBottom({ stick: true })
    } else {
      syncScrollJumpButtons()
    }
  }, [rows, sending, streamActive, scrollToBottom, syncScrollJumpButtons])

  // 切换会话时重置为贴底
  useEffect(() => {
    stickBottomRef.current = true
    scrollToBottom({ stick: true })
  }, [subtaskId, scrollToBottom])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (stickBottomRef.current) scrollToBottom({ stick: true })
      else syncScrollJumpButtons()
    })
    ro.observe(el)
    for (const child of el.children) ro.observe(child)
    return () => ro.disconnect()
  }, [scrollToBottom, syncScrollJumpButtons])

  const showScrollJumpBtns =
    (rows.length > 0 || sending) && (showScrollTopBtn || showScrollBottomBtn)

  return (
    <div className="react-chat-modal-body react-chat-subtask-modal-body">
      <div className="react-chat-subtask-modal-scroll-wrap">
        {showScrollJumpBtns ? (
          <div className="react-chat-scroll-jump-group" aria-label="快速滚动">
            {showScrollTopBtn ? (
              <button
                type="button"
                className="react-chat-scroll-jump-btn"
                onClick={scrollToTop}
                title="到顶部"
                aria-label="滚动到顶部"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            ) : null}
            {showScrollBottomBtn ? (
              <button
                type="button"
                className="react-chat-scroll-jump-btn"
                onClick={() => scrollToBottom({ stick: true })}
                title="到底部"
                aria-label="滚动到底部"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 5v14M19 12l-7 7-7-7" />
                </svg>
              </button>
            ) : null}
          </div>
        ) : null}
        <div
          className="react-chat-subtask-modal-content"
          ref={scrollRef}
          onScroll={onScroll}
        >
          <div className={`msg-list${rowTimeLeft ? ' msg-list--trail-times' : ''}`}>
            {rows.length === 0 && !sending ? (
              <p className="react-chat-subtask-modal-empty">
                {canCompose
                  ? '暂无对话记录。在下方输入可向子任务 worker 续聊。'
                  : '暂无执行记录。节点开始运行后将显示正文与工具调用。'}
              </p>
            ) : null}
            {(() => {
              const turns = rowTimeLeft
                ? expandRowsToTrailTurns(rows)
                : rows.map((r: any, i: number) => ({
                    id: `${subtaskId}:${i}`,
                    timestamp: r?.timestamp,
                    row: r,
                  }))
              return turns.map((turn, i) => {
                const r = turn.row
                const clock = formatTrailRowClock(turn.timestamp ?? r?.timestamp)
                const isStreaming = streamActive && i === turns.length - 1 && lastStreamableRowIndex(rows) >= 0
                if (!rowTimeLeft) {
                  return (
                    <SubtaskModalMessageRow
                      key={turn.id}
                      row={r}
                      sessionKey={sessionKey}
                      isStreaming={streamActive && i === streamingRowIndex}
                      onOpenWorkspaceFile={onOpenMessageFile}
                    />
                  )
                }
                return (
                  <div className="pro-trail-turn" key={turn.id}>
                    <time
                      className="pro-trail-turn__clock"
                      dateTime={
                        typeof turn.timestamp === 'number'
                          ? new Date(turn.timestamp).toISOString()
                          : String(turn.timestamp || '')
                      }
                      title={clock || undefined}
                    >
                      {clock || '—'}
                    </time>
                    <div className="pro-trail-turn__body">
                      <SubtaskModalMessageRow
                        row={r}
                        sessionKey={sessionKey}
                        isStreaming={!!isStreaming && String(r?.role || '') !== 'user'}
                        hideMetaTime
                        showToolTiming={false}
                        suppressExploringFold
                        onOpenWorkspaceFile={onOpenMessageFile}
                      />
                    </div>
                  </div>
                )
              })
            })()}
            {sending ? (
              <div className="msg msg-ai" aria-live="polite">
                <div className="msg-bubble react-chat-subtask-modal-pending">正在等待子任务回复…</div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {canCompose ? (
        <footer className="react-chat-subtask-modal-composer">
          {composeError ? (
            <p className="react-chat-subtask-modal-compose-error" role="alert">
              {composeError}
            </p>
          ) : null}
          <div className="react-chat-subtask-modal-compose-row">
            <textarea
              className="react-chat-subtask-modal-compose-input"
              rows={2}
              placeholder="继续向该子任务说明修改意见…"
              value={composeText}
              disabled={sending}
              onChange={(e) => onComposeTextChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  onSend()
                }
              }}
            />
            <button
              type="button"
              className="react-chat-modal-btn react-chat-modal-btn--primary"
              disabled={sending || !composeText.trim()}
              onClick={onSend}
            >
              {sending ? '发送中…' : '发送'}
            </button>
          </div>
        </footer>
      ) : null}
    </div>
  )
}

export function SubtaskExecutionDrawer(props: SubtaskExecutionDrawerProps) {
  const {
    open,
    subtaskId,
    mode = 'modal',
    portalTarget = null,
    sessionKey,
    statusClass,
    statusLabel,
    summaryAgent,
    shortTitle,
    rows,
    streamActive = false,
    sending,
    canCompose,
    composeText,
    composeError,
    copyPlainText,
    showDetailButton = true,
    rowTimeLeft = false,
    onClose,
    onOpenDetail,
    onComposeTextChange,
    onSend,
    onOpenMessageFile,
  } = props

  useModalEscapeClose(onClose, { open: open && mode === 'modal', deferToNestedModal: true })

  if (!open) return null

  const header = (
    <div className="react-chat-modal-header react-chat-subtask-modal-header">
      <div className="react-chat-subtask-modal-header-main">
        <div className="react-chat-subtask-modal-header-agent-row">
          <span
            className={`react-chat-subtask-status-light ${statusClass}`}
            title={statusLabel}
            aria-label={`状态：${statusLabel}`}
          />
          {summaryAgent ? (
            <span className="react-chat-subtask-modal-header-agent">
              <span className="react-chat-subtask-agent-ico" aria-hidden>
                <AgentAvatar agent={{ agent_name: summaryAgent }} size={18} />
              </span>
              {summaryAgent}
            </span>
          ) : null}
        </div>
        <div className="react-chat-subtask-modal-title">{shortTitle}</div>
      </div>
      <div className="react-chat-subtask-modal-header-actions">
        {showDetailButton && onOpenDetail ? (
          <button
            type="button"
            className="react-chat-modal-btn react-chat-modal-btn--ghost"
            onClick={onOpenDetail}
          >
            查看详情
          </button>
        ) : null}
        <button
          type="button"
          className="react-chat-modal-btn react-chat-modal-btn--ghost"
          onClick={() => copyToClipboard(copyPlainText)}
        >
          复制
        </button>
        {mode === 'modal' ? (
          <button type="button" className="react-chat-modal-close" onClick={onClose}>
            ×
          </button>
        ) : portalTarget ? null : (
          <button type="button" className="react-chat-modal-btn react-chat-modal-btn--ghost" onClick={onClose}>
            关闭
          </button>
        )}
      </div>
    </div>
  )

  const body = (
    <DrawerBody
      subtaskId={subtaskId}
      sessionKey={sessionKey}
      rows={rows}
      streamActive={streamActive}
      sending={sending}
      canCompose={canCompose}
      composeText={composeText}
      composeError={composeError}
      rowTimeLeft={rowTimeLeft}
      onComposeTextChange={onComposeTextChange}
      onSend={onSend}
      onOpenMessageFile={onOpenMessageFile}
    />
  )

  if (mode === 'drawer') {
    const drawer = (
      <aside
        className={`subtask-execution-drawer${portalTarget ? ' subtask-execution-drawer--embedded' : ''}`}
        role="complementary"
        aria-label="节点执行详情"
      >
        <div className="subtask-execution-drawer-card react-chat-subtask-modal-card">
          {header}
          {body}
        </div>
      </aside>
    )
    if (portalTarget) return createPortal(drawer, portalTarget)
    return drawer
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="react-chat-modal-card react-chat-modal-card--settings react-chat-subtask-modal-card"
        style={{ width: 'min(980px, 96vw)' }}
      >
        {header}
        {body}
      </div>
    </div>,
    document.body,
  )
}

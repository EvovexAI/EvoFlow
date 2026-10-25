/**
 * 员工「执行过程」入口（员工页弹窗 / proactive-run）。
 *
 * **对话体只走 V4**：V4EmployeeProcessPane → V4SessionPaneBridge → V4ZCodeTimeline。
 * 旧 SubtaskExecutionDrawer 行列表已整段挪到
 *   `ProactiveLiveProcessHost.legacy.DISABLED.tsx`（勿 import、勿改对话观感）。
 *
 * 右栏 tab（kind=employeeProcess）请直接挂 V4EmployeeProcessPane，不要绕本文件。
 */
import { createPortal } from 'react-dom'
import { V4EmployeeProcessPane } from '../chat-app/right-stage/v4-employee-process-pane.js'

export type ProactiveLiveProcessHostProps = {
  open: boolean
  agentCode: string
  roleName?: string
  busy?: boolean
  title?: string
  roundId?: string
  taskId?: string
  /** @deprecated 轮询已由 V4EmployeeProcessPane 内部处理，保留以免调用方改签名 */
  pollMs?: number
  /** modal=居中遮罩；drawer=挂到 portalTarget；panel=铺满父容器 */
  mode?: 'modal' | 'drawer' | 'panel'
  portalTarget?: HTMLElement | null
  onClose: () => void
}

export function ProactiveLiveProcessHost({
  open,
  agentCode,
  roleName = '',
  busy = false,
  title,
  roundId,
  taskId = '',
  mode = 'modal',
  portalTarget = null,
  onClose,
}: ProactiveLiveProcessHostProps) {
  const code = String(agentCode || '').trim()
  if (!open || !code) return null

  const pane = (
    <V4EmployeeProcessPane
      agentCode={code}
      roleName={roleName}
      busy={busy}
      title={title}
      roundId={roundId}
      taskId={taskId}
      onClose={onClose}
    />
  )

  if (mode === 'panel') {
    return <div className="flex h-full min-h-0 w-full flex-col">{pane}</div>
  }

  if (mode === 'drawer') {
    const target = portalTarget || (typeof document !== 'undefined' ? document.body : null)
    if (!target) return null
    return createPortal(
      <div className="react-chat-subtask-drawer-host flex h-full min-h-0 w-full flex-col bg-card">
        {pane}
      </div>,
      target,
    )
  }

  // modal
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={String(title || '执行过程')}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex h-[min(86vh,720px)] w-full max-w-3xl min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
        {pane}
      </div>
    </div>,
    document.body,
  )
}

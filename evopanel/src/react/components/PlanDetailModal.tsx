import { createPortal } from 'react-dom'
import { useModalEscapeClose } from '../hooks/useModalEscapeClose.js'
import { PlanDetailView, type StructuredPlanInput } from './PlanDetailView.js'

export type PlanDetailModalProps = {
  open: boolean
  loading: boolean
  error: string
  plan: StructuredPlanInput | null
  onClose: () => void
}

export function PlanDetailModal({ open, loading, error, plan, onClose }: PlanDetailModalProps) {
  useModalEscapeClose(onClose, { open })

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="计划详情"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="react-chat-modal-card react-chat-modal-card--settings react-chat-plan-detail-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="react-chat-modal-header">
          <div className="react-chat-modal-title">任务计划</div>
          <button type="button" className="react-chat-modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="react-chat-modal-body react-chat-plan-detail-modal-body">
          {loading ? <p className="react-chat-plan-detail-modal-status">按会话 thread 加载计划…</p> : null}
          {error ? <p className="react-chat-plan-detail-modal-error">{error}</p> : null}
          {!loading && !error && plan ? (
            <div className="react-chat-plan-detail-modal-md plan-detail-modal-host">
              <PlanDetailView plan={plan} />
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  )
}

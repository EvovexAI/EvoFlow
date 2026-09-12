import { createPortal } from 'react-dom'
import type { CollabSubtaskSnapshot } from '../chat-types.js'
import { useModalEscapeClose } from '../hooks/useModalEscapeClose.js'
import { SubtaskDetailView } from './SubtaskDetailView.js'

type SubtaskOutcome = {
  task_report?: string
  summary?: string
  evidence_paths?: string[]
  status?: string
}

export function SubtaskDetailModal({
  open,
  title,
  subtask,
  outcome,
  onClose,
}: {
  open: boolean
  title?: string
  subtask: CollabSubtaskSnapshot | null
  outcome?: SubtaskOutcome | null
  onClose: () => void
}) {
  useModalEscapeClose(onClose, { open, deferToNestedModal: true })

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="react-chat-modal-overlay react-chat-modal-overlay--nested"
      role="dialog"
      aria-modal="true"
      aria-label="子任务详情"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="react-chat-modal-card react-chat-modal-card--settings react-chat-plan-detail-modal react-chat-subtask-detail-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="react-chat-modal-header">
          <div className="react-chat-modal-title">{title || '子任务详情'}</div>
          <button type="button" className="react-chat-modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="react-chat-modal-body react-chat-plan-detail-modal-body">
          <div className="react-chat-plan-detail-modal-md plan-detail-modal-host">
            <SubtaskDetailView subtask={subtask} outcome={outcome} />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

import { memo } from 'react'
import { createPortal } from 'react-dom'
import { useModalEscapeClose } from '../hooks/useModalEscapeClose.js'
import { ToolApprovalPanel, type ToolApprovalChoice } from './ToolApprovalPanel.js'

type Props = {
  open: boolean
  toolName: string
  summary: string
  detailExtra?: string
  busy?: boolean
  onChoice: (choice: ToolApprovalChoice) => void
  onClose: () => void
}

/** Lightweight fallback host for approval when opened outside the message stream. */
function ToolApprovalModalInner({
  open,
  toolName,
  summary,
  detailExtra,
  busy,
  onChoice,
  onClose,
}: Props) {
  useModalEscapeClose(onClose, { open })

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="react-chat-modal-overlay tool-approval-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="需要权限"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="tool-approval-modal-shell"
        onClick={(e) => e.stopPropagation()}
      >
        <ToolApprovalPanel
          toolName={toolName}
          summary={summary}
          detailExtra={detailExtra}
          busy={busy}
          onConfirm={onChoice}
        />
      </div>
    </div>,
    document.body,
  )
}

export const ToolApprovalModal = memo(ToolApprovalModalInner)
export type { ToolApprovalChoice }

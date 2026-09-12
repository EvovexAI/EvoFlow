import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface KnowledgeMapExpandedModalProps {
  open: boolean
  title: string
  subtitle?: ReactNode
  headerActions?: ReactNode
  onClose: () => void
  children: ReactNode
}

export function KnowledgeMapExpandedModal({
  open,
  title,
  subtitle,
  headerActions,
  onClose,
  children,
}: KnowledgeMapExpandedModalProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="km-expanded-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="km-expanded-panel" onClick={(event) => event.stopPropagation()}>
        <header className="km-expanded-panel-header">
          <div className="km-expanded-panel-title-wrap">
            <div className="km-expanded-panel-title-row">
              <span className="km-expanded-panel-title">{title}</span>
            </div>
            {subtitle ? <div className="km-expanded-panel-subtitle">{subtitle}</div> : null}
          </div>
          <div className="km-header-actions">
            {headerActions}
            <span className="km-header-actions-divider" aria-hidden="true" />
            <button type="button" className="km-icon-btn" title="关闭放大" aria-label="关闭放大" onClick={onClose}>
              ×
            </button>
          </div>
        </header>
        <div className="km-expanded-panel-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

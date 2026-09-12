import { memo, useEffect, useState, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { showChatLightbox } from '../../lib/chat-lightbox.js'
import { resolveMediaAssetSrc } from '../../lib/chat-normalize.js'
import { useModalEscapeClose } from '../hooks/useModalEscapeClose.js'

type Props = {
  open: boolean
  title: string
  imagePath: string
  outputText: string
  onClose: () => void
}

function ViewImageDetailModalInner({ open, title, imagePath, outputText, onClose }: Props) {
  const [broken, setBroken] = useState(false)
  const src = resolveMediaAssetSrc(imagePath)

  useModalEscapeClose(onClose, { open })

  useEffect(() => {
    if (!open) queueMicrotask(() => setBroken(false))
  }, [open])

  if (!open || typeof document === 'undefined') return null

  const output = String(outputText || '').trim()

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="react-chat-modal-card view-image-detail-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="react-chat-modal-header">
          <span className="read-tool-detail-modal__title">{title}</span>
          <button type="button" className="react-chat-modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="view-image-detail-modal__body">
          {imagePath ? (
            <div className="msg-tool-block msg-tool-block--code">
              <div className="msg-tool-title">图片路径</div>
              <pre>{imagePath}</pre>
            </div>
          ) : null}
          <div className="msg-tool-block msg-tool-block--screenshot view-image-detail-modal__preview">
            <div className="msg-tool-title">图片</div>
            {!src || broken ? (
              <p className="msg-tool-screenshot-error">图片预览失败，请检查路径是否可访问。</p>
            ) : (
              <button
                type="button"
                className="msg-tool-screenshot-btn"
                title="放大查看"
                aria-label="放大查看图片"
                onClick={() => showChatLightbox(src)}
              >
                <img
                  className="msg-tool-screenshot-img"
                  src={src}
                  alt={title}
                  loading="lazy"
                  onError={(_e: SyntheticEvent<HTMLImageElement>) => setBroken(true)}
                />
              </button>
            )}
          </div>
          <div className="msg-tool-block msg-tool-block--code view-image-detail-modal__output">
            <div className="msg-tool-title">视觉分析</div>
            <pre>{output || '无返回'}</pre>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export const ViewImageDetailModal = memo(ViewImageDetailModalInner)

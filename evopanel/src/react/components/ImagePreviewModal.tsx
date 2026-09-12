import { createPortal } from 'react-dom'
import { memo, useCallback, useEffect, useState } from 'react'
import { ObjectUrlImg } from './ObjectUrlImg.js'

export type ImagePreviewItem = {
  /** File 对象（blob 粘贴/上传），二者其一 */
  file?: File
  /** 本地/工作区路径（Tauri 拖入等），二者其一；可用 resolveChatImageSrc 转成可加载 src */
  src?: string
  name: string
}

export type ImagePreviewModalProps = {
  images: ImagePreviewItem[]
  /** 初始展示索引 */
  index: number
  onClose: () => void
  /** 可选：移除当前图片 */
  onRemove?: (index: number) => void
}

function ImagePreviewModalInner({
  images,
  index,
  onClose,
  onRemove,
}: ImagePreviewModalProps) {
  const [current, setCurrent] = useState(index)
  const total = images.length
  const safeCurrent = total > 0 ? Math.min(current, total - 1) : 0

  const goPrev = useCallback(() => {
    setCurrent((c) => (c - 1 + total) % total)
  }, [total])

  const goNext = useCallback(() => {
    setCurrent((c) => (c + 1) % total)
  }, [total])

  useEffect(() => {
    if (total === 0) onClose()
  }, [total, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') goPrev()
      else if (e.key === 'ArrowRight') goNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, goPrev, goNext])

  if (typeof document === 'undefined') return null
  if (total === 0) return null

  const item = images[safeCurrent]
  if (!item) return null

  return createPortal(
    <div
      className="react-chat-image-preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="react-chat-image-preview-content" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="react-chat-image-preview-close"
          onClick={onClose}
          aria-label="关闭"
        >
          ×
        </button>
        <div className="react-chat-image-preview-stage">
          {item.src ? (
            <img src={item.src} alt={item.name} className="react-chat-image-preview-img" />
          ) : item.file ? (
            <ObjectUrlImg file={item.file} alt={item.name} className="react-chat-image-preview-img" />
          ) : null}
        </div>
        <div className="react-chat-image-preview-info">
          <span className="react-chat-image-preview-name" title={item.name}>
            {item.name}
          </span>
          <span className="react-chat-image-preview-counter">
            {safeCurrent + 1} / {total}
          </span>
        </div>
        {onRemove ? (
          <button
            type="button"
            className="react-chat-image-preview-remove"
            onClick={() => {
              onRemove(safeCurrent)
            }}
          >
            移除
          </button>
        ) : null}
      </div>
      {total > 1 ? (
        <>
          <button
            type="button"
            className="react-chat-image-preview-nav react-chat-image-preview-nav--prev"
            onClick={goPrev}
            aria-label="上一张"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <button
            type="button"
            className="react-chat-image-preview-nav react-chat-image-preview-nav--next"
            onClick={goNext}
            aria-label="下一张"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </>
      ) : null}
    </div>,
    document.body,
  )
}

export const ImagePreviewModal = memo(ImagePreviewModalInner)

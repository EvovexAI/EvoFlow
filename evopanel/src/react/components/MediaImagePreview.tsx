import { useState, type SyntheticEvent } from 'react'
import { showChatLightbox } from '../../lib/chat-lightbox.js'
import { parseMediaImagePreview } from '../../lib/chat-normalize.js'

export type MediaImagePreviewProps = {
  output: unknown
  toolName?: string
}

/** Inline preview for media_image_generate / media_task_wait image results (absolute_path). */
export function MediaImagePreview({ output, toolName }: MediaImagePreviewProps) {
  const preview = parseMediaImagePreview(output, toolName)
  const [broken, setBroken] = useState(false)

  if (!preview?.src) return null

  const onImgError = (_e: SyntheticEvent<HTMLImageElement>) => {
    setBroken(true)
  }

  return (
    <div className="msg-tool-block msg-tool-block--screenshot msg-tool-block--media-image">
      {broken ? (
        <p className="msg-tool-screenshot-error">
          图片预览失败，请尝试
          {preview.remoteUrl ? (
            <>
              {' '}
              <a href={preview.remoteUrl} target="_blank" rel="noopener noreferrer">
                在线链接
              </a>
            </>
          ) : null}
        </p>
      ) : (
        <button
          type="button"
          className="msg-tool-screenshot-btn"
          title="放大查看"
          aria-label="放大查看生成的图片"
          onClick={() => showChatLightbox(preview.src)}
        >
          <img
            className="msg-tool-screenshot-img"
            src={preview.src}
            alt={preview.alt || 'generated image'}
            loading="lazy"
            onError={onImgError}
          />
        </button>
      )}
    </div>
  )
}

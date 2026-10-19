import { memo, useState, type SyntheticEvent } from 'react'
import { showChatLightbox } from '../../lib/chat-lightbox.js'
import { resolveMediaAssetSrc } from '../../lib/chat-normalize.js'

type Props = {
  imagePath: string
  /** 可选：视觉分析结果摘要，挂在图下方 */
  caption?: string
  alt?: string
}

/**
 * view_image 工具结果：把图片挂在工具卡下方（对齐 media_image_generate / 浏览器截图）。
 * 点击仍走 lightbox；完整分析文本继续由 ViewImageDetailModal 承接。
 */
function ViewImageInlinePreviewInner({ imagePath, caption, alt }: Props) {
  const [broken, setBroken] = useState(false)
  const src = resolveMediaAssetSrc(imagePath)
  if (!imagePath) return null

  const title = alt || imagePath.split(/[\\/]/).pop() || '图片'

  return (
    <div
      className="msg-tool-block msg-tool-block--screenshot msg-tool-block--view-image"
      data-testid="view-image-inline-preview"
    >
      {!src || broken ? (
        <p className="msg-tool-screenshot-error">图片预览失败，请检查路径是否可访问。</p>
      ) : (
        <button
          type="button"
          className="msg-tool-screenshot-btn"
          title="放大查看"
          aria-label={`放大查看 ${title}`}
          onClick={() => showChatLightbox(src)}
        >
          <img
            className="msg-tool-screenshot-img"
            src={src}
            alt={title}
            loading="lazy"
            onError={(_e: SyntheticEvent<HTMLImageElement>) => setBroken(true)}
          />
          <span className="msg-tool-screenshot-hint">点击放大</span>
        </button>
      )}
      {caption ? <p className="msg-tool-screenshot-summary">{caption}</p> : null}
    </div>
  )
}

export const ViewImageInlinePreview = memo(ViewImageInlinePreviewInner)

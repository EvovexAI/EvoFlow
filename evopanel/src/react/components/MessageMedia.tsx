import { memo } from 'react'
import { showChatLightbox } from '../../lib/chat-lightbox.js'
import { WorkspaceDeliverableCard } from './WorkspaceDeliverableCard.js'

function imgSrc(img: Record<string, unknown>): string {
  const source = img?.source as { data?: string; media_type?: string } | undefined
  if (source?.data) return `data:${source.media_type || 'image/png'};base64,${source.data}`
  if (img?.data) {
    const mt = (img.mediaType as string) || (img.media_type as string) || 'image/png'
    return `data:${mt};base64,${String(img.data)}`
  }
  const iu = img?.image_url as { url?: string } | undefined
  if (iu?.url) return iu.url
  if (img?.url) return String(img.url)
  return ''
}

function MessageMediaInner({
  images,
  videos,
  audios,
  files,
  onOpenFile,
}: {
  images?: unknown[]
  videos?: unknown[]
  audios?: unknown[]
  files?: unknown[]
  /** 点击文件卡片：在工作区预览弹窗中打开（与工作区树一致） */
  onOpenFile?: (rawUrl: string, name?: string) => void
}) {
  return (
    <>
      {!!images?.length && (
        <div className="react-msg-media-row">
          {images.map((img, i) => {
            const src = imgSrc(img as Record<string, unknown>)
            if (!src) return null
            const stableKey = `${i}-${src.slice(0, 96)}`
            return (
              <img
                key={stableKey}
                className="msg-img"
                src={src}
                alt=""
                onClick={() => showChatLightbox(src)}
              />
            )
          })}
        </div>
      )}
      {!!videos?.length && (
        <div className="react-msg-media-row">
          {videos.map((v, i) => {
            const o = v as { data?: string; mediaType?: string; url?: string }
            const src = o.data
              ? `data:${o.mediaType || 'video/mp4'};base64,${o.data}`
              : o.url || ''
            if (!src) return null
            const stableKey = `${i}-${src.slice(0, 96)}`
            return (
              <video key={stableKey} className="msg-video" src={src} controls playsInline preload="metadata" />
            )
          })}
        </div>
      )}
      {!!audios?.length && (
        <div className="react-msg-media-row">
          {audios.map((a, i) => {
            const o = a as { data?: string; mediaType?: string; url?: string }
            const src = o.data
              ? `data:${o.mediaType || 'audio/mpeg'};base64,${o.data}`
              : o.url || ''
            if (!src) return null
            const stableKey = `${i}-${src.slice(0, 96)}`
            return <audio key={stableKey} className="msg-audio" src={src} controls preload="metadata" />
          })}
        </div>
      )}
      {!!files?.length && (
        <div className="react-msg-files react-msg-files--deliverables">
          {files.map((f, i) => {
            const o = f as { url?: string; name?: string; path?: string }
            const rawHref = String(o.url || o.path || '').trim()
            const label = o.name || '文件'
            const stableKey = `${i}-${rawHref.slice(0, 96) || label}`
            if (!rawHref) return null
            return (
              <WorkspaceDeliverableCard
                key={stableKey}
                path={rawHref}
                name={label}
                onPreview={onOpenFile}
                variant="card"
              />
            )
          })}
        </div>
      )}
    </>
  )
}

export const MessageMedia = memo(MessageMediaInner)

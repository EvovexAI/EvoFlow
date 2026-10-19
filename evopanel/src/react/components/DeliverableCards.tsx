import { memo, useState, type ReactNode, type SyntheticEvent } from 'react'
import { showChatLightbox } from '../../lib/chat-lightbox.js'
import { resolveMediaAssetSrc } from '../../lib/chat-normalize.js'
import type { TurnDeliverable } from '../../lib/deliverable-mentions.js'

/** 各交付物类型的 16×16 线性图标（lucide 风格，stroke 用 currentColor）。 */
const KIND_ICONS: Record<string, ReactNode> = {
  web: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </>
  ),
  video: (
    <>
      <rect x="2" y="5" width="14" height="14" rx="2" />
      <polygon points="22 8 16 12 22 16 22 8" />
    </>
  ),
  audio: (
    <>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>
  ),
  doc: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </>
  ),
  data: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
    </>
  ),
  code: (
    <>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  ),
}

function DeliverableFileTile({
  item,
  onOpenFile,
}: {
  item: TurnDeliverable
  onOpenFile?: (rawPath: string, displayName?: string) => void
}) {
  return (
    <button
      type="button"
      className="evf-deliverable-tile"
      title={item.path}
      onClick={() => onOpenFile?.(item.path, item.name)}
    >
      <span className={`evf-deliverable-icon evf-deliverable-icon--${item.kind}`} aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {KIND_ICONS[item.kind] ?? KIND_ICONS.file}
        </svg>
      </span>
      <span className="evf-deliverable-meta">
        <span className="evf-deliverable-name">{item.name}</span>
        <span className="evf-deliverable-kind">{item.label}</span>
      </span>
    </button>
  )
}

function DeliverableImageCard({
  item,
  onOpenFile,
}: {
  item: TurnDeliverable
  onOpenFile?: (rawPath: string, displayName?: string) => void
}) {
  const [broken, setBroken] = useState(false)
  const src = resolveMediaAssetSrc(item.path)
  if (!src || broken) {
    return <DeliverableFileTile item={item} onOpenFile={onOpenFile} />
  }
  return (
    <div className="evf-deliverable-media" data-testid="deliverable-image">
      <button
        type="button"
        className="evf-deliverable-media-btn"
        title={item.path}
        aria-label={`放大查看 ${item.name}`}
        onClick={() => showChatLightbox(src)}
      >
        <img
          className="evf-deliverable-media-img"
          src={src}
          alt={item.name}
          loading="lazy"
          onError={(_e: SyntheticEvent<HTMLImageElement>) => setBroken(true)}
        />
      </button>
      <button
        type="button"
        className="evf-deliverable-media-caption"
        title={item.path}
        onClick={() => onOpenFile?.(item.path, item.name)}
      >
        <span className="evf-deliverable-name">{item.name}</span>
        <span className="evf-deliverable-kind">{item.label}</span>
      </button>
    </div>
  )
}

function DeliverableVideoCard({
  item,
  onOpenFile,
}: {
  item: TurnDeliverable
  onOpenFile?: (rawPath: string, displayName?: string) => void
}) {
  const src = resolveMediaAssetSrc(item.path)
  if (!src) {
    return <DeliverableFileTile item={item} onOpenFile={onOpenFile} />
  }
  return (
    <div className="evf-deliverable-media" data-testid="deliverable-video">
      <video className="evf-deliverable-media-video" src={src} controls preload="metadata" />
      <button
        type="button"
        className="evf-deliverable-media-caption"
        title={item.path}
        onClick={() => onOpenFile?.(item.path, item.name)}
      >
        <span className="evf-deliverable-name">{item.name}</span>
        <span className="evf-deliverable-kind">{item.label}</span>
      </button>
    </div>
  )
}

function DeliverableAudioCard({
  item,
  onOpenFile,
}: {
  item: TurnDeliverable
  onOpenFile?: (rawPath: string, displayName?: string) => void
}) {
  const src = resolveMediaAssetSrc(item.path)
  if (!src) {
    return <DeliverableFileTile item={item} onOpenFile={onOpenFile} />
  }
  return (
    <div className="evf-deliverable-media evf-deliverable-media--audio" data-testid="deliverable-audio">
      <audio className="evf-deliverable-media-audio" src={src} controls preload="metadata" />
      <button
        type="button"
        className="evf-deliverable-media-caption"
        title={item.path}
        onClick={() => onOpenFile?.(item.path, item.name)}
      >
        <span className="evf-deliverable-name">{item.name}</span>
        <span className="evf-deliverable-kind">{item.label}</span>
      </button>
    </div>
  )
}

/**
 * 回合末尾交付物：图片/视频/音频直接内嵌展示（ZCode 式直观预览），
 * 其余类型保持文件卡，点击走 onOpenFile。
 */
function DeliverableCardsInner({
  items,
  onOpenFile,
}: {
  items: readonly TurnDeliverable[]
  onOpenFile?: (rawPath: string, displayName?: string) => void
}) {
  if (items.length === 0) return null

  const media = items.filter((it) => it.kind === 'image' || it.kind === 'video' || it.kind === 'audio')
  const files = items.filter((it) => it.kind !== 'image' && it.kind !== 'video' && it.kind !== 'audio')

  return (
    <section className="evf-deliverables" data-testid="deliverable-cards">
      <div className="evf-deliverables-header">
        <span className="evf-deliverables-label">
          {items.length === 1 ? '1 个产物' : `${items.length} 个产物`}
        </span>
      </div>
      {media.length > 0 ? (
        <div className="evf-deliverables-media">
          {media.map((it) => {
            if (it.kind === 'image') {
              return <DeliverableImageCard key={it.path} item={it} onOpenFile={onOpenFile} />
            }
            if (it.kind === 'video') {
              return <DeliverableVideoCard key={it.path} item={it} onOpenFile={onOpenFile} />
            }
            return <DeliverableAudioCard key={it.path} item={it} onOpenFile={onOpenFile} />
          })}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="evf-deliverables-grid">
          {files.map((it) => (
            <DeliverableFileTile key={it.path} item={it} onOpenFile={onOpenFile} />
          ))}
        </div>
      ) : null}
    </section>
  )
}

export const DeliverableCards = memo(DeliverableCardsInner)

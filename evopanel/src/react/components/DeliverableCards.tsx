import { memo, type ReactNode } from 'react'
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

/**
 * 回合末尾的交付物卡片墙：@@路径@@ 聚合，ZCode 产物卡形态
 * （类型图标 + 文件名 + 类型角标），点击走 onOpenFile 打开预览。
 */
function DeliverableCardsInner({
  items,
  onOpenFile,
}: {
  items: readonly TurnDeliverable[]
  onOpenFile?: (rawPath: string, displayName?: string) => void
}) {
  if (items.length === 0) return null
  return (
    <section className="evf-deliverables" data-testid="deliverable-cards">
      <div className="evf-deliverables-header">
        <span className="evf-deliverables-label">
          {items.length === 1 ? '1 个产物' : `${items.length} 个产物`}
        </span>
      </div>
      <div className="evf-deliverables-grid">
        {items.map((it) => (
          <button
            key={it.path}
            type="button"
            className="evf-deliverable-tile"
            title={it.path}
            onClick={() => onOpenFile?.(it.path, it.name)}
          >
            <span className={`evf-deliverable-icon evf-deliverable-icon--${it.kind}`} aria-hidden="true">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {KIND_ICONS[it.kind] ?? KIND_ICONS.file}
              </svg>
            </span>
            <span className="evf-deliverable-meta">
              <span className="evf-deliverable-name">{it.name}</span>
              <span className="evf-deliverable-kind">{it.label}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

export const DeliverableCards = memo(DeliverableCardsInner)

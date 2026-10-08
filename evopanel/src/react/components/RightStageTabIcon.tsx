import type { ReactNode } from 'react'
import { normalizeRightStageKind } from '../../lib/right-stage/right-stage-types.js'

/** kind → 16px 线性图标（lucide 风格，stroke 用 currentColor）。 */
const KIND_TAB_ICONS: Record<string, ReactNode> = {
  browser: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  'web-embed': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  'collab-workflow': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 7h4v4H7zM13 13h4v4h-4z" />
    </>
  ),
  'mind-map': (
    <>
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="19" cy="6" r="2.5" />
      <circle cx="19" cy="18" r="2.5" />
      <path d="M7.3 11 16.7 6.8M7.3 13l9.4 4.2" />
    </>
  ),
  workspace: (
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  ),
  write: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  ),
  'platform-feedback': (
    <>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M8 21h8" />
    </>
  ),
  'news-dashboard': (
    <>
      <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2z" />
      <path d="M18 14h-8M15 18h-5M10 6h8v4h-8z" />
    </>
  ),
}

export function KindTabIcon({ kind }: { kind: string }) {
  const k = normalizeRightStageKind(kind)
  return (
    <span className="react-chat-stage-tab-icon" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width="13"
        height="13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {KIND_TAB_ICONS[k] ?? KIND_TAB_ICONS.browser}
      </svg>
    </span>
  )
}

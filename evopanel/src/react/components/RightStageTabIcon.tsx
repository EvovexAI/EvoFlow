import { useEffect, useState, type ReactNode } from 'react'
import { normalizeRightStageKind } from '../../lib/right-stage/right-stage-types.js'
import { EmployeeStageAvatar } from './EmployeeStageAvatar.js'
import { XiaomiStageAvatar } from './XiaomiStageAvatar.js'

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
  'workspace-browse': (
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  ),
  write: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="14" y2="17" />
    </>
  ),
  summary: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </>
  ),
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
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
  xiaomi: (
    <>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </>
  ),
}

export function KindTabIcon({
  kind,
  faviconUrl,
  agentCode,
  agentTitle,
}: {
  kind: string
  faviconUrl?: string | null
  /** employeeProcess 页签：显示该员工头像 */
  agentCode?: string | null
  agentTitle?: string | null
}) {
  const k = normalizeRightStageKind(kind)
  const src = String(faviconUrl || '').trim()
  const empCode = String(agentCode || '').trim()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [src])
  if (k === 'xiaomi') {
    return (
      <span className="react-chat-stage-tab-icon react-chat-stage-tab-icon--avatar" aria-hidden="true">
        <XiaomiStageAvatar size={14} />
      </span>
    )
  }
  if (k === 'employeeProcess' && empCode) {
    return (
      <span className="react-chat-stage-tab-icon react-chat-stage-tab-icon--avatar" aria-hidden="true">
        <EmployeeStageAvatar
          agentCode={empCode}
          title={String(agentTitle || '').trim() || undefined}
          size={14}
        />
      </span>
    )
  }
  if (k === 'browser' && src && !failed) {
    return (
      <span className="react-chat-stage-tab-icon" aria-hidden="true">
        <img
          key={src}
          src={src}
          alt=""
          className="react-chat-stage-tab-favicon"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </span>
    )
  }
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

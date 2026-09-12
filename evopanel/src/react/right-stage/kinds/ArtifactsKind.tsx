import { memo, useState } from 'react'
import type { RightStageSurface } from '../../../lib/right-stage/right-stage-types.js'
import {
  chatArtifactDisplayLabel,
  normalizeChatArtifacts,
  type ChatArtifact,
} from '../../lib/chat-artifact.js'
import {
  ArtifactContextMenuPortal,
  type ArtifactContextMenuState,
} from '../../components/ArtifactContextMenuPortal.js'

function formatArtifactTime(isoStr?: string): string {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  if (isNaN(d.getTime())) return ''
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  return `${hh}:${mm}`
}

function ArtifactsKindInner({
  surface,
  onClose,
  onOpenFile,
  onRevealFile,
}: {
  surface: RightStageSurface
  onClose?: () => void
  onOpenFile?: (path: string, name?: string) => void
  onRevealFile?: (path: string, name?: string) => void
}) {
  const data = surface.data || {}
  const items = normalizeChatArtifacts(data.items).filter((it) => it.type !== 'platform')
  const focusPath = String(data.focusPath || '').trim()
  const focusId = String(data.focusId || '').trim()
  const [menu, setMenu] = useState<ArtifactContextMenuState | null>(null)

  const openItem = (it: ChatArtifact) => {
    if (it.url && !it.path) {
      try {
        window.open(it.url, '_blank', 'noopener,noreferrer')
      } catch {
        /* ignore */
      }
      return
    }
    if (it.path) onOpenFile?.(it.path, it.name)
  }

  return (
    <>
      <header className="react-chat-collab-exec-panel-header react-chat-artifacts-header">
        <div className="react-chat-artifacts-header-title">
          {surface.title || '本轮产物'}
          {items.length > 0 ? ` ${items.length}` : ''}
        </div>
        {onClose ? (
          <button type="button" className="react-chat-collab-exec-panel-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        ) : null}
      </header>
      <div className="react-chat-collab-exec-panel-body react-chat-artifacts-body">
        {!items.length ? (
          <div className="collab-exec-dag-empty">本轮暂无产物</div>
        ) : (
          <ul className="react-chat-artifacts-list">
            {items.map((it) => {
              const label = chatArtifactDisplayLabel(it)
              const active =
                (focusId && focusId === it.id) || (focusPath && focusPath === (it.path || ''))
              const meta = it.url && !it.path ? it.url : it.path || it.type
              const timeStr = formatArtifactTime(it.updatedAt || it.createdAt)
              return (
                <li key={it.id}>
                  <button
                    type="button"
                    className={`react-chat-artifacts-item${active ? ' is-active' : ''}`}
                    title={meta}
                    onClick={() => openItem(it)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setMenu({ item: it, x: e.clientX, y: e.clientY })
                    }}
                  >
                    <span className="react-chat-artifacts-item-name">{label}</span>
                    <span className="react-chat-artifacts-item-status">
                      {it.type}
                      {it.status === 'updated' ? ' · 已更新' : it.status === 'new' ? ' · 新增' : ''}
                      {timeStr ? ` · ${timeStr}` : ''}
                    </span>
                    <span className="react-chat-artifacts-item-path">{meta}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <ArtifactContextMenuPortal
        menu={menu}
        onClose={() => setMenu(null)}
        onOpen={(item) => openItem(item)}
        onReveal={(item) => {
          if (item.path) onRevealFile?.(item.path, item.name)
        }}
        onOpenUrl={(item) => {
          const url = String(item.url || '').trim()
          if (!url) return
          try {
            window.open(url, '_blank', 'noopener,noreferrer')
          } catch {
            /* ignore */
          }
        }}
      />
    </>
  )
}

export const ArtifactsKind = memo(ArtifactsKindInner)

/** @deprecated use ChatArtifact from chat-artifact.ts */
export type ArtifactListItem = {
  path: string
  status?: 'new' | 'updated'
}

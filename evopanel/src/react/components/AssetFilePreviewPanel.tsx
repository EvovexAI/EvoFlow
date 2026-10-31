import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/tauri-api.js'
import { assetsHrefForPath } from '../lib/evo-asset-citation.js'
import { V4PreviewPane } from '../chat-app/right-stage/v4-preview-pane.js'
import { inferCodeLanguage } from '@zcode/ui/lib/codeViewer.js'

type Props = {
  entityType: string
  entityId: string
  path: string
  name?: string
  onClose?: () => void
}

function basename(p: string): string {
  const parts = String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  return parts[parts.length - 1] || p || '资产'
}

/**
 * Right-stage preview for entity asset vault files (memory/craft/profile).
 * Loads via assets API — never against the chat workspace root.
 */
export function AssetFilePreviewPanel({
  entityType,
  entityId,
  path: rawPath,
  name: displayName,
  onClose,
}: Props) {
  const path = String(rawPath || '')
    .replace(/\\/g, '/')
    .replace(/^\//, '')
    .trim()
  const name = String(displayName || '').trim() || basename(path)
  const et = String(entityType || 'user').trim() || 'user'
  const eid = String(entityId || 'user').trim() || 'user'
  const ticketRef = useRef(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState('')

  useEffect(() => {
    if (!path) {
      setLoading(false)
      setError('缺少资产路径')
      return
    }
    const ticket = ++ticketRef.current
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const data = await api.assetsReadFile({
          entityType: et,
          entityId: eid,
          path,
        })
        if (ticket !== ticketRef.current) return
        setContent(String(data?.content ?? ''))
        setLoading(false)
      } catch (e: unknown) {
        if (ticket !== ticketRef.current) return
        setContent('')
        setError(String((e as { message?: string })?.message || e || '读取失败'))
        setLoading(false)
      }
    })()
  }, [et, eid, path])

  const assetsHref = assetsHrefForPath(path, { entityType: et, entityId: eid })

  if (loading) {
    return (
      <div className="react-chat-asset-preview-panel flex h-full min-h-0 flex-col">
        <header className="react-chat-asset-preview-head">
          <span className="react-chat-asset-preview-badge">资产</span>
          <span className="min-w-0 truncate" title={path}>
            {name}
          </span>
        </header>
        <div className="flex flex-1 items-center justify-center text-sm opacity-60">加载中…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="react-chat-asset-preview-panel flex h-full min-h-0 flex-col">
        <header className="react-chat-asset-preview-head">
          <span className="react-chat-asset-preview-badge">资产</span>
          <span className="min-w-0 truncate" title={path}>
            {name}
          </span>
          {onClose ? (
            <button type="button" className="ac-btn-ghost ml-auto" onClick={onClose}>
              关闭
            </button>
          ) : null}
        </header>
        <div className="flex flex-1 flex-col gap-3 p-4 text-sm">
          <p className="text-destructive whitespace-pre-wrap">{error}</p>
          <p className="opacity-70">路径：{path}</p>
          <a className="text-icon-blue underline-offset-2 hover:underline" href={assetsHref}>
            在资产中心打开
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="react-chat-asset-preview-panel flex h-full min-h-0 flex-col">
      <header className="react-chat-asset-preview-head">
        <span className="react-chat-asset-preview-badge">资产</span>
        <span className="min-w-0 truncate" title={path}>
          {name}
        </span>
        <a
          className="ml-auto shrink-0 text-[12px] text-icon-blue underline-offset-2 hover:underline"
          href={assetsHref}
          title="在资产中心打开"
        >
          资产中心
        </a>
      </header>
      <div className="min-h-0 flex-1">
        <V4PreviewPane
          source={{
            type: 'text',
            title: name,
            path,
            content,
            language: inferCodeLanguage(path, content),
          }}
          onClose={onClose || (() => {})}
        />
      </div>
    </div>
  )
}

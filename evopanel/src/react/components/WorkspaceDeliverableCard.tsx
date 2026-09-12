/**
 * 聊天 / 工具行共用的产出文件操作：预览 · 复制路径 · 打开位置
 */
import { memo, useCallback, type MouseEvent } from 'react'
import { toast } from '../../components/toast.js'
import { getChatWorkspaceRoot } from '../../lib/chat-workspace-context.js'
import {
  resolveTaskOutputAbsolutePath,
  revealTaskOutputInFileManager,
} from '../../lib/task-output-preview.js'
import { openWorkspaceFilePreviewModal } from '../../lib/mount-workspace-file-preview.js'

function basename(path: string): string {
  const parts = String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  return parts[parts.length - 1] || path || '文件'
}

function shortenPath(path: string, max = 64): string {
  const s = String(path || '').replace(/\\/g, '/')
  if (s.length <= max) return s
  return `…${s.slice(-(max - 1))}`
}

export type WorkspaceDeliverableCardProps = {
  path: string
  name?: string
  /** 优先用聊天侧已有预览；不传则走共享 modal */
  onPreview?: (path: string, name?: string) => void
  /** compact：工具行旁按钮；card：消息底部文件卡 */
  variant?: 'card' | 'compact'
  className?: string
}

async function resolveWorkspaceHint(): Promise<string> {
  return String(getChatWorkspaceRoot() || '').trim()
}

export const WorkspaceDeliverableCard = memo(function WorkspaceDeliverableCard({
  path,
  name,
  onPreview,
  variant = 'card',
  className = '',
}: WorkspaceDeliverableCardProps) {
  const rawPath = String(path || '').trim()
  const title = String(name || '').trim() || basename(rawPath)
  const isUrl = /^https?:\/\//i.test(rawPath)

  const stop = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handlePreview = useCallback(
    async (e: MouseEvent) => {
      stop(e)
      if (!rawPath) return
      if (isUrl) {
        window.open(rawPath, '_blank', 'noopener,noreferrer')
        return
      }
      if (onPreview) {
        onPreview(rawPath, title)
        return
      }
      try {
        const root = await resolveWorkspaceHint()
        openWorkspaceFilePreviewModal({
          workspaceRoot: root || rawPath.replace(/[\\/][^\\/]+$/, '') || '',
          path: rawPath,
          name: title,
          workspaceScopeOpts: root ? { configuredRoot: root } : undefined,
        })
      } catch (err) {
        toast(`无法预览：${String((err as Error)?.message || err)}`, 'error')
      }
    },
    [isUrl, onPreview, rawPath, title],
  )

  const handleCopy = useCallback(
    async (e: MouseEvent) => {
      stop(e)
      if (!rawPath) return
      try {
        const root = await resolveWorkspaceHint()
        let text = rawPath
        if (!isUrl) {
          try {
            text = await resolveTaskOutputAbsolutePath({ path: rawPath, workspaceRoot: root })
          } catch {
            /* keep raw */
          }
        }
        await navigator.clipboard.writeText(text)
        toast('已复制路径', 'success')
      } catch (err) {
        toast(`复制失败：${String((err as Error)?.message || err)}`, 'error')
      }
    },
    [isUrl, rawPath],
  )

  const handleReveal = useCallback(
    async (e: MouseEvent) => {
      stop(e)
      if (!rawPath || isUrl) return
      try {
        const root = await resolveWorkspaceHint()
        await revealTaskOutputInFileManager({ path: rawPath, workspaceRoot: root })
        toast('已在文件管理器中打开', 'success')
      } catch (err) {
        toast(String((err as Error)?.message || err), 'error')
      }
    },
    [isUrl, rawPath],
  )

  if (!rawPath) return null

  if (variant === 'compact') {
    return (
      <span className={`msg-deliverable-actions ${className}`.trim()}>
        <button type="button" className="msg-deliverable-action" onClick={handlePreview}>
          预览
        </button>
        <button type="button" className="msg-deliverable-action msg-deliverable-action--muted" onClick={handleCopy}>
          复制
        </button>
        {!isUrl ? (
          <button
            type="button"
            className="msg-deliverable-action msg-deliverable-action--muted"
            title="在本地文件管理器中显示"
            onClick={handleReveal}
          >
            打开位置
          </button>
        ) : null}
      </span>
    )
  }

  return (
    <div className={`msg-deliverable-card ${className}`.trim()}>
      <button type="button" className="msg-deliverable-card-main" onClick={handlePreview} title={rawPath}>
        <span className="msg-deliverable-card-name">{title}</span>
        <span className="msg-deliverable-card-path">{shortenPath(rawPath)}</span>
      </button>
      <div className="msg-deliverable-card-actions">
        <button type="button" className="msg-deliverable-action" onClick={handlePreview}>
          预览
        </button>
        <button type="button" className="msg-deliverable-action msg-deliverable-action--muted" onClick={handleCopy}>
          复制路径
        </button>
        {isUrl ? (
          <a className="msg-deliverable-action" href={rawPath} target="_blank" rel="noopener noreferrer">
            打开
          </a>
        ) : (
          <button
            type="button"
            className="msg-deliverable-action msg-deliverable-action--muted"
            title="在本地文件管理器中显示"
            onClick={handleReveal}
          >
            打开位置
          </button>
        )}
      </div>
    </div>
  )
})

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { normalizeWorkspaceReadPath } from '../../lib/workspace-api-scope.js'
import { buildWorkspaceMediaPreviewFields, isWorkspaceMediaBinaryPath } from '../../lib/chat-image-src.js'
import { resolveWritePreviewPath } from '../../lib/workspace-preview-path.js'
import { useModalEscapeClose } from '../hooks/useModalEscapeClose.js'
import { WorkspaceFilePreviewPane, type WorkspacePreviewState } from './WorkspaceFilePreviewPane.js'

function basename(p: string): string {
  const s = String(p || '').replace(/\\/g, '/')
  const parts = s.split('/').filter(Boolean)
  return parts[parts.length - 1] || s
}

function formatWorkspaceReadError(msg: string, path: string): string {
  const m = String(msg || '').trim()
  const p = String(path || '').replace(/\\/g, '/')
  if (/file not found/i.test(m)) {
    return p
      ? `文件尚未生成或路径不正确：\n${p}\n\n请确认任务已成功执行并写入交付文件，或点击「重试」。`
      : '文件尚未生成或路径不正确。请确认任务已成功执行并写入交付文件。'
  }
  if (m.includes('Not Found') && !m.includes('file not found')) {
    return '预览暂不可用，请稍后重试'
  }
  return m
}

const PREVIEW_ZOOM_MIN = 0.75
const PREVIEW_ZOOM_MAX = 2
const PREVIEW_ZOOM_STEP = 0.1
const PREVIEW_ZOOM_DEFAULT = 1

function clampPreviewZoom(z: number): number {
  return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, Math.round(z * 100) / 100))
}

type Props = {
  workspaceRoot: string
  threadId?: string
  /** Passed to workspace API scope (configuredRoot / useVirtualPaths). */
  workspaceScopeOpts?: { configuredRoot?: string; useVirtualPaths?: boolean }
  path: string
  name?: string
  poll?: boolean
  onClose: () => void
}

export function WorkspaceFilePreviewModal({
  workspaceRoot,
  threadId,
  workspaceScopeOpts,
  path: rawPath,
  name: displayName,
  poll = false,
  onClose,
}: Props) {
  const root = String(workspaceRoot || '').trim()
  const tid = String(threadId || '').trim()
  const path = normalizeWorkspaceReadPath(resolveWritePreviewPath(rawPath) || rawPath, root)
  const name = displayName || basename(path)
  const ticketRef = useRef(0)
  const [contentZoom, setContentZoom] = useState(PREVIEW_ZOOM_DEFAULT)
  const zoomPercent = useMemo(() => Math.round(contentZoom * 100), [contentZoom])

  const zoomOut = useCallback(() => {
    setContentZoom((z) => clampPreviewZoom(z - PREVIEW_ZOOM_STEP))
  }, [])

  const zoomIn = useCallback(() => {
    setContentZoom((z) => clampPreviewZoom(z + PREVIEW_ZOOM_STEP))
  }, [])

  const [preview, setPreview] = useState<WorkspacePreviewState>(() => ({
    path,
    name,
    loading: true,
    content: '',
    error: null,
    binary: false,
    truncated: false,
    size: null,
  }))

  const fetchContent = useCallback(
    async (ticket: number, opts?: { silent?: boolean }) => {
      const silent = !!opts?.silent
      const mediaFields = buildWorkspaceMediaPreviewFields(root, path)
      if (mediaFields) {
        setPreview({
          path,
          name,
          loading: false,
          content: '',
          error: null,
          binary: false,
          truncated: false,
          size: null,
          mediaSrc: mediaFields.mediaSrc,
          // @ts-ignore
          mediaKind: mediaFields.mediaKind,
        })
        return
      }
      if (!silent) {
        setPreview((prev) =>
          prev.path === path
            ? { ...prev, loading: true, error: null }
            : {
                path,
                name,
                loading: true,
                content: '',
                error: null,
                binary: false,
                truncated: false,
                size: null,
              },
        )
      }
      try {
        const { api } = await import('../../lib/tauri-api.js')
        const data = await api.readWorkspaceFile(root, path, tid || undefined, workspaceScopeOpts)
        if (ticketRef.current !== ticket) return
        if (data?.binary) {
          setPreview((prev) => {
            if (silent && prev.binary && prev.path === path) return prev
            return {
              path,
              name,
              loading: false,
              content: '',
              error: null,
              binary: true,
              truncated: false,
              size: data?.size ?? null,
            }
          })
          return
        }
        const nextContent = String(data?.content ?? '')
        const nextTruncated = !!data?.truncated
        const nextSize = data?.size ?? null
        setPreview((prev) => {
          if (
            silent &&
            prev.path === path &&
            !prev.loading &&
            !prev.error &&
            !prev.binary &&
            prev.content === nextContent &&
            prev.truncated === nextTruncated &&
            prev.size === nextSize
          ) {
            return prev
          }
          return {
            path,
            name,
            loading: false,
            content: nextContent,
            error: null,
            binary: false,
            truncated: nextTruncated,
            size: nextSize,
          }
        })
      } catch (e) {
        if (ticketRef.current !== ticket) return
        const msg = String((e as Error)?.message || e || '无法读取文件')
        const errText = formatWorkspaceReadError(msg, path)
        setPreview((prev) => {
          if (silent && prev.error === errText && prev.path === path) return prev
          return {
            path,
            name,
            loading: false,
            content: '',
            error: errText,
            binary: false,
            truncated: false,
            size: null,
          }
        })
      }
    },
    [name, path, root, tid],
  )

  useEffect(() => {
    const ticket = ++ticketRef.current
    void fetchContent(ticket)
    return () => {
      ticketRef.current += 1
    }
  }, [fetchContent, path])

  useEffect(() => {
    if (!poll || preview.loading || preview.streaming || isWorkspaceMediaBinaryPath(path)) return
    const id = window.setInterval(() => {
      void fetchContent(ticketRef.current, { silent: true })
    }, 800)
    return () => window.clearInterval(id)
  }, [poll, preview.loading, preview.streaming, fetchContent])

  useModalEscapeClose(onClose)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault()
          zoomIn()
        } else if (e.key === '-') {
          e.preventDefault()
          zoomOut()
        } else if (e.key === '0') {
          e.preventDefault()
          setContentZoom(PREVIEW_ZOOM_DEFAULT)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomIn, zoomOut])

  const zoomControls = useMemo(
    () => ({
      percent: zoomPercent,
      onZoomOut: zoomOut,
      onZoomIn: zoomIn,
      onReset: () => setContentZoom(PREVIEW_ZOOM_DEFAULT),
      canZoomOut: contentZoom > PREVIEW_ZOOM_MIN + 1e-6,
      canZoomIn: contentZoom < PREVIEW_ZOOM_MAX - 1e-6,
      canReset: contentZoom !== PREVIEW_ZOOM_DEFAULT,
    }),
    [contentZoom, zoomIn, zoomOut, zoomPercent],
  )

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`查看文件 ${name}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="react-chat-modal-card react-chat-workspace-preview-card"
        onClick={(e) => e.stopPropagation()}
      >
        <WorkspaceFilePreviewPane
          preview={preview}
          onClose={onClose}
          contentZoom={contentZoom}
          workspaceRoot={root}
          threadId={tid}
          zoomControls={zoomControls}
          onRetry={() => {
            const ticket = ++ticketRef.current
            void fetchContent(ticket)
          }}
        />
      </div>
    </div>,
    document.body,
  )
}
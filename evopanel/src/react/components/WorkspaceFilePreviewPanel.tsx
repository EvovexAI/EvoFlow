import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { normalizeWorkspaceReadPath } from '../../lib/workspace-api-scope.js'
import { buildWorkspaceMediaPreviewFields, isWorkspaceMediaBinaryPath } from '../../lib/chat-image-src.js'
import { resolveWritePreviewPath } from '../../lib/workspace-preview-path.js'
import {
  WorkspaceFilePreviewPane,
  type WorkspaceFocusAnnotation,
  type WorkspacePreviewState,
} from './WorkspaceFilePreviewPane.js'

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

export type WorkspaceFilePreviewPanelProps = {
  workspaceRoot: string
  threadId?: string
  workspaceScopeOpts?: { configuredRoot?: string; useVirtualPaths?: boolean }
  path: string
  name?: string
  poll?: boolean
  focusLine?: number
  focusEndLine?: number
  focusAnnotation?: WorkspaceFocusAnnotation
  /** 右栏标签条已有关闭；侧栏内可省略关闭钮。 */
  onClose?: () => void
  /** 嵌在右栏时不走弹窗卡片样式。 */
  embedded?: boolean
}

/** 工作区文件 / 图片 / 视频预览正文（右栏标签或弹窗共用）。 */
export function WorkspaceFilePreviewPanel({
  workspaceRoot,
  threadId,
  workspaceScopeOpts,
  path: rawPath,
  name: displayName,
  poll = false,
  focusLine,
  focusEndLine,
  focusAnnotation,
  onClose,
  embedded = false,
}: WorkspaceFilePreviewPanelProps) {
  const root = String(workspaceRoot || '').trim()
  const tid = String(threadId || '').trim()
  const path = normalizeWorkspaceReadPath(resolveWritePreviewPath(rawPath) || rawPath, root)
  const name = displayName || basename(path)
  // 父组件常内联传 workspaceScopeOpts；用原始字段做依赖，避免会话轮询重渲染时反复 read-file
  const configuredRoot = workspaceScopeOpts?.configuredRoot
  const useVirtualPaths = workspaceScopeOpts?.useVirtualPaths
  const ticketRef = useRef(0)
  const unchangedSilentRef = useRef(0)
  const [contentZoom, setContentZoom] = useState(PREVIEW_ZOOM_DEFAULT)
  const [pollActive, setPollActive] = useState(!!poll)
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
  const previewRef = useRef(preview)
  previewRef.current = preview

  useEffect(() => {
    setPollActive(!!poll)
    unchangedSilentRef.current = 0
  }, [poll, path])

  const noteSilentResult = useCallback((unchanged: boolean) => {
    if (!unchanged) {
      unchangedSilentRef.current = 0
      return
    }
    unchangedSilentRef.current += 1
    // 内容已稳定：连续 5 次静默拉取无变化后停轮询（约 4s）
    if (unchangedSilentRef.current >= 5) setPollActive(false)
  }, [])

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
          mediaKind: mediaFields.mediaKind as WorkspacePreviewState['mediaKind'],
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
        const data = await api.readWorkspaceFile(root, path, tid || undefined, {
          configuredRoot,
          useVirtualPaths,
        })
        if (ticketRef.current !== ticket) return
        const prev = previewRef.current
        if (data?.binary) {
          const unchanged = !!(silent && prev.binary && prev.path === path)
          if (silent) noteSilentResult(unchanged)
          if (unchanged) return
          setPreview({
            path,
            name,
            loading: false,
            content: '',
            error: null,
            binary: true,
            truncated: false,
            size: data?.size ?? null,
          })
          return
        }
        const nextContent = String(data?.content ?? '')
        const nextTruncated = !!data?.truncated
        const nextSize = data?.size ?? null
        const unchanged = !!(
          silent &&
          prev.path === path &&
          !prev.loading &&
          !prev.error &&
          !prev.binary &&
          prev.content === nextContent &&
          prev.truncated === nextTruncated &&
          prev.size === nextSize
        )
        if (silent) noteSilentResult(unchanged)
        if (unchanged) return
        setPreview({
          path,
          name,
          loading: false,
          content: nextContent,
          error: null,
          binary: false,
          truncated: nextTruncated,
          size: nextSize,
        })
      } catch (e) {
        if (ticketRef.current !== ticket) return
        const msg = String((e as Error)?.message || e || '无法读取文件')
        const errText = formatWorkspaceReadError(msg, path)
        const prev = previewRef.current
        const unchanged = !!(silent && prev.error === errText && prev.path === path)
        if (silent) noteSilentResult(unchanged)
        if (unchanged) return
        setPreview({
          path,
          name,
          loading: false,
          content: '',
          error: errText,
          binary: false,
          truncated: false,
          size: null,
        })
      }
    },
    [name, path, root, tid, configuredRoot, useVirtualPaths, noteSilentResult],
  )

  useEffect(() => {
    const ticket = ++ticketRef.current
    void fetchContent(ticket)
    return () => {
      ticketRef.current += 1
    }
  }, [fetchContent, path])

  useEffect(() => {
    if (!pollActive || preview.loading || preview.streaming || isWorkspaceMediaBinaryPath(path)) return
    const id = window.setInterval(() => {
      void fetchContent(ticketRef.current, { silent: true })
    }, 800)
    return () => window.clearInterval(id)
  }, [pollActive, preview.loading, preview.streaming, fetchContent, path])

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

  const pane = (
    <WorkspaceFilePreviewPane
      preview={preview}
      // 右栏 embedded 也保留 ×：标签条悬停才出现，用户常找不到关法
      onClose={onClose}
      embedded={embedded}
      contentZoom={contentZoom}
      workspaceRoot={root}
      threadId={tid}
      zoomControls={embedded ? null : zoomControls}
      focusLine={focusLine}
      focusEndLine={focusEndLine}
      focusAnnotation={focusAnnotation}
      onRetry={() => {
        const ticket = ++ticketRef.current
        void fetchContent(ticket)
      }}
    />
  )

  if (embedded) {
    return (
      <div className="react-chat-workspace-preview-stage" role="region" aria-label={`查看文件 ${name}`}>
        {pane}
      </div>
    )
  }

  return pane
}

import { useCallback, useMemo, type CSSProperties } from 'react'
import { formatWorkspacePathForDisplay } from '../../lib/workspace-api-scope.js'
import {
  isWorkspaceAudioPath,
  isWorkspaceImagePath,
  isWorkspaceMediaBinaryPath,
  isWorkspaceVideoPath,
  resolveWorkspaceRelMediaSrc,
} from '../../lib/chat-image-src.js'
import { showChatLightbox } from '../../lib/chat-lightbox.js'
import {
  getBinaryFilePreviewHint,
  isStreamWriteContentDisplayable,
} from '../../lib/workspace-preview-path.js'
import { prepareHtmlSrcDocForPreview } from '../../lib/workspace-html-preview.js'
import { useThrottledValue } from '../hooks/useThrottledValue.js'
import { isStreamThrottleEnabled } from '../lib/stream-throttle-toggle.js'
import {
  isMarkdownDocumentPath,
  MarkdownDocumentView,
} from './MarkdownDocumentView.js'

export type WorkspacePreviewState = {
  path: string
  name: string
  loading: boolean
  content: string
  error: string | null
  binary: boolean
  truncated: boolean
  size: number | null
  /** 图片/视频/音频：直接 serve-file 预览，不走文本读取 */
  mediaSrc?: string | null
  mediaKind?: 'image' | 'video' | 'audio' | null
  /** 工具参数流式生成中（未落盘） */
  streaming?: boolean
}

type PreviewZoomControls = {
  percent: number
  onZoomOut: () => void
  onZoomIn: () => void
  onReset: () => void
  canZoomOut: boolean
  canZoomIn: boolean
  canReset: boolean
}

type Props = {
  preview: WorkspacePreviewState | null
  onClose?: () => void
  compact?: boolean
  /** 弹窗内正文缩放（0.75–2，默认 1） */
  contentZoom?: number
  workspaceRoot?: string
  threadId?: string
  /** 弹窗模式：缩放控件与文件名同一行 */
  zoomControls?: PreviewZoomControls | null
  /**
   * Markdown：是否显示「编辑」并允许改源码。
   * 默认 false（打开 .md 只渲染预览，与验收场景一致）。
   */
  allowMarkdownEdit?: boolean
  /** Markdown 编辑时回调（需配合 allowMarkdownEdit）。 */
  onMarkdownChange?: (text: string) => void
  /** 读取失败时重试（预览弹窗）。 */
  onRetry?: () => void
}

function fileExtLabel(name: string, path: string): string {
  // Prefer whichever string has a real extension — display name may be a title without one.
  for (const candidate of [path, name]) {
    const m = String(candidate || '').match(/\.([a-z0-9]+)$/i)
    if (m) return m[1].toUpperCase()
  }
  return 'FILE'
}

function previewLooksLikeHtml(preview: WorkspacePreviewState): boolean {
  const path = preview.path || ''
  const name = preview.name || ''
  return (
    /\.(html?|htm)$/i.test(path) ||
    /\.(html?|htm)$/i.test(name) ||
    (!!preview.streaming && /^\s*</.test(preview.content || '')) ||
    /<!DOCTYPE|<html/i.test(preview.content || '')
  )
}

export function WorkspaceFilePreviewPane({
  preview,
  onClose,
  compact,
  contentZoom = 1,
  workspaceRoot = '',
  threadId = '',
  zoomControls = null,
  allowMarkdownEdit = false,
  onMarkdownChange,
  onRetry,
}: Props) {
  const zoom = Math.min(2, Math.max(0.75, Number(contentZoom) || 1))
  const zoomStyle = { '--preview-zoom': String(zoom) } as CSSProperties

  const revealInFolder = useCallback(async () => {
    if (!preview?.path) return
    try {
      const { revealTaskOutputInFileManager } = await import('../../lib/task-output-preview.js')
      await revealTaskOutputInFileManager({
        path: preview.path,
        workspaceRoot,
      })
    } catch {
      /* toast handled inside helper */
    }
  }, [preview?.path, workspaceRoot, threadId])
  const isMarkdown = useMemo(
    () =>
      !!(
        preview &&
        (isMarkdownDocumentPath(preview.path) || isMarkdownDocumentPath(preview.name))
      ),
    [preview],
  )
  const isHtml = useMemo(
    () => !!(preview && !preview.binary && !preview.error && !isMarkdown && previewLooksLikeHtml(preview)),
    [preview, isMarkdown],
  )

  const rawContent = preview && !preview.loading && !preview.error && !preview.binary ? preview.content : ''
  const streamBodyReady = useMemo(
    () =>
      !preview?.streaming ||
      isStreamWriteContentDisplayable({
        path: preview.path,
        content: rawContent,
        streaming: true,
      }),
    [preview, rawContent],
  )
  const streamDisplayActive = !!(preview?.streaming && rawContent.length > 0 && streamBodyReady)
  const displayContent = useThrottledValue(rawContent, 200, streamDisplayActive && isStreamThrottleEnabled())
  const htmlSrcDoc = useMemo(
    () => (displayContent ? prepareHtmlSrcDocForPreview(displayContent) : ''),
    [displayContent],
  )
  const htmlLivePreview = isHtml && !preview?.streaming
  const showStreamWaiting = !!(preview?.streaming && !preview.loading && !streamBodyReady && !isHtml)

  if (!preview) return null

  const ext = fileExtLabel(preview.name, preview.path)
  const displayPath = formatWorkspacePathForDisplay(preview.path)
  const mediaSrc =
    preview.mediaSrc ||
    (isWorkspaceMediaBinaryPath(preview.path)
      ? resolveWorkspaceRelMediaSrc(workspaceRoot, preview.path)
      : '')
  const showImage = !!(mediaSrc && (preview.mediaKind === 'image' || isWorkspaceImagePath(preview.path)))
  const showVideo = !!(mediaSrc && (preview.mediaKind === 'video' || isWorkspaceVideoPath(preview.path)))
  const showAudio = !!(mediaSrc && (preview.mediaKind === 'audio' || isWorkspaceAudioPath(preview.path)))

  return (
    <div
      className={`react-chat-workspace-preview-pane${compact ? ' react-chat-workspace-preview-pane--compact' : ''}${
        preview.streaming ? ' is-streaming' : ''
      }${showStreamWaiting ? ' is-waiting' : ''}${zoom !== 1 ? ' has-content-zoom' : ''}`}
      style={zoomStyle}
    >
      <div className="react-chat-workspace-preview-pane-header">
        <div className="react-chat-workspace-preview-pane-heading">
          <span className="react-chat-workspace-preview-pane-icon" aria-hidden>
            {isHtml ? '◇' : '◈'}
          </span>
          <div className="react-chat-workspace-preview-pane-titles">
            <div className="react-chat-workspace-preview-pane-title" title={preview.path || preview.name}>
              {preview.name || '文件预览'}
            </div>
            {displayPath ? (
              <div className="react-chat-workspace-preview-pane-subtitle" title={displayPath}>
                {displayPath}
              </div>
            ) : null}
          </div>
        </div>
        <div className="react-chat-workspace-preview-pane-header-actions">
          <span className="react-chat-workspace-preview-pane-badge">{ext}</span>
          {preview.streaming ? (
            <span className="react-chat-workspace-preview-streaming-label">
              <span className="react-chat-workspace-preview-streaming-dot" aria-hidden />
              生成中
            </span>
          ) : null}
          {zoomControls ? (
            <div className="react-chat-workspace-preview-zoom-inline" aria-label="显示比例">
              <button
                type="button"
                className="react-chat-workspace-preview-zoom-btn"
                aria-label="缩小"
                title="缩小"
                disabled={!zoomControls.canZoomOut}
                onClick={zoomControls.onZoomOut}
              >
                −
              </button>
              <span className="react-chat-workspace-preview-zoom-value" aria-live="polite">
                {zoomControls.percent}%
              </span>
              <button
                type="button"
                className="react-chat-workspace-preview-zoom-btn"
                aria-label="放大"
                title="放大"
                disabled={!zoomControls.canZoomIn}
                onClick={zoomControls.onZoomIn}
              >
                +
              </button>
              <button
                type="button"
                className="react-chat-workspace-preview-zoom-reset"
                title="重置为 100%"
                disabled={!zoomControls.canReset}
                onClick={zoomControls.onReset}
              >
                100%
              </button>
            </div>
          ) : null}
          {preview.path && !/^https?:\/\//i.test(preview.path) ? (
            <button
              type="button"
              className="react-chat-workspace-preview-reveal-btn"
              title="在本地文件管理器中显示"
              aria-label="打开位置"
              onClick={() => void revealInFolder()}
            >
              打开位置
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              className="react-chat-workspace-preview-pane-close"
              onClick={onClose}
              aria-label="关闭预览"
            >
              ×
            </button>
          ) : null}
        </div>
      </div>
      <div className="react-chat-workspace-preview-pane-body">
        {showStreamWaiting ? (
          <div className="react-chat-workspace-preview-waiting">
            <div className="react-chat-workspace-preview-waiting-spinner" aria-hidden />
            <p className="react-chat-workspace-preview-waiting-title">正在生成文件内容</p>
            <p className="react-chat-workspace-preview-waiting-hint">收到可读正文后将在此实时显示</p>
          </div>
        ) : preview.loading ? (
          <div className="react-chat-workspace-preview-waiting">
            <div className="react-chat-workspace-preview-waiting-spinner" aria-hidden />
            <p className="react-chat-workspace-preview-waiting-title">加载中</p>
          </div>
        ) : preview.error ? (
          <div className="react-chat-workspace-preview-error">
            <div className="react-chat-workspace-tree-error">{preview.error}</div>
            {onRetry ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm react-chat-workspace-preview-retry-btn"
                onClick={() => onRetry()}
              >
                重试
              </button>
            ) : null}
          </div>
        ) : showImage ? (
          <div className="react-chat-workspace-preview-media-wrap">
            <button
              type="button"
              className="msg-tool-screenshot-btn react-chat-workspace-preview-media-btn"
              title="放大查看"
              aria-label="放大查看图片"
              onClick={() => showChatLightbox(mediaSrc)}
            >
              <img
                className="react-chat-workspace-preview-media-img"
                src={mediaSrc}
                alt={preview.name || '图片预览'}
              />
            </button>
          </div>
        ) : showVideo ? (
          <div className="react-chat-workspace-preview-media-wrap">
            <video
              className="react-chat-workspace-preview-media-video"
              src={mediaSrc}
              controls
              playsInline
              preload="metadata"
            />
          </div>
        ) : showAudio ? (
          <div className="react-chat-workspace-preview-media-wrap">
            <audio className="react-chat-workspace-preview-media-audio" src={mediaSrc} controls preload="metadata" />
          </div>
        ) : preview.binary ? (
          <div className="react-chat-workspace-preview-binary-hint">
            {getBinaryFilePreviewHint(preview.name, preview.path)}
          </div>
        ) : isHtml && htmlLivePreview ? (
          <div className="react-chat-workspace-preview-html-wrap">
            {preview.truncated ? (
              <div className="react-chat-workspace-preview-hint">仅显示前 512KB，完整内容请用 Agent 读取</div>
            ) : null}
            <iframe
              key={`${preview.path}-done`}
              className="react-chat-workspace-preview-html"
              title={`预览 ${preview.name}`}
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
              srcDoc={htmlSrcDoc}
            />
          </div>
        ) : isHtml ? (
          <div className="react-chat-workspace-preview-code-wrap">
            <pre className="react-chat-workspace-preview-code">
              <code>{displayContent}</code>
              {streamDisplayActive ? (
                <span className="react-chat-workspace-typewriter-cursor" aria-hidden />
              ) : null}
            </pre>
          </div>
        ) : isMarkdown ? (
          <div className="react-chat-workspace-preview-md-host">
            {preview.truncated ? (
              <div className="react-chat-workspace-preview-hint">仅显示前 512KB，完整内容请用 Agent 读取</div>
            ) : null}
            <MarkdownDocumentView
              text={displayContent}
              defaultMode="preview"
              allowEdit={allowMarkdownEdit && !preview.streaming}
              onChange={onMarkdownChange}
              readOnly={!!preview.streaming}
              testIdPrefix="ws-md"
            />
          </div>
        ) : (
          <div className="react-chat-workspace-preview-code-wrap">
            {preview.truncated ? (
              <div className="react-chat-workspace-preview-hint">仅显示前 512KB，完整内容请用 Agent 读取</div>
            ) : null}
            <pre className="react-chat-workspace-preview-code">
              <code>{displayContent}</code>
              {preview.streaming && streamBodyReady ? (
                <span className="react-chat-workspace-typewriter-cursor" aria-hidden />
              ) : null}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

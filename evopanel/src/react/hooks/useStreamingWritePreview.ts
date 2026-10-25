/**
 * Streaming write-file preview + tool→right-stage sync.
 * Extracted from ChatApp.tsx (P5).
 *
 * LEGACY 双轨：仍对旧 tools[] 做写入预览 / platform toast 扫描。
 * 默认聊天工具行来自 V4 快照，不经过本 hook 的「可见列表」。
 * platform 进度侧栏 autoOpen：V4 权威在 ConversationTurnGroup；这里的
 * syncPlatformFeedbackFromTools 只是旧 tools-scan 旁路，改 UI 别只动这里。
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { getPanelSetting } from '../../lib/panel-settings.js'
import { toast } from '../../components/toast.js'
import { rightStageStore } from '../../lib/right-stage/right-stage-store.js'
import { applyDecideRightStage } from '../../lib/right-stage/apply-decide-right-stage.js'
import {
  normalizeWriteStreamMode,
  shouldOpenWriteStreamPanel,
  isAutoWorkPreviewEnabled,
  type WriteStreamMode,
} from '../../lib/right-stage/write-stream-mode.js'
import {
  detectLatestWritePreviewFromTools,
  detectStreamingWritePreview,
  isStreamAutoPreviewPath,
  isWriteToolInFlight,
  shouldSuppressStreamDeliveredFiles,
} from '../../lib/workspace-preview-path.js'
import {
  latestPlatformRunEntryId,
  syncPlatformFeedbackFromTools,
  type PlatformRunEntry,
} from '../../lib/right-stage/platform-feedback.js'
import type { RightStageKind } from '../../lib/right-stage/right-stage-types.js'
import { inferWriteStreamFormat } from '../chat-app/utils/desktop-workspace.js'
import { turnBusyForSession } from '../chat-app/utils/session-busy.js'
import type { StreamState } from '../chat-types.js'

export type StreamingWritePreview = {
  path: string
  name: string
  content: string
  streaming: boolean
}

export function useStreamingWritePreview(opts: {
  sessionRef: MutableRefObject<string>
  streamRef: MutableRefObject<StreamState>
  scheduleBumpRef: MutableRefObject<((opts?: { immediate?: boolean }) => void) | null>
  rightStageUserPinnedRef: MutableRefObject<RightStageKind | null>
  dismissedRightStageKindsRef: MutableRefObject<Set<string>>
  rightStageRunIdRef: MutableRefObject<string>
  rightStageHintTimerRef: MutableRefObject<number>
  platformFeedbackSeenRef: MutableRefObject<Set<string>>
  turnPlatformEntriesRef: MutableRefObject<PlatformRunEntry[]>
  publishPlatformEntriesRef: MutableRefObject<
    (entries: PlatformRunEntry[], focusEntryId?: string) => void
  >
  openWriteStream: (data: {
    path?: string
    streamId?: string
    format?: string
    auto?: boolean
  }) => void
  openRightStageStream: (data: {
    streamId: string
    format?: 'plain' | 'markdown' | 'code'
    path?: string
  }) => void
  appendRightStageStream: (data: { streamId: string; text: string }) => void
  clearRightStageStream: (streamId: string) => void
  closeRightStageStream: (streamId: string) => void
  syncShellAsideForWorkspacePanel: (open: boolean) => void
}) {
  const {
    sessionRef,
    streamRef,
    scheduleBumpRef,
    rightStageUserPinnedRef,
    dismissedRightStageKindsRef,
    rightStageRunIdRef,
    rightStageHintTimerRef,
    platformFeedbackSeenRef,
    turnPlatformEntriesRef,
    publishPlatformEntriesRef,
    openWriteStream,
    openRightStageStream,
    appendRightStageStream,
    clearRightStageStream,
    closeRightStageStream,
    syncShellAsideForWorkspacePanel,
  } = opts

  const [streamingWritePreview, setStreamingWritePreview] = useState<StreamingWritePreview | null>(
    null,
  )
  const lastStreamWritePathRef = useRef<string | null>(null)
  const lastWriteStreamLenRef = useRef(0)
  /** 用户主动关闭写入流后，本轮写入完成前不再自动弹出 */
  const writeStreamDismissedRef = useRef(false)
  const writeStreamModeRef = useRef<WriteStreamMode>(
    normalizeWriteStreamMode(getPanelSetting('writeStreamMode')),
  )

  useEffect(() => {
    const syncWriteStreamMode = () => {
      writeStreamModeRef.current = normalizeWriteStreamMode(getPanelSetting('writeStreamMode'))
    }
    syncWriteStreamMode()
    window.addEventListener('evopanel:panel-settings-loaded', syncWriteStreamMode)
    window.addEventListener('evopanel:panel-settings-changed', syncWriteStreamMode)
    return () => {
      window.removeEventListener('evopanel:panel-settings-loaded', syncWriteStreamMode)
      window.removeEventListener('evopanel:panel-settings-changed', syncWriteStreamMode)
    }
  }, [])

  const streamingWritePreviewRef = useRef(streamingWritePreview)
  streamingWritePreviewRef.current = streamingWritePreview
  const pendingStreamingPreviewRef = useRef<StreamingWritePreview | null>(null)
  const streamingPreviewFlushTimerRef = useRef(0)

  const flushStreamingWritePreview = useCallback(() => {
    streamingPreviewFlushTimerRef.current = 0
    const pending = pendingStreamingPreviewRef.current
    if (!pending) return
    pendingStreamingPreviewRef.current = null
    setStreamingWritePreview(pending)
  }, [])

  const queueStreamingWritePreview = useCallback(
    (next: StreamingWritePreview) => {
      streamingWritePreviewRef.current = next
      pendingStreamingPreviewRef.current = next
      if (streamingPreviewFlushTimerRef.current) return
      streamingPreviewFlushTimerRef.current = window.setTimeout(
        flushStreamingWritePreview,
        next.streaming ? 48 : 200,
      )
    },
    [flushStreamingWritePreview],
  )

  useEffect(
    () => () => {
      if (streamingPreviewFlushTimerRef.current) {
        clearTimeout(streamingPreviewFlushTimerRef.current)
        streamingPreviewFlushTimerRef.current = 0
      }
    },
    [],
  )

  const syncWorkspacePreviewFromTools = useCallback(
    (tools: unknown[]) => {
      if (!Array.isArray(tools)) return

      const { shown: platformShown, entries: platformEntries } = syncPlatformFeedbackFromTools(
        tools,
        platformFeedbackSeenRef.current,
        {
          existingEntries: turnPlatformEntriesRef.current,
        },
      )
      if (platformEntries.length) {
        publishPlatformEntriesRef.current(
          platformEntries,
          latestPlatformRunEntryId(platformEntries),
        )
      }
      for (const ui of platformShown) {
        toast(
          ui.title,
          ui.kind === 'warning' ? 'warning' : ui.kind === 'error' ? 'error' : 'success',
        )
      }

      const mode = writeStreamModeRef.current
      const autoPreview = isAutoWorkPreviewEnabled(mode)
      const workspaceWritePanelOpen = rightStageStore.getSnapshot().surface?.kind === 'write'
      const trackWriteStream = autoPreview || workspaceWritePanelOpen
      const writeInFlight = tools.some((t) => isWriteToolInFlight(t))
      const hadStreaming = !!streamingWritePreviewRef.current?.streaming
      const hitAny = detectStreamingWritePreview(tools, { requireReady: false })
      const latestWrite = detectLatestWritePreviewFromTools(tools)
      const pinned = rightStageUserPinnedRef.current
      const currentKind = rightStageStore.currentKind

      const decideOpenWrite = (): boolean => {
        if (!autoPreview || writeStreamDismissedRef.current) return false
        if (pinned && pinned !== 'write') return false
        const decision = applyDecideRightStage(
          {
            intent: 'write',
            kind: 'write',
            runId: rightStageRunIdRef.current,
            userPinned: pinned,
            dismissedKindsThisRun: dismissedRightStageKindsRef.current,
            autoPreviewEnabled: autoPreview,
            currentKind,
          },
          {
            data: {
              streamId: 'write_file',
              path: hitAny?.path || latestWrite?.path || lastStreamWritePathRef.current || '',
              format: inferWriteStreamFormat(
                hitAny?.path || latestWrite?.path || lastStreamWritePathRef.current || '',
              ),
            },
            onHint: (r) => {
              const path = String(hitAny?.path || latestWrite?.path || '')
                .split(/[/\\]/)
                .pop()
              toast(path ? `正在写入 ${path}…` : '正在写入文件…', 'info')
              void r
            },
            scheduleShow: (delayMs, run) => {
              if (rightStageHintTimerRef.current) {
                clearTimeout(rightStageHintTimerRef.current)
              }
              rightStageHintTimerRef.current = window.setTimeout(() => {
                rightStageHintTimerRef.current = 0
                run()
                syncShellAsideForWorkspacePanel(true)
              }, delayMs)
            },
          },
        )
        return decision.action === 'show' || decision.action === 'hint'
      }

      const mayShowWriteStream =
        !writeStreamDismissedRef.current && (!pinned || pinned === 'write')

      const ensureWriteStreamSession = (
        path: string,
        format: 'plain' | 'markdown' | 'code',
        openPanel: boolean,
      ) => {
        if (!trackWriteStream || !path) return
        if (lastStreamWritePathRef.current !== path) {
          lastStreamWritePathRef.current = path
          lastWriteStreamLenRef.current = 0
        }
        openRightStageStream({ streamId: 'write_file', format, path })
        if (openPanel && mayShowWriteStream) {
          if (rightStageStore.currentKind === 'write') {
            openWriteStream({ path, streamId: 'write_file', format, auto: true })
          } else if (decideOpenWrite()) {
            /* hint/show scheduled */
          }
        }
      }

      const appendWriteStreamDelta = (path: string, content: string) => {
        if (!trackWriteStream || !path) return
        const format = inferWriteStreamFormat(path)
        const prevLen = lastWriteStreamLenRef.current
        if (content.length > prevLen) {
          ensureWriteStreamSession(
            path,
            format,
            shouldOpenWriteStreamPanel({
              mode,
              contentLength: content.length,
              prevContentLength: prevLen,
            }),
          )
          appendRightStageStream({
            streamId: 'write_file',
            text: content.slice(prevLen),
          })
          lastWriteStreamLenRef.current = content.length
        } else if (content.length < prevLen) {
          clearRightStageStream('write_file')
          ensureWriteStreamSession(path, format, false)
          appendRightStageStream({ streamId: 'write_file', text: content })
          lastWriteStreamLenRef.current = content.length
        }
      }

      if (!writeInFlight) {
        if (streamingPreviewFlushTimerRef.current) {
          clearTimeout(streamingPreviewFlushTimerRef.current)
          streamingPreviewFlushTimerRef.current = 0
        }
        pendingStreamingPreviewRef.current = null
        const prev = streamingWritePreviewRef.current
        const finalPath = latestWrite?.path ?? hitAny?.path ?? lastStreamWritePathRef.current
        const finalContent = latestWrite?.content ?? hitAny?.content ?? prev?.content ?? ''
        if (
          !hadStreaming &&
          !lastStreamWritePathRef.current &&
          !(trackWriteStream && finalPath && finalContent)
        ) {
          return
        }
        if (prev?.path && isStreamAutoPreviewPath(prev.path) && workspaceWritePanelOpen) {
          setStreamingWritePreview({
            path: prev.path,
            name: prev.name,
            content: prev.content ?? '',
            streaming: false,
          })
        } else if (!workspaceWritePanelOpen) {
          setStreamingWritePreview(null)
        }
        if (trackWriteStream && finalPath && finalContent) {
          appendWriteStreamDelta(finalPath, finalContent)
        }
        if (lastStreamWritePathRef.current) {
          closeRightStageStream('write_file')
        }
        lastStreamWritePathRef.current = null
        lastWriteStreamLenRef.current = 0
        writeStreamDismissedRef.current = false
        return
      }

      if (!hitAny) {
        return
      }

      if (!trackWriteStream) {
        if (
          shouldSuppressStreamDeliveredFiles(tools, {
            streamingWritePreview: streamingWritePreviewRef.current,
            suppressForSendingWriteTurn: turnBusyForSession(sessionRef.current),
          })
        ) {
          if (streamRef.current.turn.files?.length) {
            streamRef.current.turn.files = []
            scheduleBumpRef.current?.()
          }
        }
        return
      }

      const content = hitAny.content ?? ''
      const path = hitAny.path
      if (path) {
        const format = inferWriteStreamFormat(path)
        if (autoPreview && lastStreamWritePathRef.current !== path) {
          ensureWriteStreamSession(path, format, true)
        }
        appendWriteStreamDelta(path, content)
      }

      if (
        shouldSuppressStreamDeliveredFiles(tools, {
          streamingWritePreview: streamingWritePreviewRef.current,
          suppressForSendingWriteTurn: turnBusyForSession(sessionRef.current),
        })
      ) {
        if (streamRef.current.turn.files?.length) {
          streamRef.current.turn.files = []
          scheduleBumpRef.current?.()
        }
      }

      if (hitAny.path && lastStreamWritePathRef.current !== hitAny.path) {
        lastStreamWritePathRef.current = hitAny.path
      }
      if (workspaceWritePanelOpen || autoPreview) {
        queueStreamingWritePreview({
          path: hitAny.path,
          name: hitAny.name,
          content: hitAny.content ?? '',
          streaming: true,
        })
      }
    },
    [
      queueStreamingWritePreview,
      openWriteStream,
      openRightStageStream,
      appendRightStageStream,
      clearRightStageStream,
      closeRightStageStream,
      syncShellAsideForWorkspacePanel,
      sessionRef,
      streamRef,
      scheduleBumpRef,
      rightStageUserPinnedRef,
      dismissedRightStageKindsRef,
      rightStageRunIdRef,
      rightStageHintTimerRef,
      platformFeedbackSeenRef,
      turnPlatformEntriesRef,
      publishPlatformEntriesRef,
    ],
  )

  return {
    streamingWritePreview,
    setStreamingWritePreview,
    streamingWritePreviewRef,
    lastStreamWritePathRef,
    lastWriteStreamLenRef,
    writeStreamDismissedRef,
    writeStreamModeRef,
    queueStreamingWritePreview,
    syncWorkspacePreviewFromTools,
  }
}

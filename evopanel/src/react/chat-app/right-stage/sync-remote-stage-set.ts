/**
 * Apply STAGE_SET_APPLIED remote payload to local right-stage / artifacts state.
 * Extracted from ChatApp.tsx (P19).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { hideRightStageIfKind, rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import type { StageSetPayload } from '../../../lib/right-stage/right-stage-agui.js'
import type { RightStageKind, RightStageLayout } from '../../../lib/right-stage/right-stage-types.js'
import { showRightStageFilePreview } from '../../../lib/right-stage/open-right-stage-file.js'
import { isProgressStageKind } from '../../../lib/right-stage/open-progress-from-panel-set.js'
import { getCurrentRightStageSessionKey } from '../../../lib/right-stage/right-stage-scope.js'
import {
  clearAllRightStageOverlayDefer,
  resumeStreamBumpIfIdle,
  setRightStageOverlayDefer,
} from '../../../lib/right-stage/right-stage-overlay-commit.js'
import {
  mergeChatArtifacts,
  normalizeChatArtifacts,
  type ChatArtifact,
} from '../../lib/chat-artifact.js'
import { logPanelSet } from '../../../lib/right-stage/panel-set-debug-log.js'
import { withAbsoluteArtifactPaths } from '../../../lib/artifact-absolute-path.js'
import { isXiaomiVoiceRightStageForeground } from '../../../lib/xiaomi-voice/voice-right-stage-foreground.js'
import { wsClient } from '../../../lib/ws-client.js'

export type SyncRemoteStageSetCtx = {
  rightStageUserPinnedRef: { current: RightStageKind | null }
  scheduleBumpRef: { current: ((opts?: { immediate?: boolean }) => void) | null }
  cancelPendingStreamUiBumpsRef: { current: () => void }
  lastStreamWritePathRef: { current: string | null }
  turnRunArtifactsRef: MutableRefObject<ChatArtifact[]>
  setSessionArtifactsRef: MutableRefObject<
    Dispatch<SetStateAction<ChatArtifact[]>>
  >
  publishArtifactsRef: MutableRefObject<
    (opts?: { focusId?: string; hint?: string; force?: boolean }) => void
  >
  syncShellAsideForWorkspacePanel: (open: boolean) => void
  setStreamingWritePreview: (v: null) => void
  setWorkspaceTreePinned: (pinned: boolean) => void
  setKnowledgeMapRefreshKey: Dispatch<SetStateAction<number>>
}

function coerceFileLayout(raw: unknown): RightStageLayout | undefined {
  const v = String(raw || '').trim()
  if (v === 'half' || v === 'wide' || v === 'narrow' || v === 'workspace-write') return v
  return undefined
}

function pickFocusArtifact(
  incoming: ChatArtifact[],
  data: Record<string, unknown>,
): ChatArtifact | null {
  const withPath = incoming.filter(
    (it) => it.type !== 'platform' && String(it.path || '').trim(),
  )
  if (!withPath.length) return null
  const focusId = String(data.focusId || '').trim()
  const focusPath = String(data.focusPath || '').trim().replace(/\\/g, '/')
  if (focusId) {
    const byId = withPath.find((it) => it.id === focusId)
    if (byId) return byId
  }
  if (focusPath) {
    const byPath = withPath.find((it) => String(it.path || '').replace(/\\/g, '/') === focusPath)
    if (byPath) return byPath
  }
  return withPath[withPath.length - 1] || null
}

export function syncRemoteStageSet(ctx: SyncRemoteStageSetCtx, detail: StageSetPayload): void {
  const kind = String(detail.surface?.kind || '').trim()
  logPanelSet('② syncRemoteStageSet 收到 STAGE_SET_APPLIED', {
    action: detail.action,
    kind: kind || '(空)',
    title: detail.surface?.title,
    layout: detail.surface?.layout,
  })
  if (detail.action === 'hide' || !kind) {
    logPanelSet('② 动作=hide 或 kind 空，收起侧栏相关状态')
    ctx.rightStageUserPinnedRef.current = null
    clearAllRightStageOverlayDefer()
    ctx.syncShellAsideForWorkspacePanel(false)
    resumeStreamBumpIfIdle(() => ctx.scheduleBumpRef.current?.({ immediate: true }))
    return
  }
  // 产物列表仍进状态卡数据；显式 panel_set 若带本地 path，再打开右侧「文件」预览看内容。
  // （Right Stage 不再挂 artifacts 标签——store.show 会拒收。）
  if (kind === 'artifacts') {
    hideRightStageIfKind('artifacts')
    const data = (detail.surface?.data || {}) as Record<string, unknown>
    const incoming = normalizeChatArtifacts(data.items)
    logPanelSet('② artifacts 分支：规范化 items', {
      rawItemsType: Array.isArray(data.items) ? 'array' : typeof data.items,
      incomingCount: incoming.length,
      paths: incoming.map((it) => it.path || it.url || '(无路径)'),
    })
    if (incoming.length) {
      const focusId = String(data.focusId || incoming[incoming.length - 1]?.id || '')
      const titleHint = String(detail.surface?.title || '').trim() || undefined
      // 产物路径先补绝对本机路径：相对/临时路径既看不懂也读不到。
      // 解析要打后端，故异步；失败时回退原始相对路径，既有流程不受影响。
      void (async () => {
        // 事件归属会话（可能是小V语音会话）：解析路径要用它自己的线程沙箱。
        const ownerSk =
          String(detail.surface?.sessionKey || '').trim() ||
          getCurrentRightStageSessionKey() ||
          ''
        const absIncoming = await withAbsoluteArtifactPaths(incoming, {
          threadId: ownerSk ? wsClient.getSessionThreadId(ownerSk) : undefined,
        })
        ctx.turnRunArtifactsRef.current = mergeChatArtifacts(
          ctx.turnRunArtifactsRef.current,
          absIncoming,
        )
        ctx.setSessionArtifactsRef.current((prev) => mergeChatArtifacts(prev, absIncoming))
        const focusFile = pickFocusArtifact(absIncoming, data)
        if (focusFile?.path) {
          // 小V语音全屏：事件归属小V会话，但右栏 UI 挂在主对话会话键上——
          // 文件签必须钉到当前 UI 会话，否则会被会话过滤掉（看着像「没打开」）。
          const xiaomiVoiceFg = isXiaomiVoiceRightStageForeground(ownerSk)
          const sk = xiaomiVoiceFg
            ? getCurrentRightStageSessionKey() || undefined
            : String(detail.surface?.sessionKey || '').trim() ||
              getCurrentRightStageSessionKey() ||
              undefined
          const layout = coerceFileLayout(detail.surface?.layout) || 'half'
          // 进度面板优先：只落产物列表，不抢工作流/节点/员工过程
          const currentKind = String(rightStageStore.currentKind || '').trim()
          const pinnedKind = String(ctx.rightStageUserPinnedRef.current || '').trim()
          if (isProgressStageKind(currentKind) || isProgressStageKind(pinnedKind)) {
            logPanelSet('② artifacts 有 path 但进度面板优先 → 只写列表不抢焦', {
              path: focusFile.path,
              currentKind,
              pinnedKind,
            })
            ctx.publishArtifactsRef.current({ focusId, force: false })
            ctx.scheduleBumpRef.current?.({ immediate: true })
          } else {
            logPanelSet('② 有本地 path → 调用 showRightStageFilePreview', {
              path: focusFile.path,
              name: focusFile.name || focusFile.label,
              sessionKey: sk || '(空)',
              layout,
            })
            // 先落列表（不 force 开状态卡，避免 collapseRightStage 打掉刚开的文件签）
            ctx.publishArtifactsRef.current({
              focusId,
              force: false,
            })
            const tabKey = showRightStageFilePreview(String(focusFile.path).trim(), {
              name: String(focusFile.name || focusFile.label || '').trim() || undefined,
              sessionKey: sk,
              layout,
            })
            logPanelSet('② showRightStageFilePreview 已返回', { tabKey })
            ctx.rightStageUserPinnedRef.current = 'file'
            ctx.scheduleBumpRef.current?.({ immediate: true })
          }
        } else {
          logPanelSet('② 无本地 path → force 打开状态卡产物 tab', { focusId, titleHint })
          // 无本地 path（纯 url/文案）：仍 force 打开状态卡产物 tab
          ctx.publishArtifactsRef.current({
            focusId,
            force: true,
            hint: titleHint,
          })
        }
      })()
    } else {
      logPanelSet('② artifacts items 为空，什么都没打开')
    }
    return
  }
  logPanelSet('② 非 artifacts：钉住 kind 并 bump', { kind })
  ctx.cancelPendingStreamUiBumpsRef.current()
  ctx.rightStageUserPinnedRef.current = kind as RightStageKind
  clearAllRightStageOverlayDefer()
  setRightStageOverlayDefer('workspace', kind === 'workspace-browse' || kind === 'write')
  setRightStageOverlayDefer('knowledge-map', kind === 'mind-map')
  if (kind !== 'write') {
    ctx.setStreamingWritePreview(null)
    ctx.lastStreamWritePathRef.current = null
  }
  ctx.setWorkspaceTreePinned(kind === 'workspace-browse')
  if (kind === 'mind-map') {
    ctx.setKnowledgeMapRefreshKey((k) => k + 1)
  }
  if (kind === 'news-dashboard' || kind === 'web-embed') {
    ctx.syncShellAsideForWorkspacePanel(true)
  }
  ctx.scheduleBumpRef.current?.({ immediate: true })
}

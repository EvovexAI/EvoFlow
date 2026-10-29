/**
 * 小V 会话的「右栏动作」共享层。
 *
 * 小V 的对话正文有两处宿主：
 * - 右栏小V标签页（XiaomiChatThread）
 * - 语音全屏右上角回复区（XiaomiVoiceStage 的 .xws-recent）
 *
 * 两处都走同一套 V4 时间线（V4ZCodeTimeline），因此工具审批 / 文件预览 /
 * 浏览器打开这些副作用必须用同一份绑定，否则一边能点、一边不能。
 * 本文件只提供绑定与读取，不含任何渲染。
 */
import { useCallback, useMemo } from 'react'
import { wsClient } from '../../lib/ws-client.js'
import {
  openRightStageForCodeViewerSource,
  showRightStageFromFileLink,
} from '../../lib/right-stage/open-right-stage-file.js'
import { showRightStageBrowserUrl } from '../../lib/right-stage/open-right-stage-browser.js'
import { readSessionWorkspacePath } from '../lib/session-workspace-path.js'
import { toast } from '../../components/toast.js'

/** 小V 会话当前绑定的 LangGraph threadId（无则空串）。 */
export function readXiaomiThreadId(sessionKey: string): string {
  const sk = String(sessionKey || '').trim()
  if (!sk) return ''
  return String(wsClient.getSessionThreadId?.(sk) || '').trim()
}

/** 小V 会话工作区根（工具卡里的文件路径要相对化到这里）。 */
export function readXiaomiWorkspacePath(sessionKey: string): string {
  return readSessionWorkspacePath(sessionKey)
}

export type XiaomiChatActions = {
  /** 行内工具审批（approve / deny / grant_all …）。 */
  onToolApproval: (
    action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
    toolCallId?: string,
    hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
  ) => Promise<void>
  /** 正文 Markdown 路径 pill → 右侧「文件」区。 */
  onOpenFileLink: (target: import('@zcode/ui/components/ai-elements/message.js').MessageFileLinkTarget) => void
  /** 工具卡 → 右侧预览（文件 / diff / 媒体）。 */
  onOpenCodeViewer: (source: import('@zcode/ui/lib/codeViewer.js').CodeViewerSource) => void
  /** 网站预览卡「打开」→ 右侧内置浏览器。 */
  onOpenBrowserUrl: (url: string) => void
  /** 工作区根（绝对路径），供相对化路径解析。 */
  workspacePath: string
}

/**
 * 小V 会话 → 右栏动作绑定。sessionKey 变化即重建（切会话要换 thread 归属）。
 */
export function useXiaomiChatActions(sessionKey: string): XiaomiChatActions {
  const sk = String(sessionKey || '').trim()

  const onToolApproval = useCallback(
    async (
      action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
      toolCallId?: string,
      hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
    ) => {
      const tid = readXiaomiThreadId(sk)
      if (!tid) {
        toast('会话线程未就绪，请稍后再试', 'warning')
        return
      }
      try {
        await wsClient.postToolApproval(tid, {
          action: action === 'approve_remember' ? 'approve' : action,
          tool_call_id: toolCallId,
          local_workspace_root: readXiaomiWorkspacePath(sk) || undefined,
          tool_name: hint?.tool_name,
          args: hint?.args,
          summary: hint?.summary,
          remember: action === 'approve_remember',
        })
      } catch (e) {
        toast(String((e as Error)?.message || e || '授权失败'), 'error')
      }
    },
    [sk],
  )

  const onOpenFileLink = useCallback(
    (target: import('@zcode/ui/components/ai-elements/message.js').MessageFileLinkTarget) => {
      showRightStageFromFileLink(target, {
        sessionKey: sk,
        threadId: readXiaomiThreadId(sk),
      })
    },
    [sk],
  )

  const onOpenCodeViewer = useCallback(
    (source: import('@zcode/ui/lib/codeViewer.js').CodeViewerSource) => {
      openRightStageForCodeViewerSource(source, {
        sessionKey: sk,
        threadId: readXiaomiThreadId(sk),
      })
    },
    [sk],
  )

  const onOpenBrowserUrl = useCallback(
    (url: string) => {
      showRightStageBrowserUrl(url, {
        sessionKey: sk,
        threadId: readXiaomiThreadId(sk),
      })
    },
    [sk],
  )

  const workspacePath = useMemo(() => readXiaomiWorkspacePath(sk), [sk])

  return {
    onToolApproval,
    onOpenFileLink,
    onOpenCodeViewer,
    onOpenBrowserUrl,
    workspacePath,
  }
}

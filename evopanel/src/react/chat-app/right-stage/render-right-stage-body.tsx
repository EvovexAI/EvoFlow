// @ts-nocheck — mechanical P83 extract.
/**
 * Right-stage surface body renderer. Extracted from ChatApp.tsx (P83).
 */
import type { ReactNode } from 'react'
import {
  normalizeRightStageKind,
  type RightStageSurface,
} from '../../../lib/right-stage/right-stage-types.js'
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { openRightStageForCodeViewerSource } from '../../../lib/right-stage/open-right-stage-file.js'

function tabKeyOf(surface: RightStageSurface): string {
  return `${normalizeRightStageKind(surface.kind)}:${surface.id}`
}
import { V4PreviewPane } from './v4-preview-pane.js'
import { V4WorkspaceFileTreePane } from './v4-workspace-file-tree-pane.js'
import { V4SubagentTranscriptPane } from './v4-subagent-transcript-pane.js'
import { V4CollabSubtaskTranscriptPane } from './v4-collab-subtask-transcript-pane.js'
import { V4EmployeeProcessPane } from './v4-employee-process-pane.js'
import { V4SessionPaneBridge } from '../../v4/V4SessionPaneBridge.js'
import {
  openCollabSubtaskInRightStage,
  type CollabSubtaskStageOutcome,
} from '../../../lib/right-stage/open-collab-subtask-stage.js'
import { setWorkspaceIndexWatchEnabled } from '../../../lib/workspace-index-watch.js'
import { TerminalStagePanel } from '../../components/TerminalStagePanel.js'
import { WorkspaceFilePreviewPanel } from '../../components/WorkspaceFilePreviewPanel.js'
import { RightStageTabErrorBoundary } from './right-stage-tab-error-boundary.js'
import { SidePanelBootShell } from '../../components/SidePanelBootShell.js'
import { WorkspaceFileTree } from '../../components/WorkspaceFileTree.js'
import { KnowledgeMapPanel } from '../../components/KnowledgeMapPanel.js'
import { CollabExecutionPanel } from '../../components/CollabExecutionPanel.js'
import { useCollabSubtasksFromApi } from '../../hooks/useCollabSubtasksFromApi.js'

/** panel_set / 任务中心同构：按 surface.data.mainTaskId 自拉工作流，不绑当前会话 task。 */
function CollabWorkflowStageBody({
  surface,
  agents,
  fallbackMainTaskId,
  fallbackLeadThreadId,
  sharedMainTask,
  sharedSubtasks,
  liveSubtasks,
  subagentTasks,
  collabTask,
  collabPhase,
  onClose,
}: {
  surface: RightStageSurface
  agents: unknown
  fallbackMainTaskId?: string
  fallbackLeadThreadId?: string
  sharedMainTask?: unknown
  sharedSubtasks?: unknown
  liveSubtasks?: unknown
  subagentTasks?: unknown
  collabTask?: unknown
  collabPhase?: unknown
  onClose: () => void
}) {
  const data = surface.data || {}
  const mainTaskId = String(data.mainTaskId || fallbackMainTaskId || '').trim()
  const leadThreadId = String(data.leadThreadId || fallbackLeadThreadId || '').trim()
  const useShared =
    !!mainTaskId && mainTaskId === String(fallbackMainTaskId || '').trim() && sharedMainTask != null
  const { subtasks: fetchedSubs, mainTask: fetchedMain } = useCollabSubtasksFromApi({
    taskId: mainTaskId || null,
    threadId: leadThreadId || null,
    enabled: !!mainTaskId && !useShared,
    // ui.show 打开的工作流不绑当前会话 poll bump，这里自带 3s 心跳
    pollMs: 3000,
  })
  if (!mainTaskId) {
    return (
      <aside className="react-chat-collab-exec-panel react-chat-right-stage-panel" role="region" aria-label="工作流">
        <div className="react-chat-collab-exec-panel-body collab-wf-panel-body">
          <div className="collab-exec-dag-empty">当前会话暂无工作流</div>
        </div>
      </aside>
    )
  }
  return (
    <CollabExecutionPanel
      isOpen
      mainTaskId={mainTaskId}
      collabTask={useShared ? collabTask : fetchedMain}
      collabPhase={collabPhase}
      chatThreadId={leadThreadId || null}
      apiMainTask={useShared ? sharedMainTask : fetchedMain}
      apiSubtasks={useShared ? sharedSubtasks : fetchedSubs}
      liveSubtasks={useShared ? liveSubtasks || [] : []}
      subagentTasks={useShared ? subagentTasks : undefined}
      agents={agents}
      onClose={onClose}
      onSubtaskTranscriptOpen={(payload) => {
        openCollabSubtaskInRightStage({
          subtaskId: String(payload?.subtaskId || ''),
          mainTaskId: String(payload?.mainTaskId || mainTaskId),
          leadThreadId: String(payload?.leadThreadId || leadThreadId),
          title: String(payload?.title || ''),
          status: String(payload?.status || ''),
          assignedAgent: String(payload?.assignedAgent || ''),
          description: String(payload?.description || ''),
          subtaskThreadId: String(payload?.subtaskThreadId || ''),
          outcome: payload?.outcome,
        })
      }}
      canvasFillContainer
    />
  )
}

export type RenderRightStageBodyCtx = Record<string, any>

export function renderRightStageBody(
  ctx: RenderRightStageBodyCtx,
  surface: RightStageSurface,
): ReactNode {
  const {
    agents,
    chatThreadIdForSidebar,
    closeCollabExecPanel,
    closeKnowledgeMapPanel,
    closeWorkspacePanel,
    collabSubtasksTaskId,
    contextFiles,
    effectiveWorkspaceRoot,
    knowledgeMapEnabled,
    knowledgeMapPanelOpen,
    knowledgeMapRefreshKey,
    liveProcessSnapshot,
    openWorkspaceFilePreview,
    selectedSessionKey,
    setWorkspaceBrowseFocusPath,
    setWorkspaceIndexWatchEnabledState,
    sharedCollabMainTask,
    sharedCollabSubtasks,
    sidePanelHeavyMount,
    sidebarActiveTaskId,
    sidebarActiveView,
    streamingWritePreviewForPane,
    threadPanelState,
    toggleContextFile,
    workspaceBrowseFocusPath,
    workspaceIndexWatchEnabled,
    workspaceOpenScopeRef,
    workspaceTreePinned,
    wsClient,
  } = ctx
  const kind = surface.kind
  if (kind === 'summary') {
    return null
  }
  if (kind === 'terminal') {
    const data = surface.data || {}
    const toolCallId = String(data.toolCallId || surface.id || '').trim()
    const command = String(data.command || '').trim()
    const streams = liveProcessSnapshot.terminalStreams || {}
    const stream =
      streams[toolCallId] ||
      Object.values(streams).find(
        (s) =>
          String(s?.toolCallId || '') === toolCallId ||
          String((s as { id?: string })?.id || '') === toolCallId,
      ) ||
      undefined
    return (
      <TerminalStagePanel
        title={String(surface.title || data.title || '终端')}
        command={command}
        sessionKey={String(data.sessionKey || selectedSessionKey || '')}
        toolCallId={toolCallId}
        outputFallback={String(data.outputFallback || '')}
        stream={stream}
        running={!!data.running || stream?.phase === 'running'}
      />
    )
  }
  if (kind === 'file') {
    const data = surface.data || {}
    const path = String(data.path || surface.id || '').trim()
    const name = String(data.name || surface.title || '').trim()
    if (!path) return null
    const focusAnnotation =
      data.focusAnnotation && typeof data.focusAnnotation === 'object'
        ? (data.focusAnnotation as { title?: string; body?: string; priority?: number })
        : undefined
    const scope = workspaceOpenScopeRef.current
    const root = String(scope.root || effectiveWorkspaceRoot || '').trim()
    return sidePanelHeavyMount ? (
      <RightStageTabErrorBoundary title={name || '文件预览'}>
        <WorkspaceFilePreviewPanel
          embedded
          workspaceRoot={root}
          threadId={
            root ? undefined : wsClient.getSessionThreadId(selectedSessionKey || '') || undefined
          }
          workspaceScopeOpts={{
            configuredRoot: scope.configuredRoot,
            useVirtualPaths: scope.useVirtualPaths,
          }}
          path={path}
          name={name}
          poll={!!data.poll}
          focusLine={typeof data.focusLine === 'number' ? data.focusLine : undefined}
          focusEndLine={typeof data.focusEndLine === 'number' ? data.focusEndLine : undefined}
          focusAnnotation={focusAnnotation}
          onClose={() => rightStageStore.closeTab(tabKeyOf(surface))}
        />
      </RightStageTabErrorBoundary>
    ) : (
      <SidePanelBootShell title={name || '文件预览'} className="react-chat-workspace-preview-stage" />
    )
  }
  if (kind === 'v4Session') {
    const data = surface.data || {}
    const childSessionId = String(data.childSessionId || '').trim()
    if (!childSessionId) return null
    return sidePanelHeavyMount ? (
      <V4SessionPaneBridge
        sessionId={childSessionId}
        connecting={!!data.connecting}
        sessionKey={String(surface.sessionKey || selectedSessionKey || '') || undefined}
      />
    ) : (
      <SidePanelBootShell title={surface.title || '子会话'} />
    )
  }
  if (kind === 'subagentTranscript') {
    const data = surface.data || {}
    const taskId = String(data.taskId || '').trim()
    if (!taskId) return null
    return sidePanelHeavyMount ? (
      <V4SubagentTranscriptPane
        taskId={taskId}
        title={String(surface.title || data.title || '子代理')}
        sessionKey={String(data.sessionKey || selectedSessionKey || '')}
        fallbackText={typeof data.fallbackText === 'string' ? data.fallbackText : undefined}
        fallbackStatus={typeof data.fallbackStatus === 'string' ? data.fallbackStatus : undefined}
        onClose={() => rightStageStore.closeTab(tabKeyOf(surface))}
      />
    ) : (
      <SidePanelBootShell title={surface.title || '子代理输出'} />
    )
  }
  if (kind === 'collabSubtaskTranscript') {
    const data = surface.data || {}
    const subtaskId = String(data.subtaskId || '').trim()
    const mainTaskId = String(data.mainTaskId || collabSubtasksTaskId || sidebarActiveTaskId || '').trim()
    if (!subtaskId || !mainTaskId) return null
    return sidePanelHeavyMount ? (
      <V4CollabSubtaskTranscriptPane
        mainTaskId={mainTaskId}
        subtaskId={subtaskId}
        leadThreadId={String(data.leadThreadId || chatThreadIdForSidebar || '').trim()}
        title={String(surface.title || data.title || '节点进度')}
        status={String(data.status || '').trim()}
        assignedAgent={String(data.assignedAgent || '').trim()}
        description={String(data.description || '').trim()}
        subtaskThreadId={String(data.subtaskThreadId || '').trim()}
        sessionKey={String(data.sessionKey || selectedSessionKey || '')}
        initialOutcome={
          data.outcome && typeof data.outcome === 'object'
            ? (data.outcome as CollabSubtaskStageOutcome)
            : null
        }
        onClose={() => rightStageStore.closeTab(tabKeyOf(surface))}
      />
    ) : (
      <SidePanelBootShell title={surface.title || '节点进度'} />
    )
  }
  if (kind === 'codeViewer') {
    const data = surface.data || {}
    const source = data.source
    if (!source) return null
    // ZCode 正式预览件（PreviewPane）：patch/code-review/text/image/media/
    // pdf/pptx/multi-file-diff；普通 file 已在打开时分流到 file 标签。
    return sidePanelHeavyMount ? (
      <V4PreviewPane
        source={source}
        threadId={String(data.threadId || '')}
        workspacePath={String(source.workspacePath || effectiveWorkspaceRoot || '') || undefined}
        onClose={() => rightStageStore.closeTab(tabKeyOf(surface))}
        onOpenCodeViewer={(nextSource) => {
          openRightStageForCodeViewerSource(nextSource, {
            sessionKey: surface.sessionKey,
            threadId: String(data.threadId || ''),
          })
        }}
      />
    ) : (
      <SidePanelBootShell title={surface.title || '代码对比'} />
    )
  }
  if (kind === 'workspace-browse' || kind === 'write') {
    const writePreviewMode = kind === 'write'
    // workspace-browse（纯浏览）在 V4 主链路下挂 ZCode 原生 WorkspaceFileTree
    // （虚拟化/吸顶/搜索/只看已更改/Git 着色/watcher）；'write' 写入预览与
    // 无本地工作区根（thread 沙箱树）的会话仍走 kv 树。
    if (!writePreviewMode && String(effectiveWorkspaceRoot || '').trim()) {
      return sidePanelHeavyMount ? (
        <aside
          className="react-chat-workspace-panel react-chat-right-stage-panel is-tree-browse-mode"
          role="region"
          aria-label="工作区文件"
        >
          <V4WorkspaceFileTreePane
            workspacePath={effectiveWorkspaceRoot}
            threadId={wsClient.getSessionThreadId(selectedSessionKey || '') || undefined}
            onClose={() => closeWorkspacePanel()}
            onOpenCodeViewer={(nextSource) => {
              openRightStageForCodeViewerSource(nextSource, {
                sessionKey: surface.sessionKey,
                threadId: String(wsClient.getSessionThreadId(selectedSessionKey || '') || ''),
              })
            }}
          />
        </aside>
      ) : (
        <SidePanelBootShell
          title="工作区文件"
          className="react-chat-workspace-panel react-chat-right-stage-panel is-tree-browse-mode"
        />
      )
    }
    return sidePanelHeavyMount ? (
      <aside
        className={`react-chat-workspace-panel react-chat-right-stage-panel${
          writePreviewMode ? ' is-write-preview-mode' : ' is-tree-browse-mode'
        }`}
        role="region"
        aria-label={writePreviewMode ? '写入内容' : '工作区文件'}
      >
        <WorkspaceFileTree
          workspaceRoot={effectiveWorkspaceRoot}
          threadId={wsClient.getSessionThreadId(selectedSessionKey || '') || undefined}
          selected={contextFiles}
          onToggleFile={toggleContextFile}
          indexWatchEnabled={workspaceIndexWatchEnabled}
          onIndexWatchEnabledChange={(enabled) => {
            setWorkspaceIndexWatchEnabledState(enabled)
            setWorkspaceIndexWatchEnabled(enabled)
          }}
          onOpenFilePreview={(path, opts) => {
            openWorkspaceFilePreview(path, {
              name: opts?.name,
              poll: !!opts?.poll,
            })
          }}
          streamingWritePreview={streamingWritePreviewForPane}
          writePreviewMode={writePreviewMode}
          treePinned={workspaceTreePinned}
          onEscapeStreamPreview={() => closeWorkspacePanel()}
          focusBrowsePath={workspaceBrowseFocusPath}
          onFocusBrowsePathConsumed={() => setWorkspaceBrowseFocusPath(null)}
        />
      </aside>
    ) : (
      <SidePanelBootShell
        title={writePreviewMode ? '写入内容' : '工作区文件'}
        className={`react-chat-workspace-panel react-chat-right-stage-panel${
          writePreviewMode ? ' is-write-preview-mode' : ' is-tree-browse-mode'
        }`}
      />
    )
  }
  if (knowledgeMapEnabled && kind === 'mind-map') {
    return sidePanelHeavyMount ? (
      <KnowledgeMapPanel
        sessionKey={selectedSessionKey}
        isOpen={knowledgeMapPanelOpen}
        refreshKey={knowledgeMapRefreshKey}
        onClose={closeKnowledgeMapPanel}
      />
    ) : (
      <SidePanelBootShell
        title="思维导图"
        className="react-chat-collab-exec-panel react-chat-knowledge-map-panel react-chat-right-stage-panel"
      />
    )
  }
  if (kind === 'collab-workflow') {
    return sidePanelHeavyMount ? (
      <CollabWorkflowStageBody
        surface={surface}
        agents={agents}
        fallbackMainTaskId={String(collabSubtasksTaskId || sidebarActiveTaskId || '').trim()}
        fallbackLeadThreadId={String(chatThreadIdForSidebar || '').trim()}
        sharedMainTask={sharedCollabMainTask}
        sharedSubtasks={sharedCollabSubtasks}
        liveSubtasks={threadPanelState.collabSubtasks || []}
        subagentTasks={threadPanelState.subagentTasks}
        collabTask={sidebarActiveView?.task ?? threadPanelState.collabTask}
        collabPhase={threadPanelState.collabPhase ?? undefined}
        onClose={closeCollabExecPanel}
      />
    ) : (
      <SidePanelBootShell title="工作流" className="react-chat-right-stage-panel" />
    )
  }
  // 【V4 权威】employeeProcess → V4EmployeeProcessPane。禁止再挂 ProactiveLiveProcessHost。
  if (kind === 'employeeProcess') {
    const data = surface.data || {}
    const agentCode = String(data.agentCode || '').trim()
    if (!agentCode) return null
    return sidePanelHeavyMount ? (
      <V4EmployeeProcessPane
        agentCode={agentCode}
        roleName={String(data.roleName || '').trim()}
        busy={!!data.busy}
        title={String(surface.title || data.title || '执行过程')}
        roundId={String(data.roundId || '').trim()}
        taskId={String(data.taskId || '').trim()}
        sessionKey={String(surface.sessionKey || selectedSessionKey || '').trim() || undefined}
        onClose={() => rightStageStore.closeTab(tabKeyOf(surface))}
      />
    ) : (
      <SidePanelBootShell title={surface.title || '执行过程'} />
    )
  }
  return null
}

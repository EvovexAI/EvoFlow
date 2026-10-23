// @ts-nocheck — mechanical P83 extract.
/**
 * Right-stage surface body renderer. Extracted from ChatApp.tsx (P83).
 */
import type { ReactNode } from 'react'
import type { RightStageSurface } from '../../../lib/right-stage/right-stage-types.js'
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { V4PreviewPane } from './v4-preview-pane.js'
import { V4SubagentTranscriptPane } from './v4-subagent-transcript-pane.js'
import { V4SessionPaneBridge } from '../../v4/V4SessionPaneBridge.js'
import { setWorkspaceIndexWatchEnabled } from '../../../lib/workspace-index-watch.js'
import { TerminalStagePanel } from '../../components/TerminalStagePanel.js'
import { WorkspaceFilePreviewPanel } from '../../components/WorkspaceFilePreviewPanel.js'
import { SidePanelBootShell } from '../../components/SidePanelBootShell.js'
import { WorkspaceFileTree } from '../../components/WorkspaceFileTree.js'
import { KnowledgeMapPanel } from '../../components/KnowledgeMapPanel.js'
import { CollabExecutionPanel } from '../../components/CollabExecutionPanel.js'

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
    collabExecPanelOpen,
    collabSubtasksTaskId,
    collabWorkflowApiReady,
    contextFiles,
    effectiveWorkspaceRoot,
    knowledgeMapEnabled,
    knowledgeMapPanelOpen,
    knowledgeMapRefreshKey,
    liveProcessSnapshot,
    openWorkspaceFilePreview,
    selectedSessionKey,
    setSubtaskTranscriptModal,
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
        onClose={() => {
          rightStageStore.closeTab(`file:${path.replace(/\\/g, '/')}`)
        }}
      />
    ) : (
      <SidePanelBootShell title={name || '文件预览'} className="react-chat-workspace-preview-stage" />
    )
  }
  if (kind === 'v4Session') {
    const childSessionId = String(data.childSessionId || '').trim()
    if (!childSessionId) return null
    return sidePanelHeavyMount ? (
      <V4SessionPaneBridge
        sessionId={childSessionId}
        connecting={!!data.connecting}
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
        onClose={() => rightStageStore.closeTab(surface.id)}
      />
    ) : (
      <SidePanelBootShell title={surface.title || '子代理输出'} />
    )
  }
  if (kind === 'codeViewer') {
    const data = surface.data || {}
    const source = data.source
    if (!source) return null
    // ZCode 正式预览件（PreviewPane）：file/patch/code-review/text/image/media/
    // pdf/pptx/multi-file-diff 全类型支持，数据加载在组件内经沙箱文件服务完成。
    return sidePanelHeavyMount ? (
      <V4PreviewPane
        source={source}
        threadId={String(data.threadId || '')}
        workspacePath={String(source.workspacePath || effectiveWorkspaceRoot || '') || undefined}
        onClose={() => rightStageStore.closeTab(surface.id)}
        onOpenCodeViewer={(nextSource) => {
          rightStageStore.show({
            kind: 'codeViewer',
            id: `codeViewer:${String(nextSource.path || nextSource.title || 'diff').replace(/\\/g, '/')}`,
            title: nextSource.title || '代码对比',
            layout: 'wide',
            sessionKey: surface.sessionKey,
            data: {
              source: nextSource,
              threadId: String(data.threadId || ''),
            },
          })
        }}
      />
    ) : (
      <SidePanelBootShell title={surface.title || '代码对比'} />
    )
  }
  if (kind === 'workspace-browse' || kind === 'write') {
    const writePreviewMode = kind === 'write'
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
      collabWorkflowApiReady ? (
        <CollabExecutionPanel
          isOpen={collabExecPanelOpen}
          mainTaskId={collabSubtasksTaskId || sidebarActiveTaskId}
          collabTask={sidebarActiveView?.task ?? threadPanelState.collabTask}
          collabPhase={threadPanelState.collabPhase ?? undefined}
          chatThreadId={chatThreadIdForSidebar}
          apiMainTask={sharedCollabMainTask}
          apiSubtasks={sharedCollabSubtasks}
          liveSubtasks={threadPanelState.collabSubtasks || []}
          subagentTasks={threadPanelState.subagentTasks}
          agents={agents}
          onClose={closeCollabExecPanel}
          onSubtaskTranscriptOpen={setSubtaskTranscriptModal}
          canvasFillContainer
        />
      ) : (
        <aside className="react-chat-collab-exec-panel react-chat-right-stage-panel" role="region" aria-label="工作流">
          <div className="react-chat-collab-exec-panel-body collab-wf-panel-body">
            <div className="collab-exec-dag-empty">当前会话暂无工作流</div>
          </div>
        </aside>
      )
    ) : (
      <SidePanelBootShell title="工作流" className="react-chat-right-stage-panel" />
    )
  }
  return null
}

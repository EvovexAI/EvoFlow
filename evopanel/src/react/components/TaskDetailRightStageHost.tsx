/**
 * 任务详情页内嵌的 V4 右侧面板宿主。
 * 与对话 RightStage 共用 rightStageStore，但用 task-center:{taskId} 归属过滤，
 * 留在任务中心打开工作流 / 节点进度 / 文件预览，不跳会话。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RightStagePanel } from './RightStagePanel.js'
import { CollabExecutionPanel } from './CollabExecutionPanel.js'
import { SidePanelBootShell } from './SidePanelBootShell.js'
import { WorkspaceFilePreviewPanel } from './WorkspaceFilePreviewPanel.js'
import { useRightStageStore } from '../../lib/right-stage/use-right-stage.js'
import { rightStageStore } from '../../lib/right-stage/right-stage-store.js'
import { taskCenterStageSessionKey } from '../../lib/right-stage/task-center-stage-key.js'
import {
  openCollabSubtaskInRightStage,
  type CollabSubtaskStageOutcome,
} from '../../lib/right-stage/open-collab-subtask-stage.js'
import { openRightStageForCodeViewerSource } from '../../lib/right-stage/open-right-stage-file.js'
import { normalizeRightStageKind, type RightStageSurface } from '../../lib/right-stage/right-stage-types.js'
import { useCollabSubtasksFromApi } from '../hooks/useCollabSubtasksFromApi.js'
import { V4CollabSubtaskTranscriptPane } from '../chat-app/right-stage/v4-collab-subtask-transcript-pane.js'
import { V4PreviewPane } from '../chat-app/right-stage/v4-preview-pane.js'
import { ProactiveLiveProcessHost } from './ProactiveLiveProcessHost.js'
import type { CodeViewerSource } from '@zcode/ui/lib/codeViewer.js'
import type { AgentInfo } from '../chat-types.js'

export type TaskDetailRightStageHostProps = {
  taskId: string
  threadId?: string
  agents?: AgentInfo[]
  /** 详情轮询 bump，带动工作流子任务刷新 */
  refreshKey?: number
}

function tabKeyOf(tab: RightStageSurface): string {
  return `${normalizeRightStageKind(tab.kind)}:${tab.id}`
}

export function TaskDetailRightStageHost({
  taskId,
  threadId = '',
  agents = [],
  refreshKey = 0,
}: TaskDetailRightStageHostProps) {
  const tid = String(taskId || '').trim()
  const stageSk = taskCenterStageSessionKey(tid)
  const lead = String(threadId || '').trim()
  const { tabs, activeKey, collapsed, recentClosed, expand, collapse } = useRightStageStore()

  const visibleTabs = useMemo(
    () => (tabs || []).filter((t) => String(t.sessionKey || '').trim() === stageSk),
    [tabs, stageSk],
  )

  const visibleActiveKey = useMemo(() => {
    if (activeKey && visibleTabs.some((t) => tabKeyOf(t) === activeKey)) return activeKey
    return visibleTabs.length ? tabKeyOf(visibleTabs[visibleTabs.length - 1]) : null
  }, [activeKey, visibleTabs])

  const visibleRecent = useMemo(
    () =>
      (recentClosed || []).filter(
        (e) => String(e.tab?.sessionKey || '').trim() === stageSk,
      ),
    [recentClosed, stageSk],
  )

  const open = visibleTabs.length > 0 && !collapsed
  const prevTabCountRef = useRef(0)

  // 同步「详情 | 侧栏」双区壳。仅在「从无标签 → 有标签」时自动展开，
  // 勿在用户点折叠后立刻 expand（否则收起按钮看起来无效）。
  useEffect(() => {
    const count = visibleTabs.length
    const arrived = count > 0 && prevTabCountRef.current === 0
    prevTabCountRef.current = count
    if (arrived && collapsed) expand()

    const page = document.querySelector('.task-detail-page')
    const stagePane = document.getElementById('td-right-stage-slot')
    const paneOpen = count > 0 && !collapsed
    if (page) page.classList.toggle('td-with-right-stage', paneOpen)
    if (stagePane) {
      if (paneOpen) stagePane.removeAttribute('hidden')
      else stagePane.setAttribute('hidden', '')
    }
  }, [visibleTabs.length, collapsed, expand])

  const { subtasks: apiSubtasks, mainTask: apiMainTask } = useCollabSubtasksFromApi({
    taskId: tid,
    threadId: lead,
    enabled: !!tid && open,
    refreshKey,
  })

  const renderContent = useCallback(
    (surface: RightStageSurface) => {
      const kind = normalizeRightStageKind(surface.kind)
      const data = surface.data || {}
      if (kind === 'collab-workflow') {
        return (
          <CollabExecutionPanel
            isOpen
            mainTaskId={tid}
            collabTask={apiMainTask}
            chatThreadId={lead || null}
            apiMainTask={apiMainTask}
            apiSubtasks={apiSubtasks}
            agents={agents}
            onClose={() => rightStageStore.closeTab(tabKeyOf(surface))}
            onSubtaskTranscriptOpen={(payload) => {
              openCollabSubtaskInRightStage(
                {
                  subtaskId: String(payload?.subtaskId || ''),
                  mainTaskId: String(payload?.mainTaskId || tid),
                  leadThreadId: String(payload?.leadThreadId || lead),
                  title: String(payload?.title || ''),
                  status: String(payload?.status || ''),
                  assignedAgent: String(payload?.assignedAgent || ''),
                  description: String(payload?.description || ''),
                  subtaskThreadId: String(payload?.subtaskThreadId || ''),
                  outcome: payload?.outcome,
                },
                { sessionKey: stageSk },
              )
            }}
            hideHeaderStatus
            hidePanelHeader
            canvasFillContainer
          />
        )
      }
      if (kind === 'employeeProcess') {
        const agentCode = String(data.agentCode || '').trim()
        if (!agentCode) return <SidePanelBootShell title="执行过程" />
        return (
          <ProactiveLiveProcessHost
            open
            mode="panel"
            agentCode={agentCode}
            roleName={String(data.roleName || '').trim()}
            busy={!!data.busy}
            title={String(surface.title || data.title || '执行过程')}
            roundId={String(data.roundId || '').trim()}
            taskId={String(data.taskId || tid).trim()}
            pollMs={data.busy ? 1000 : 4000}
            onClose={() => rightStageStore.closeTab(tabKeyOf(surface))}
          />
        )
      }
      if (kind === 'collabSubtaskTranscript') {
        const subtaskId = String(data.subtaskId || '').trim()
        const mainTaskId = String(data.mainTaskId || tid).trim()
        if (!subtaskId || !mainTaskId) return <SidePanelBootShell title="节点进度" />
        return (
          <V4CollabSubtaskTranscriptPane
            mainTaskId={mainTaskId}
            subtaskId={subtaskId}
            leadThreadId={String(data.leadThreadId || lead).trim()}
            title={String(surface.title || data.title || '节点进度')}
            status={String(data.status || '').trim()}
            assignedAgent={String(data.assignedAgent || '').trim()}
            description={String(data.description || '').trim()}
            subtaskThreadId={String(data.subtaskThreadId || '').trim()}
            sessionKey={stageSk}
            initialOutcome={
              data.outcome && typeof data.outcome === 'object'
                ? (data.outcome as CollabSubtaskStageOutcome)
                : null
            }
            onClose={() => rightStageStore.closeTab(tabKeyOf(surface))}
          />
        )
      }
      if (kind === 'file') {
        const path = String(data.path || surface.id || '').trim()
        if (!path) return null
        return (
          <WorkspaceFilePreviewPanel
            embedded
            workspaceRoot=""
            path={path}
            name={String(data.name || surface.title || '')}
            threadId={lead || undefined}
            poll={!!data.poll}
            onClose={() => rightStageStore.closeTab(`file:${path.replace(/\\/g, '/')}`)}
          />
        )
      }
      if (kind === 'codeViewer') {
        const source = data.source as CodeViewerSource | undefined
        if (!source || typeof source !== 'object') return null
        const workspacePath =
          'workspacePath' in source ? String((source as { workspacePath?: string }).workspacePath || '') : ''
        return (
          <V4PreviewPane
            source={source}
            threadId={lead}
            workspacePath={workspacePath || undefined}
            onClose={() => rightStageStore.closeTab(tabKeyOf(surface))}
            onOpenCodeViewer={(nextSource) => {
              openRightStageForCodeViewerSource(nextSource, {
                sessionKey: stageSk,
                threadId: lead,
              })
            }}
          />
        )
      }
      return <SidePanelBootShell title={surface.title || kind || '面板'} />
    },
    [tid, lead, stageSk, apiMainTask, apiSubtasks, agents],
  )

  if (!tid || !open) return null

  return (
    <div className="td-right-stage">
      <RightStagePanel
        tabs={visibleTabs}
        activeKey={visibleActiveKey}
        recentClosed={visibleRecent}
        onActivateTab={(key) => rightStageStore.activateTab(key)}
        onCloseTab={(key) => rightStageStore.closeTab(key)}
        onCloseOtherTabs={(key) => {
          for (const t of visibleTabs) {
            const k = tabKeyOf(t)
            if (k !== key) rightStageStore.closeTab(k)
          }
        }}
        onCloseAllTabs={() => {
          for (const t of visibleTabs) rightStageStore.closeTab(tabKeyOf(t))
          collapse()
        }}
        onReorderTab={(a, b) => rightStageStore.reorderTab(a, b)}
        onReopenClosedTab={(key) => rightStageStore.reopenClosedTab(key)}
        onCollapse={() => collapse()}
        launcherItems={[]}
        renderContent={renderContent}
      />
    </div>
  )
}

/** 供 JS 页轮询时 bump 宿主刷新 */
export function TaskDetailRightStageHostWithTick(props: TaskDetailRightStageHostProps) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const onBump = () => setTick((n) => n + 1)
    window.addEventListener('evopanel:task-detail-stage-refresh', onBump)
    return () => window.removeEventListener('evopanel:task-detail-stage-refresh', onBump)
  }, [])
  return <TaskDetailRightStageHost {...props} refreshKey={(props.refreshKey || 0) + tick} />
}

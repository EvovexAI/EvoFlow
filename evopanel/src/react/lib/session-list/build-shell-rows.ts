import type { ChatSessionRow } from '../../chat-types.js'
import type { ResolvedLiveStreamActivity } from '../resolve-live-stream-activity.js'
import type { RunningSessionSummary } from '../../hooks/useRunningSessionSummaries.js'
import { formatRunningPreviewLine, formatSessionListTime, getDisplayLabel } from './display.js'
import { isSessionExecuting, isSessionGoalActive } from '../session-execution/index.js'
import type { ShellSidebarSyncRow, ShellWorkspaceGroup, WorkspaceGroupSummary } from './types.js'
import {
  buildShellGroupsFromSummaries,
  groupShellSidebarRowsByWorkspace,
  mergeRegisteredWorkspaceGroups,
  resolveSessionWorkspaceGroup,
} from './workspace-groups.js'
import { SESSION_RUNNING_ACTIVITY_LABEL } from '../resolve-live-stream-activity.js'

export type BuildShellSidebarRowsInput = {
  filteredSessions: ChatSessionRow[]
  selectedSessionKey: string
  runningSessionMap: Record<string, RunningSessionSummary>
  resolveLiveStreamActivityForSession: (
    sessionKey: string,
    isSelectedRow: boolean,
  ) => ResolvedLiveStreamActivity | null
  configuredWorkspaceRoot?: string
}

function resolveRunningPreviewLine(
  sessionKey: string,
  executing: boolean,
  isSelectedRow: boolean,
  runningSessionMap: Record<string, RunningSessionSummary>,
  resolveLiveStreamActivityForSession: (
    sessionKey: string,
    isSelectedRow: boolean,
  ) => ResolvedLiveStreamActivity | null,
): string {
  if (!executing) return ''
  const dockActivity = resolveLiveStreamActivityForSession(sessionKey, isSelectedRow)
  const dockLine = String(dockActivity?.dockLabel || '').trim()
  if (dockLine) return dockLine
  const summary = runningSessionMap[sessionKey]
  const fromSummary = formatRunningPreviewLine({
    runningPreviewLine: '',
    runningPreview: summary?.previewText,
    runningToolSummary: summary?.toolSummary,
  })
  if (fromSummary) return fromSummary
  return SESSION_RUNNING_ACTIVITY_LABEL
}

export function buildShellSidebarRows(input: BuildShellSidebarRowsInput): ShellSidebarSyncRow[] {
  const {
    filteredSessions,
    selectedSessionKey,
    runningSessionMap,
    resolveLiveStreamActivityForSession,
    configuredWorkspaceRoot = '',
  } = input

  const sel = String(selectedSessionKey || '').trim()
  const list = filteredSessions

  return list.map((s) => {
    const sessionKey = String(s.sessionKey || '')
    const isSelectedRow = sel === sessionKey
    const executing = isSessionExecuting(sessionKey, { sessionRow: s })
    const runningPreviewLine = executing
      ? ''
      : resolveRunningPreviewLine(
          sessionKey,
          executing,
          isSelectedRow,
          runningSessionMap,
          resolveLiveStreamActivityForSession,
        )
    const isGoal = isSessionGoalActive(sessionKey)
    const summary = runningSessionMap[sessionKey]
    const ws = resolveSessionWorkspaceGroup(s, configuredWorkspaceRoot)

    return {
      sessionKey,
      title: getDisplayLabel(sessionKey, s.title),
      time: formatSessionListTime(s, { executing }),
      createdAt: Number(s.createdAt ?? 0),
      updatedAt: Number(s.updatedAt ?? s.lastActivity ?? s.createdAt ?? 0),
      active: false,
      canDelete: true,
      executing,
      runningPreviewLine,
      hasUnseenRunningUpdate: !!summary?.hasUnseenUpdate,
      isPinned: !!s.isPinned,
      pinOrder: Number(s.pinOrder ?? 0),
      goalActive: isGoal,
      workspaceKey: ws.workspaceKey,
      workspaceLabel: ws.label,
    }
  })
}

export type BuildShellSidebarGroupsInput = BuildShellSidebarRowsInput & {
  configuredWorkspaceRoot?: string
  registeredWorkspacePaths?: string[]
  workspaceSummaries?: WorkspaceGroupSummary[]
  workspacePagination?: Record<string, { hasMore: boolean; loading: boolean }>
}

export function buildShellSidebarGroups(input: BuildShellSidebarGroupsInput): ShellWorkspaceGroup[] {
  const configured = String(input.configuredWorkspaceRoot || '').trim()
  const rows = buildShellSidebarRows({ ...input, configuredWorkspaceRoot: configured })
  const sessionsByKey = new Map(
    input.filteredSessions
      .map((s) => [String(s.sessionKey || '').trim(), s] as const)
      .filter(([k]) => !!k),
  )
  const grouped = groupShellSidebarRowsByWorkspace(rows, sessionsByKey, configured)
  const registered = Array.isArray(input.registeredWorkspacePaths)
    ? input.registeredWorkspacePaths
    : []
  const summaries = Array.isArray(input.workspaceSummaries) ? input.workspaceSummaries : []
  const pag = input.workspacePagination || {}

  // API workspace-groups 通常已包含全局注册目录；但新建工作空间刚在本地注册、
  // 尚未进后端 summaries，需把 registered 一并传入合并，避免刷新后才出现。
  const base =
    summaries.length > 0
      ? buildShellGroupsFromSummaries(summaries, grouped, registered)
      : mergeRegisteredWorkspaceGroups(grouped, registered)

  return base.map((g) => {
    const p = pag[g.workspaceKey]
    return {
      ...g,
      hasMoreSessions: !!p?.hasMore,
      loadingSessions: !!p?.loading,
    }
  })
}

export { formatRunningPreviewLine } from './display.js'

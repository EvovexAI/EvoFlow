/** 侧栏会话行视图模型（ChatApp → ShellSessionListPortal） */
export type ShellSidebarSyncRow = {
  sessionKey: string
  title: string
  time: string
  createdAt: number
  updatedAt: number
  active: boolean
  canDelete: boolean
  executing: boolean
  runningPreviewLine: string
  hasUnseenRunningUpdate: boolean
  isPinned: boolean
  pinOrder: number
  goalActive: boolean
  /** 所属工作空间 key（路径 lowercase / 特殊组） */
  workspaceKey: string
  /** 侧栏展示用短标签（目录 basename 等） */
  workspaceLabel: string
}

/** API：工作目录汇总（侧栏文件夹计数） */
export type WorkspaceGroupSummary = {
  workspaceKey: string
  localWorkspaceRoot?: string | null
  useVirtualPaths?: boolean
  sessionCount: number
  maxUpdatedAt?: number
}

/** 侧栏：工作目录分组 */
export type ShellWorkspaceGroup = {
  workspaceKey: string
  label: string
  path: string
  sessionCount: number
  sessions: ShellSidebarSyncRow[]
  hasMoreSessions?: boolean
  loadingSessions?: boolean
}

/** 侧栏同步 payload 信封 */
export type ShellSidebarSyncPayload = {
  listLoading: boolean
  sessionFilter: string
  moreMenuKey: string | null
  /** 当前选中会话；侧栏高亮只读此字段（配合本地 optimistic） */
  selectedSessionKey: string
  newTaskActive: boolean
  rows: ShellSidebarSyncRow[]
  groups: ShellWorkspaceGroup[]
}

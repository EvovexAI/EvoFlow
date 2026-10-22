/** Right-side extensible stage — shared types (EvoPanel). */

export type RightStageLayout = 'half' | 'wide' | 'narrow' | 'workspace-write'

export type RightStageKind =
  | 'workspace-browse'
  | 'write'
  | 'artifacts'
  | 'mind-map'
  | 'collab-workflow'
  | 'platform-feedback'
  | 'news-dashboard'
  | 'web-embed'
  | string

export type RightStageSurface = {
  id: string
  kind: RightStageKind
  title?: string
  layout?: RightStageLayout
  data: Record<string, unknown>
  /** 归属会话；有值时 UI 按当前 sessionKey 过滤可见标签。 */
  sessionKey?: string
}

export type RightStageStreamChunk = {
  streamId: string
  text: string
  newline?: boolean
  level?: 'info' | 'success' | 'warning' | 'error' | 'muted'
}

export type RightStageStreamSession = {
  streamId: string
  format: 'plain' | 'markdown' | 'code'
  path?: string
  title?: string
  chunks: RightStageStreamChunk[]
  closed?: boolean
}

export const RIGHT_STAGE_KIND_LABELS: Record<string, string> = {
  'workspace-browse': '工作区文件',
  write: '写入内容',
  file: '文件预览',
  codeViewer: '代码对比',
  summary: '摘要',
  terminal: '终端',
  artifacts: '本轮产物',
  'mind-map': '思维导图',
  'collab-workflow': '工作流',
  'platform-feedback': '平台操作',
  'news-dashboard': '资讯',
  'web-embed': '网页',
  browser: '浏览器',
}

/** Normalize panel kind aliases (legacy workspace-write / write-stream). */
export function normalizeRightStageKind(kind: string | null | undefined): string {
  const k = String(kind || '').trim()
  if (!k) return ''
  switch (k) {
    case 'write-stream':
    case 'write_stream':
    case 'workspace-write':
    case 'workspace_write':
      return 'write'
    default:
      return k
  }
}

export function defaultTitleForKind(kind: string): string {
  const k = normalizeRightStageKind(kind)
  return RIGHT_STAGE_KIND_LABELS[k] || k || 'Panel'
}

export function defaultLayoutForKind(kind: string): RightStageLayout {
  switch (normalizeRightStageKind(kind)) {
    case 'workspace-browse':
    case 'summary':
      return 'narrow'
    case 'platform-feedback':
      return 'narrow'
    case 'terminal':
      return 'half'
    case 'write':
    case 'artifacts':
      return 'workspace-write'
    case 'file':
    case 'browser':
    case 'news-dashboard':
    case 'web-embed':
      return 'wide'
    default:
      return 'half'
  }
}

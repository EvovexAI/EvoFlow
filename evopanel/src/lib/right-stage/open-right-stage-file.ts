/**
 * 对话内打开文件 / 代码预览 → 右侧 Side Pane（对齐 ZCode code-viewer）。
 *
 * 不要走 WorkspaceFilePreviewModal / FileEditDiffModal：那些是近全屏遮罩，
 * 会盖住主对话。主对话、小V、工具卡、产出卡共用本入口。
 */
import { rightStageStore } from './right-stage-store.js'

/**
 * 接受 ZCode CodeViewerSource（联合类型）及任意带 path/title 的预览源。
 * 用宽松对象，避免联合成员与精确结构类型互斥。
 */
export type RightStageCodeViewerSource = {
  type: string
  title?: string
  path?: string
  workspacePath?: string
  workspaceIdentity?: string
  workspaceRemoteSessionId?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 透传完整 source 给 PreviewPane
  [extra: string]: any
}

/** 入参：任意 CodeViewerSource 状对象（联合类型可直接传入）。 */
export type RightStageCodeViewerSourceInput = {
  type: string
  title?: string
  path?: string
  workspacePath?: string
  workspaceIdentity?: string
  workspaceRemoteSessionId?: string
}

function basename(path: string): string {
  const parts = String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  return parts[parts.length - 1] || path || '文件'
}

function normalizePathId(path: string): string {
  return String(path || '').replace(/\\/g, '/')
}

export type OpenRightStageCodeViewerOpts = {
  sessionKey?: string | null
  threadId?: string | null
  /** 默认 half：侧栏可读，不把对话挤没。 */
  layout?: 'half' | 'wide' | 'narrow' | 'workspace-write'
}

/** ZCode CodeViewerSource → 右栏 codeViewer 标签。 */
export function showRightStageCodeViewer(
  source: RightStageCodeViewerSourceInput,
  opts?: OpenRightStageCodeViewerOpts,
): string {
  const pathOrTitle = String(source.path || source.title || 'diff').trim()
  const id = `codeViewer:${normalizePathId(pathOrTitle)}`
  const key = `codeViewer:${id}`
  rightStageStore.show({
    kind: 'codeViewer',
    id,
    title: source.title || basename(pathOrTitle) || '代码对比',
    layout: opts?.layout || 'half',
    sessionKey: String(opts?.sessionKey || '').trim() || undefined,
    data: {
      // 原样透传，PreviewPane 需要完整联合成员字段（patch / media 等）
      source: source as RightStageCodeViewerSource,
      threadId: String(opts?.threadId || '').trim(),
    },
  })
  return key
}

/** 批量打开；激活第一张（对齐 ZCode openCodeViewerSidePanes activeIndex=0）。 */
export function showRightStageCodeViewers(
  sources: readonly RightStageCodeViewerSourceInput[],
  opts?: OpenRightStageCodeViewerOpts,
): void {
  if (!sources?.length) return
  let firstKey: string | null = null
  for (const source of sources) {
    const key = showRightStageCodeViewer(source, opts)
    if (!firstKey) firstKey = key
  }
  if (firstKey) rightStageStore.activateTab(firstKey)
}

export type OpenRightStageFilePreviewOpts = {
  sessionKey?: string | null
  name?: string
  poll?: boolean
  focusLine?: number
  focusEndLine?: number
  focusAnnotation?: { title?: string; body?: string; priority?: number } | null
  layout?: 'half' | 'wide' | 'narrow' | 'workspace-write'
}

/** 工作区文件路径 → 右栏 file 标签（WorkspaceFilePreviewPanel）。 */
export function showRightStageFilePreview(
  path: string,
  opts?: OpenRightStageFilePreviewOpts,
): string {
  const id = normalizePathId(path)
  const name = String(opts?.name || '').trim() || basename(id)
  const key = `file:${id}`
  rightStageStore.show({
    kind: 'file',
    id,
    title: name,
    layout: opts?.layout || 'half',
    sessionKey: String(opts?.sessionKey || '').trim() || undefined,
    data: {
      path: id,
      name,
      poll: !!opts?.poll,
      focusLine: opts?.focusLine,
      focusEndLine: opts?.focusEndLine,
      focusAnnotation: opts?.focusAnnotation || null,
    },
  })
  return key
}

/**
 * Markdown 文件链接 / 目录提示 → 右栏。
 * 目录仍按文件预览打开（PreviewPane/stat 会给出可读错误）；调用方若要树浏览可另分流。
 */
export function showRightStageFromFileLink(
  target: {
    path: string
    label?: string
    workspacePath?: string
    workspaceIdentity?: string
    workspaceRemoteSessionId?: string
  },
  opts?: OpenRightStageCodeViewerOpts,
): string {
  const path = String(target.path || '').trim()
  return showRightStageCodeViewer(
    {
      type: 'file',
      title: String(target.label || '').trim() || basename(path),
      path,
      ...(target.workspacePath ? { workspacePath: target.workspacePath } : {}),
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      ...(target.workspaceRemoteSessionId
        ? { workspaceRemoteSessionId: target.workspaceRemoteSessionId }
        : {}),
    },
    opts,
  )
}

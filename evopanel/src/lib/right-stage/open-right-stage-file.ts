/**
 * 对话内打开文件 / 代码预览 → 右侧 Side Pane（对齐 ZCode code-viewer）。
 *
 * 不要走 WorkspaceFilePreviewModal / FileEditDiffModal：那些是近全屏遮罩，
 * 会盖住主对话。主对话、小V、工具卡、产出卡共用本入口。
 *
 * 分流：
 * - 话术 Markdown 路径 pill / 普通文件 → `file`（WorkspaceFilePreviewPanel）
 * - 目录 / 无扩展名路径 → `workspace-browse`（文件树并定位）
 * - patch / diff / pptx / pdf / 多媒体 → `codeViewer`（PreviewPane）
 */
import { getChatWorkspaceRoot } from '../chat-workspace-context.js'
import {
  isAbsoluteHostPath,
  resolveWorkspaceRelativeHostPath,
} from '../workspace-abs-path.js'
import { rightStageStore } from './right-stage-store.js'
import { logPanelSet } from './panel-set-debug-log.js'
import { getCurrentRightStageSessionKey } from './right-stage-scope.js'
import { isRightStageTabVisibleForSession } from './right-stage-session-visibility.js'
import { defaultTitleForKind } from './right-stage-types.js'

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

/**
 * 对话路径是否更像目录（应开文件树），而不是可读文件预览。
 * - 显式 pathKind=directory / 尾随斜杠
 * - 末段没有常见文件扩展名（projects/foo-20261029）
 */
export function looksLikeWorkspaceDirectoryPath(
  path: string,
  pathKind?: string | null,
): boolean {
  if (String(pathKind || '').trim() === 'directory') return true
  const raw = String(path || '').trim()
  if (!raw) return false
  if (/[\\/]$/.test(raw)) return true
  const leaf = basename(raw)
  if (!leaf || leaf === '.' || leaf === '..') return true
  // `.gitignore` / `.env` 当文件；`foo.mp4` / `a.tsx` 当文件
  if (/^\.[^.\\/]+$/.test(leaf)) return false
  if (/\.[a-zA-Z0-9]{1,12}$/.test(leaf)) return false
  return true
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
  // id 不含 kind 前缀：tabKey = `${kind}:${id}` = `codeViewer:<path>`
  const id = normalizePathId(pathOrTitle) || 'diff'
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

/**
 * CodeViewerSource 统一入口：普通文件走右侧「文件」区，其余类型走 PreviewPane。
 * 避免话术路径 pill / 工具卡 type:file 占满 codeViewer 且关不掉。
 */
export function openRightStageForCodeViewerSource(
  source: RightStageCodeViewerSourceInput,
  opts?: OpenRightStageCodeViewerOpts & { name?: string },
): string {
  if (source?.type === 'file') {
    const path = String(source.path || '').trim()
    if (path) {
      const workspaceRoot = String(source.workspacePath || '').trim() || undefined
      if (looksLikeWorkspaceDirectoryPath(path)) {
        return showRightStageWorkspaceBrowse({
          focusPath: path,
          workspaceRoot,
          sessionKey: opts?.sessionKey,
        })
      }
      return showRightStageFilePreview(path, {
        name: String(opts?.name || source.title || '').trim() || undefined,
        sessionKey: opts?.sessionKey,
        layout: opts?.layout,
        workspaceRoot,
      })
    }
  }
  return showRightStageCodeViewer(source, opts)
}

/** 批量打开；激活第一张（对齐 ZCode openCodeViewerSidePanes activeIndex=0）。 */
export function showRightStageCodeViewers(
  sources: readonly RightStageCodeViewerSourceInput[],
  opts?: OpenRightStageCodeViewerOpts,
): void {
  if (!sources?.length) return
  let firstKey: string | null = null
  for (const source of sources) {
    const key = openRightStageForCodeViewerSource(source, opts)
    if (!firstKey) firstKey = key
  }
  if (firstKey) rightStageStore.activateTab(firstKey)
}

export type OpenRightStageFilePreviewOpts = {
  sessionKey?: string | null
  name?: string
  /** 任务中心 / 员工页预览时带上，避免宿主读文件时 workspaceRoot 为空。 */
  workspaceRoot?: string | null
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
  // 修复被剥掉盘符的 Windows 绝对路径，并把半路径（projects\\…\\x.mp4）
  // 拼到会话 / 员工绑定的 workspace 根上，否则右栏读文件失败或对话里点不开。
  const rawPath = String(path || '').trim()
  const workspaceRoot =
    String(opts?.workspaceRoot || '').trim() || String(getChatWorkspaceRoot() || '').trim() || undefined
  const resolved = resolveWorkspaceRelativeHostPath(rawPath, workspaceRoot || '')
  const id = normalizePathId(
    isAbsoluteHostPath(resolved) ? resolved : rawPath,
  )
  const name = String(opts?.name || '').trim() || basename(id)
  const key = `file:${id}`
  const sessionKey = String(opts?.sessionKey || '').trim() || undefined
  const layout = opts?.layout || 'half'
  logPanelSet('③ showRightStageFilePreview → store.show', {
    path: id,
    name,
    key,
    sessionKey: sessionKey || '(空)',
    workspaceRoot: workspaceRoot || '(空)',
    layout,
  })
  rightStageStore.show({
    kind: 'file',
    id,
    title: name,
    layout,
    sessionKey,
    data: {
      path: id,
      name,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      poll: !!opts?.poll,
      focusLine: opts?.focusLine,
      focusEndLine: opts?.focusEndLine,
      focusAnnotation: opts?.focusAnnotation || null,
    },
  })
  const snap = rightStageStore.getSnapshot()
  const uiSk = getCurrentRightStageSessionKey()
  const opened = snap.tabs.find((t) => `${t.kind}:${t.id}` === key)
  const visible =
    opened && isRightStageTabVisibleForSession(opened, uiSk)
  logPanelSet('③ store.show 之后快照', {
    collapsed: snap.collapsed,
    activeKey: snap.activeKey,
    tabCount: snap.tabs.length,
    tabs: snap.tabs.map((t) => `${t.kind}:${t.id}(sk=${t.sessionKey || '无'})`),
    surfaceKind: snap.surface?.kind,
    当前UI会话: uiSk || '(空)',
    标签对当前会话可见: visible,
  })
  if (opened && !visible) {
    logPanelSet('③ 警告：标签已写入但当前会话过滤后不可见（sessionKey 不一致）', {
      tabSessionKey: opened.sessionKey,
      uiSessionKey: uiSk,
    })
  }
  return key
}

export type OpenRightStageWorkspaceBrowseOpts = {
  sessionKey?: string | null
  /** 展开并定位到的目录/文件绝对路径（或已拼好的 workspace 内路径）。 */
  focusPath?: string | null
  workspaceRoot?: string | null
  title?: string | null
}

/** 右栏「工作区文件」树；可带 focusPath 展开到对话里点的那一层目录。 */
export function showRightStageWorkspaceBrowse(
  opts?: OpenRightStageWorkspaceBrowseOpts,
): string {
  const workspaceRoot =
    String(opts?.workspaceRoot || '').trim() || String(getChatWorkspaceRoot() || '').trim() || undefined
  const focusRaw = String(opts?.focusPath || '').trim()
  const focusPath = focusRaw
    ? normalizePathId(resolveWorkspaceRelativeHostPath(focusRaw, workspaceRoot || ''))
    : ''
  const id = focusPath ? `focus:${focusPath}` : 'root'
  const key = `workspace-browse:${id}`
  const title =
    String(opts?.title || '').trim() ||
    (focusPath ? basename(focusPath) : defaultTitleForKind('workspace-browse'))
  logPanelSet('③ showRightStageWorkspaceBrowse → store.show', {
    focusPath: focusPath || '(根)',
    workspaceRoot: workspaceRoot || '(空)',
    sessionKey: String(opts?.sessionKey || '').trim() || '(空)',
  })
  rightStageStore.show({
    kind: 'workspace-browse',
    id,
    title,
    layout: 'workspace-browse',
    sessionKey: String(opts?.sessionKey || '').trim() || undefined,
    data: {
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(focusPath ? { focusPath } : {}),
    },
  })
  return key
}

/**
 * Markdown 文件链接 / 目录提示 → 右栏。
 * 目录（或无扩展名路径）开文件树并定位；普通文件走预览。
 */
export function showRightStageFromFileLink(
  target: {
    path: string
    label?: string
    pathKind?: string
    workspacePath?: string
    workspaceIdentity?: string
    workspaceRemoteSessionId?: string
  },
  opts?: OpenRightStageCodeViewerOpts,
): string {
  const path = String(target.path || '').trim()
  const workspaceRoot = String(target.workspacePath || '').trim() || undefined
  if (looksLikeWorkspaceDirectoryPath(path, target.pathKind)) {
    return showRightStageWorkspaceBrowse({
      focusPath: path,
      workspaceRoot,
      sessionKey: opts?.sessionKey,
      title: String(target.label || '').trim() || basename(path),
    })
  }
  return showRightStageFilePreview(path, {
    name: String(target.label || '').trim() || basename(path),
    sessionKey: opts?.sessionKey,
    layout: opts?.layout,
    // 对话 Markdown 路径 pill 带上 workspace，预览读文件才能带 root=…
    workspaceRoot,
  })
}

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { showConfirm } from '../../components/modal.js'
import { toast } from '../../components/toast.js'
import {
  formatWorkspacePathForDisplay,
  normalizeWorkspaceReadPath,
  normalizeWorkspaceRelPath,
} from '../../lib/workspace-api-scope.js'
import { buildWorkspaceMediaPreviewFields } from '../../lib/chat-image-src.js'
import { isStreamWriteContentDisplayable, resolveWritePreviewPath } from '../../lib/workspace-preview-path.js'
import { WorkspaceFilePreviewPane, type WorkspacePreviewState } from './WorkspaceFilePreviewPane.js'
import { KvFolderIcon, KvTreeCaret } from './KvFolderIcons.js'
import { setWorkspacePathDragData } from '../lib/compose-attach.js'
import '../../style/kv-folder-tree.css'

export type ContextFileEntry = {
  path: string
  name: string
}

type BrowseEntry = {
  name: string
  path: string
  is_dir: boolean
  size?: number | null
  mtime?: number | null
}

function coerceTruthyFlag(v: unknown): boolean {
  return (
    v === true ||
    v === 1 ||
    v === '1' ||
    v === 'true' ||
    v === 'True' ||
    v === 'yes' ||
    v === 'YES'
  )
}

function normalizeBrowseEntry(raw: unknown): BrowseEntry {
  const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const name = String(e.name || '').trim()
  const path = String(e.path || name || '').trim()
  const type = String(e.type || e.kind || '').trim().toLowerCase()
  const isDir = !!(
    coerceTruthyFlag(e.is_dir) ||
    coerceTruthyFlag(e.isDir) ||
    coerceTruthyFlag(e.isdir) ||
    coerceTruthyFlag(e.directory) ||
    type === 'dir' ||
    type === 'directory' ||
    type === 'folder' ||
    name.endsWith('/') ||
    path.endsWith('/')
  )
  return {
    name: (name || path.split(/[/\\]/).pop() || path).replace(/\/+$/, '') || name || path,
    path: path.replace(/\/+$/, '') || path,
    is_dir: isDir,
    size: typeof e.size === 'number' ? e.size : e.size == null ? null : Number(e.size) || null,
    mtime: typeof e.mtime === 'number' ? e.mtime : e.mtime == null ? null : Number(e.mtime) || null,
  }
}

type FlatNode = {
  entry: BrowseEntry
  depth: number
  path: string
  parentIdx: number
}

type Props = {
  workspaceRoot: string
  threadId?: string
  selected: ContextFileEntry[]
  onToggleFile: (entry: ContextFileEntry) => void
  /** 普通文件查看：弹窗预览（由 ChatApp 挂载） */
  onOpenFilePreview?: (path: string, opts?: { poll?: boolean; name?: string }) => void
  /** Agent write 工具流式/刚完成写入：侧栏实时预览 */
  streamingWritePreview?: {
    path: string
    name: string
    content: string
    streaming: boolean
  } | null
  /** 与 ChatApp ``workspacePanelWritePreview`` 同步：写入预览模式下隐藏左侧文件树 */
  writePreviewMode?: boolean
  treePinned?: boolean
  onEscapeStreamPreview?: () => void
  indexWatchEnabled?: boolean
  onIndexWatchEnabledChange?: (enabled: boolean) => void
  /** 外部请求定位到某目录（绝对或相对工作区路径） */
  focusBrowsePath?: string | null
  onFocusBrowsePathConsumed?: () => void
}

type ContextMenuState = {
  x: number
  y: number
  entry: BrowseEntry
}

type CreateDialogState = { type: 'file' | 'folder'; parentPath: string }

// ── helpers ──────────────────────────────────────────────

function basename(p: string): string {
  const s = String(p || '').replace(/\\/g, '/')
  const parts = s.split('/').filter(Boolean)
  return parts[parts.length - 1] || s
}

function parentRelPath(relPath: string): string | null {
  if (!relPath || relPath === '.') return null
  return (
    relPath
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .slice(0, -1)
      .join('/') || '.'
  )
}

/** Map host abs / workspace-relative path → browse rel under ``root``. */
function toBrowseRelPath(rawPath: string, workspaceRoot: string): string {
  const raw = String(rawPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  if (!raw || raw === '.') return '.'
  const root = String(workspaceRoot || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  if (root) {
    const rawL = raw.toLowerCase()
    const rootL = root.toLowerCase()
    if (rawL === rootL) return '.'
    if (rawL.startsWith(`${rootL}/`)) return raw.slice(root.length + 1) || '.'
  }
  if (/^[a-zA-Z]:\//.test(raw) || (raw.startsWith('/') && !raw.startsWith('//'))) {
    // Outside bound root — still try last segments as relative browse hint
    const parts = raw.split('/').filter(Boolean)
    const outputsIdx = parts.findIndex((p) => p === 'outputs' || p === 'uploads' || p === 'workspace')
    if (outputsIdx >= 0) return parts.slice(outputsIdx).join('/') || '.'
  }
  return normalizeWorkspaceRelPath(raw) || raw || '.'
}

function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`
}

function formatTime(mtime: number | null | undefined): string {
  if (!mtime) return ''
  const d = new Date(mtime * 1000)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  if (sameYear) return `${mm}-${dd}`
  return `${String(d.getFullYear()).slice(-2)}-${mm}-${dd}`
}

const MENU_WIDTH = 180
const MENU_HEIGHT = 200
const MAX_RENDER_NODES = 500

function isTauriDesktop(): boolean {
  return !!(
    typeof window !== 'undefined' &&
    ((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ||
      (window as Window & { __TAURI__?: unknown }).__TAURI__)
  )
}

// ── component ────────────────────────────────────────────

export function WorkspaceFileTree({
  workspaceRoot,
  threadId,
  selected,
  onToggleFile,
  onOpenFilePreview,
  streamingWritePreview = null,
  writePreviewMode = false,
  treePinned: _treePinned = false,
  onEscapeStreamPreview,
  indexWatchEnabled = false,
  onIndexWatchEnabledChange,
  focusBrowsePath = null,
  onFocusBrowsePathConsumed,
}: Props) {
  const root = String(workspaceRoot || '').trim()
  const tid = String(threadId || '').trim()

  // ── state ──
  const [relPath, setRelPath] = useState('.')
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<BrowseEntry[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchIndexNote, setSearchIndexNote] = useState<string | null>(null)
  const [highlightPath, setHighlightPath] = useState<string | null>(null)
  const [settledPreview, setSettledPreview] = useState<WorkspacePreviewState | null>(null)

  // #1: tree expansion
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [dirCache, setDirCache] = useState<Map<string, BrowseEntry[]>>(new Map())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())

  // #8: keyboard navigation
  const [focusedIdx, setFocusedIdx] = useState(0)

  // #10: create file/folder
  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(null)
  const [createName, setCreateName] = useState('')

  // ── refs ──
  const menuRef = useRef<HTMLDivElement | null>(null)
  const searchTicketRef = useRef(0)
  const settledFetchTicketRef = useRef(0)
  const loadTicketRef = useRef(0)          // #5: race protection for load()
  const dirLoadEpochRef = useRef(0)        // invalidates stale loadDir() on root change

  // ── derived (no effects) ──
  const showAgentWritePreview = !!(
    streamingWritePreview?.streaming || String(streamingWritePreview?.path || '').trim()
  )
  const inWritePreviewLayout = !!(writePreviewMode || showAgentWritePreview)
  const hideFileTreeMenu = inWritePreviewLayout
  const showPreviewColumn = inWritePreviewLayout
  // #12: inline calculation — replaces 3 useEffect hooks + treeVisible state
  const treeVisible = !hideFileTreeMenu

  const isSearchMode = !!searchQuery.trim()

  // #3: memoised selectedSet
  const selectedSet = useMemo(
    () => new Set(selected.map((s) => s.path)),
    [selected],
  )

  // ── streaming write preview (unchanged) ──

  const streamPreviewForPane = useMemo((): WorkspacePreviewState | null => {
    if (!inWritePreviewLayout) return null
    if (!streamingWritePreview) {
      return {
        path: '',
        name: '写入中…',
        content: '',
        loading: false,
        error: null,
        binary: false,
        truncated: false,
        size: null,
        streaming: true,
      }
    }
    const s = streamingWritePreview
    const path = s.path
      ? normalizeWorkspaceReadPath(resolveWritePreviewPath(s.path) || s.path, root)
      : ''
    const name = s.name || (path ? basename(path) : '写入中…')
    if (s.streaming) {
      const raw = s.content ?? ''
      const content = isStreamWriteContentDisplayable({ path, content: raw, streaming: true })
        ? raw
        : ''
      return {
        path,
        name,
        content,
        loading: false,
        error: null,
        binary: false,
        truncated: false,
        size: null,
        streaming: true,
      }
    }
    if (settledPreview && settledPreview.path === path) return settledPreview
    return {
      path,
      name,
      content: s.content ?? '',
      loading: false,
      error: null,
      binary: false,
      truncated: false,
      size: null,
      streaming: false,
    }
  }, [inWritePreviewLayout, streamingWritePreview, settledPreview, root])

  const fetchSettledPreview = useCallback(
    async (path: string, name: string) => {
      const ticket = ++settledFetchTicketRef.current
      const mediaFields = buildWorkspaceMediaPreviewFields(root, path)
      if (mediaFields) {
        setSettledPreview({
          path,
          name,
          loading: false,
          content: '',
          error: null,
          binary: false,
          truncated: false,
          size: null,
          streaming: false,
          mediaSrc: mediaFields.mediaSrc,
          mediaKind: mediaFields.mediaKind as 'audio' | 'video' | 'image' | null | undefined,
        })
        return
      }
      setSettledPreview({
        path,
        name,
        loading: true,
        content: '',
        error: null,
        binary: false,
        truncated: false,
        size: null,
        streaming: false,
      })
      try {
        const { api } = await import('../../lib/tauri-api.js')
        const data = await api.readWorkspaceFile(root, path, tid || undefined)
        if (settledFetchTicketRef.current !== ticket) return
        if (data?.binary) {
          setSettledPreview({
            path,
            name,
            loading: false,
            content: '',
            error: null,
            binary: true,
            truncated: false,
            size: data?.size ?? null,
            streaming: false,
          })
          return
        }
        setSettledPreview({
          path,
          name,
          loading: false,
          content: String(data?.content ?? ''),
          error: null,
          binary: false,
          truncated: !!data?.truncated,
          size: data?.size ?? null,
          streaming: false,
        })
      } catch (e) {
        if (settledFetchTicketRef.current !== ticket) return
        const msg = String((e as Error)?.message || e || '无法读取文件')
        setSettledPreview({
          path,
          name,
          loading: false,
          content: '',
          error: msg,
          binary: false,
          truncated: false,
          size: null,
          streaming: false,
        })
      }
    },
    [root, tid],
  )

  useEffect(() => {
    if (!streamingWritePreview || streamingWritePreview.streaming) {
      // Defer state update to avoid cascading renders
      requestAnimationFrame(() => {
        setSettledPreview(null)
      })
      return
    }
    const path = normalizeWorkspaceReadPath(
      resolveWritePreviewPath(streamingWritePreview.path) || streamingWritePreview.path,
      root,
    )
    if (!path) return
    const name = streamingWritePreview.name || basename(path)
    queueMicrotask(() => void fetchSettledPreview(path, name))
  }, [
    streamingWritePreview?.path,
    streamingWritePreview?.name,
    streamingWritePreview?.streaming,
    fetchSettledPreview,
    streamingWritePreview,
  ])

  // ── load (root directory) with race protection (#5) + highlight clear (#7) ──

  const load = useCallback(async (path: string) => {
    if (!root && !tid) return
    const ticket = ++loadTicketRef.current
    dirLoadEpochRef.current++          // invalidate any in-flight loadDir
    setLoading(true)
    setError(null)
    setHighlightPath(null)             // #7: clear stale highlight on directory change
    setExpandedPaths(new Set())        // collapse all subtrees
    setDirCache(new Map())
    setFocusedIdx(0)
    try {
      const { api } = await import('../../lib/tauri-api.js')
      const data = await api.browseWorkspace(root, path, tid || undefined)
      if (loadTicketRef.current !== ticket) return  // #5: stale response guard
      setRelPath(String(data?.path || path || '.'))
      const raw = Array.isArray(data?.entries) ? data.entries : []
      setEntries(raw.map(normalizeBrowseEntry))
    } catch (e) {
      if (loadTicketRef.current !== ticket) return
      setError(String((e as Error)?.message || e))
      setEntries([])
    } finally {
      if (loadTicketRef.current === ticket) setLoading(false)
    }
  }, [root, tid])

  // ── loadDir (sub-directory for tree expansion, #1) ──

  const loadDir = useCallback(async (dirPath: string) => {
    const epoch = dirLoadEpochRef.current
    setLoadingDirs((prev) => new Set(prev).add(dirPath))
    try {
      const { api } = await import('../../lib/tauri-api.js')
      const data = await api.browseWorkspace(root, dirPath, tid || undefined)
      if (dirLoadEpochRef.current !== epoch) return  // root changed — discard
      const dirEntries = (Array.isArray(data?.entries) ? data.entries : []).map(normalizeBrowseEntry)
      setDirCache((prev) => {
        const m = new Map(prev)
        m.set(dirPath, dirEntries)
        return m
      })
    } catch {
      if (dirLoadEpochRef.current !== epoch) return
      // load failed — auto-collapse
      setExpandedPaths((prev) => {
        const s = new Set(prev)
        s.delete(dirPath)
        return s
      })
    } finally {
      if (dirLoadEpochRef.current === epoch) {
        setLoadingDirs((prev) => {
          const s = new Set(prev)
          s.delete(dirPath)
          return s
        })
      }
    }
  }, [root, tid])

  // ── toggleExpand (#1) ──

  const toggleExpand = useCallback((ent: BrowseEntry) => {
    const path = String(ent.path || ent.name)
    setExpandedPaths((prev) => {
      const s = new Set(prev)
      if (s.has(path)) {
        s.delete(path)
      } else {
        s.add(path)
        if (!dirCache.has(path)) void loadDir(path)
      }
      return s
    })
  }, [dirCache, loadDir])

  // ── openFilePreview ──

  const openFilePreview = useCallback(
    (rawPath: string, displayName?: string) => {
      const path = normalizeWorkspaceRelPath(rawPath)
      const name = displayName || basename(path)
      setHighlightPath(path)
      onOpenFilePreview?.(path, { name })
    },
    [onOpenFilePreview],
  )

  // ── effects ──

  // root / thread change → reload
  useEffect(() => {
    // Defer state updates to avoid cascading renders
    requestAnimationFrame(() => {
      setRelPath('.')
      setSearchQuery('')
      setSearchResults([])
      setDirCache(new Map())
      setExpandedPaths(new Set())
      setFocusedIdx(0)
    })
    queueMicrotask(() => void load('.'))
  }, [root, tid, load])

  // External focus (e.g. chat @@dir/@@ cite) → browse that folder
  useEffect(() => {
    const focus = String(focusBrowsePath || '').trim()
    if (!focus) return
    const browseRel = toBrowseRelPath(focus, root)
    queueMicrotask(() => {
      setSearchQuery('')
      void load(browseRel || '.')
      onFocusBrowsePathConsumed?.()
    })
  }, [focusBrowsePath, root, load, onFocusBrowsePathConsumed])

  // search debounce (unchanged logic)
  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) {
      // Defer state updates to avoid cascading renders
      queueMicrotask(() => {
        setSearchResults([])
        setSearchLoading(false)
        setSearchIndexNote(null)
      })
      return
    }
    const ticket = ++searchTicketRef.current
    queueMicrotask(() => setSearchLoading(true))
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const { api } = await import('../../lib/tauri-api.js')
          const data = await api.searchWorkspaceFiles(root, q, 40, tid || undefined)
          if (searchTicketRef.current !== ticket) return
          const results = (Array.isArray(data?.files) ? data.files : [])
            .map((f: { path?: string; name?: string }) => {
              const p = String(f?.path || '').trim()
              if (!p) return null
              return { name: String(f?.name || basename(p)), path: p, is_dir: false }
            })
            .filter((x: BrowseEntry | null): x is BrowseEntry => x != null)
          setSearchResults(results.sort((a: BrowseEntry, b: BrowseEntry) => a.path.localeCompare(b.path)))
          setSearchIndexNote(null)
        } catch (err) {
          if (searchTicketRef.current === ticket) {
            setSearchResults([])
            const msg = err instanceof Error ? err.message : String(err || '')
            setSearchIndexNote(msg.trim() ? `搜索失败：${msg.trim()}` : '搜索失败，请稍后重试')
          }
        } finally {
          if (searchTicketRef.current === ticket) setSearchLoading(false)
        }
      })()
    }, 200)
    return () => window.clearTimeout(timer)
  }, [searchQuery, root, tid])

  // context menu outside-click / Escape
  useEffect(() => {
    if (!contextMenu) return
    const close = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      setContextMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  // Escape → exit stream preview (unchanged)
  useEffect(() => {
    if (!onEscapeStreamPreview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!hideFileTreeMenu) return
      onEscapeStreamPreview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onEscapeStreamPreview, hideFileTreeMenu])

  // focusedIdx clamped inline during render (no effect needed)

  const displayEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return entries
    if (searchResults.length > 0) return searchResults
    if (searchLoading) return []
    return entries.filter(
      (e) =>
        String(e.name || '').toLowerCase().includes(q) ||
        String(e.path || '').toLowerCase().includes(q),
    )
  }, [entries, searchLoading, searchQuery, searchResults])

  const flatNodes = useMemo<FlatNode[]>(() => {
    const nodes: FlatNode[] = []
    if (isSearchMode) {
      for (const ent of displayEntries) {
        nodes.push({
          entry: ent,
          depth: 0,
          path: String(ent.path || ent.name),
          parentIdx: -1,
        })
      }
      return nodes
    }
    function walk(list: BrowseEntry[], depth: number, parentIdx: number) {
      for (const ent of list) {
        const idx = nodes.length
        const path = String(ent.path || ent.name)
        nodes.push({ entry: ent, depth, path, parentIdx })
        if (ent.is_dir && expandedPaths.has(path)) {
          const children = dirCache.get(path)
          if (children) walk(children, depth + 1, idx)
        }
      }
    }
    walk(entries, 0, -1)
    return nodes
  }, [isSearchMode, displayEntries, entries, expandedPaths, dirCache])

  // ── callbacks ──

  const toggleAttach = useCallback(
    (ent: BrowseEntry) => {
      const path = String(ent.path || ent.name)
      onToggleFile({ path, name: ent.name || basename(path) })
    },
    [onToggleFile],
  )

  const deleteFile = useCallback(
    async (ent: BrowseEntry) => {
      const path = String(ent.path || ent.name)
      const name = ent.name || basename(path)
      const yes = await showConfirm(`确定删除文件？\n\n${path}\n\n此操作不可撤销。`)
      if (!yes) return
      try {
        const { api } = await import('../../lib/tauri-api.js')
        await api.deleteWorkspaceFile(root, path, tid || undefined)
        if (selectedSet.has(path)) {
          onToggleFile({ path, name })
        }
        toast(`已删除：${name}`, 'success')
        // refresh the containing directory
        const parentPath = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '.'
        if (parentPath === '.' || parentPath === relPath) {
          void load(relPath)
        } else if (expandedPaths.has(parentPath)) {
          // invalidate cache so next expand reloads
          setDirCache((prev) => { const m = new Map(prev); m.delete(parentPath); return m })
          void loadDir(parentPath)
        }
      } catch (e) {
        toast(String((e as Error)?.message || e), 'error')
      }
    },
    [load, loadDir, onToggleFile, relPath, root, selectedSet, tid, expandedPaths],
  )

  const revealInFileManager = useCallback(
    async (ent: BrowseEntry) => {
      const path = String(ent.path || ent.name)
      setContextMenu(null)
      try {
        const { api } = await import('../../lib/tauri-api.js')
        const data = await api.resolveWorkspaceTarget(root, path, tid || undefined)
        const resolved = String(data?.resolved || '').trim()
        if (!resolved) {
          toast('无法解析文件路径', 'error')
          return
        }
        if (!data?.exists) {
          toast('文件或文件夹不存在', 'error')
          return
        }
        await api.revealPathInFileManager(resolved)
      } catch (e) {
        toast(String((e as Error)?.message || e), 'error')
      }
    },
    [root, tid],
  )

  // #10: create file / folder
  const handleCreate = useCallback(async () => {
    if (!createDialog || !createName.trim()) return
    const name = createName.trim()
    const basePath = createDialog.parentPath
    const newPath = basePath === '.' || basePath === relPath ? name : `${basePath}/${name}`
    try {
      const { api } = await import('../../lib/tauri-api.js')
      if (createDialog.type === 'file') {
        await api.writeWorkspaceFile(root, newPath, '', tid || undefined)
      } else {
        await api.createWorkspaceDir(root, newPath, tid || undefined)
      }
      toast(`已创建${createDialog.type === 'file' ? '文件' : '文件夹'}：${name}`, 'success')
      if (basePath === '.' || basePath === relPath) {
        void load(relPath)
      } else {
        setDirCache((prev) => { const m = new Map(prev); m.delete(basePath); return m })
        void loadDir(basePath)
      }
    } catch (e) {
      toast(String((e as Error)?.message || e), 'error')
    }
    setCreateDialog(null)
    setCreateName('')
  }, [createDialog, createName, relPath, root, tid, load, loadDir])

  // #11: jump to containing directory from search
  const jumpToParentDir = useCallback(
    (ent: BrowseEntry) => {
      const path = String(ent.path || ent.name)
      const parentPath = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '.'
      setSearchQuery('')
      setContextMenu(null)
      void load(parentPath)
      // highlight the file after load completes
      setTimeout(() => setHighlightPath(path), 300)
    },
    [load],
  )

  const parent = parentRelPath(relPath)

  // #8: keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLUListElement>) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (isSearchMode || createDialog || flatNodes.length === 0) return

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setFocusedIdx((prev) => Math.min(prev + 1, flatNodes.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setFocusedIdx((prev) => Math.max(prev - 1, 0))
          break
        case 'ArrowRight': {
          e.preventDefault()
          const node = flatNodes[focusedIdx]
          if (node?.entry.is_dir && !expandedPaths.has(node.path)) {
            toggleExpand(node.entry)
          }
          break
        }
        case 'ArrowLeft': {
          e.preventDefault()
          const node = flatNodes[focusedIdx]
          if (node?.entry.is_dir && expandedPaths.has(node.path)) {
            toggleExpand(node.entry)
          } else if (node && node.parentIdx >= 0) {
            setFocusedIdx(node.parentIdx)
          }
          break
        }
        case 'Enter': {
          e.preventDefault()
          const node = flatNodes[focusedIdx]
          if (!node) break
          if (node.entry.is_dir) {
            toggleExpand(node.entry)
          } else {
            openFilePreview(node.path, node.entry.name || basename(node.path))
          }
          break
        }
        case 'Backspace':
          e.preventDefault()
          if (parent != null) void load(parent)
          break
      }
    },
    [flatNodes, focusedIdx, expandedPaths, isSearchMode, createDialog, toggleExpand, openFilePreview, parent, load],
  )

  // ── row handlers ──

  const onRowClick = (ent: BrowseEntry) => {
    if (ent.is_dir) {
      toggleExpand(ent)   // #1: expand/collapse instead of navigate-into
      return
    }
    openFilePreview(String(ent.path || ent.name), ent.name || basename(String(ent.path || ent.name)))
  }

  const onRowContextMenu = (e: ReactMouseEvent, ent: BrowseEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, entry: ent })
  }

  // ── early return ──

  if (!root && !tid) {
    return (
      <div className="react-chat-workspace-tree-empty">
        <p>请先在输入框下方「工作空间」中选择本机项目目录，或切换到虚拟沙箱模式。</p>
        <p className="react-chat-workspace-tree-empty-hint">
          未绑定时，产出默认写在隐藏的应用数据目录（设置 → 文件与工作空间 →「当前生效的应用数据目录」可打开）。
        </p>
      </div>
    )
  }

  // ── computed ──

  const previewingPath = highlightPath ? normalizeWorkspaceRelPath(highlightPath) : ''

  // #4: limit rendered nodes to prevent DOM explosion
  const renderNodes = flatNodes.slice(0, MAX_RENDER_NODES)
  const truncatedCount = flatNodes.length - renderNodes.length

  // ── context menu (#6 boundary clamp + #11 search jump) ──

  const menuNode =
    contextMenu && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={menuRef}
            className="react-chat-workspace-context-menu"
            style={{
              left: Math.min(contextMenu.x, window.innerWidth - MENU_WIDTH - 8),
              top: Math.min(contextMenu.y, window.innerHeight - MENU_HEIGHT - 8),
            }}
            role="menu"
          >
            {contextMenu.entry.is_dir ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="react-chat-workspace-context-menu-item"
                  onClick={() => {
                    toggleExpand(contextMenu.entry)
                    setContextMenu(null)
                  }}
                >
                  {expandedPaths.has(String(contextMenu.entry.path || contextMenu.entry.name))
                    ? '折叠'
                    : '展开'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="react-chat-workspace-context-menu-item"
                  onClick={() => {
                    void load(String(contextMenu.entry.path || contextMenu.entry.name))
                    setContextMenu(null)
                  }}
                >
                  打开文件夹
                </button>
                {isTauriDesktop() ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="react-chat-workspace-context-menu-item"
                    onClick={() => void revealInFileManager(contextMenu.entry)}
                  >
                    在资源管理器中打开
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="react-chat-workspace-context-menu-item"
                  onClick={() => {
                    openFilePreview(
                      String(contextMenu.entry.path || contextMenu.entry.name),
                      contextMenu.entry.name,
                    )
                    setContextMenu(null)
                  }}
                >
                  打开查看
                </button>
                {isTauriDesktop() ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="react-chat-workspace-context-menu-item"
                    onClick={() => void revealInFileManager(contextMenu.entry)}
                  >
                    在资源管理器中显示
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="react-chat-workspace-context-menu-item"
                  onClick={() => {
                    toggleAttach(contextMenu.entry)
                    setContextMenu(null)
                  }}
                >
                  {selectedSet.has(String(contextMenu.entry.path || contextMenu.entry.name))
                    ? '从会话移除'
                    : '附加到会话'}
                </button>
                {isSearchMode ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="react-chat-workspace-context-menu-item"
                    onClick={() => jumpToParentDir(contextMenu.entry)}
                  >
                    在文件夹中显示
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="react-chat-workspace-context-menu-item react-chat-workspace-context-menu-item--danger"
                  onClick={() => {
                    setContextMenu(null)
                    void deleteFile(contextMenu.entry)
                  }}
                >
                  删除文件
                </button>
              </>
            )}
          </div>,
          document.body,
        )
      : null

  // ── tree column ──

  const treeColumn = (
    <div className={`react-chat-workspace-tree-col${treeVisible ? '' : ' is-collapsed'}`}>
      <div className="react-chat-workspace-tree kv-folder-tree-host">
        <div className="kv-browse-body">
          <div className="kv-browse-toolbar">
            <div className="kv-browse-filter">
              <KvFolderIcon name="search" size={15} />
              <input
                type="search"
                value={searchQuery}
                placeholder="搜索文件名…"
                aria-label="搜索工作区文件"
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="kv-browse-filter__clear"
                  aria-label="清除搜索"
                  title="清除"
                  onClick={() => setSearchQuery('')}
                >
                  <KvFolderIcon name="close" size={14} />
                </button>
              ) : null}
            </div>
            <button
              type="button"
              className="kv-browse-refresh"
              disabled={loading || searchLoading}
              onClick={() => (isSearchMode ? setSearchQuery('') : void load(relPath))}
              title="刷新"
            >
              <KvFolderIcon name="refresh" size={14} />
            </button>
            <button
              type="button"
              className="kv-browse-action"
              disabled={isSearchMode || loading}
              onClick={() => {
                setCreateDialog({ type: 'file', parentPath: relPath })
                setCreateName('')
              }}
              title="新建文件"
            >
              <KvFolderIcon name="file" size={14} />
            </button>
            <button
              type="button"
              className="kv-browse-action"
              disabled={isSearchMode || loading}
              onClick={() => {
                setCreateDialog({ type: 'folder', parentPath: relPath })
                setCreateName('')
              }}
              title="新建文件夹"
            >
              <KvFolderIcon name="folder" size={14} />
            </button>
          </div>

          <div className="kv-browse-extras">
            <div
              className="kv-browse-meta kv-browse-meta--inline"
              title={root || tid || '单击展开/预览；@ 附加；右键更多；方向键导航'}
            >
              <span className="kv-browse-meta-path">
                {isSearchMode
                  ? `搜索：${searchQuery.trim()}`
                  : `路径 ${relPath === '.' ? '/' : formatWorkspacePathForDisplay(relPath)}`}
              </span>
              {parent != null && !isSearchMode ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <button
                    type="button"
                    className="kv-browse-filter__clear"
                    style={{ display: 'inline', width: 'auto', height: 'auto', padding: 0 }}
                    disabled={loading}
                    onClick={() => void load(parent)}
                    title="返回上级"
                  >
                    上级
                  </button>
                </>
              ) : null}
              <span aria-hidden="true"> · </span>
              <span className="kv-browse-meta-hint">单击展开/预览；@ 附加；右键更多；方向键导航</span>
            </div>
            <label
              className="react-chat-workspace-tree-watch-toggle"
              title="开启后后台监听工作区文件变更并更新搜索索引；大仓库可能占用 CPU"
            >
              <span className="react-chat-workspace-tree-watch-toggle-label">实时监听文件夹</span>
              <span className="react-chat-workspace-tree-watch-switch">
                <input
                  type="checkbox"
                  checked={!!indexWatchEnabled}
                  onChange={(e) => onIndexWatchEnabledChange?.(e.target.checked)}
                />
                <span className="react-chat-workspace-tree-watch-slider" aria-hidden="true" />
              </span>
            </label>
          </div>

          {error ? <div className="kv-empty-inline">{error}</div> : null}
          {loading && !isSearchMode ? <div className="kv-empty-inline">正在加载文件夹结构…</div> : null}
          {isSearchMode && searchLoading ? <div className="kv-empty-inline">搜索中…</div> : null}
          {isSearchMode && !searchLoading && searchIndexNote ? (
            <div className="kv-empty-inline">{searchIndexNote}</div>
          ) : null}

          <div
            className="kv-browse-tree"
            role="tree"
            tabIndex={0}
            onKeyDown={handleKeyDown}
          >
            {createDialog ? (
              <div
                className="kv-tree-folder-head"
                style={{ paddingLeft: 8, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <KvFolderIcon name={createDialog.type === 'file' ? 'file' : 'folder'} size={15} />
                <input
                  type="text"
                  className="react-chat-workspace-tree-search-input"
                  style={{ flex: 1, height: 26, padding: '0 6px' }}
                  value={createName}
                  autoFocus
                  placeholder={createDialog.type === 'file' ? '输入文件名…' : '输入文件夹名…'}
                  onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleCreate()
                    }
                    if (e.key === 'Escape') {
                      setCreateDialog(null)
                      setCreateName('')
                    }
                  }}
                  onBlur={() => {
                    if (!createName.trim()) {
                      setCreateDialog(null)
                      setCreateName('')
                    }
                  }}
                />
              </div>
            ) : null}

            {!loading && !searchLoading && !error && flatNodes.length === 0 ? (
              <div className="kv-empty-inline">
                {isSearchMode ? searchIndexNote || '没有匹配的文件' : '此目录为空'}
              </div>
            ) : null}

            {renderNodes.map((node, i) => {
              const ent = node.entry
              const isDir = !!ent.is_dir
              const path = node.path
              const attached = !isDir && selectedSet.has(path)
              const isPreviewing =
                !isDir && previewingPath && normalizeWorkspaceRelPath(path) === previewingPath
              const isExpanded = isDir && expandedPaths.has(path)
              const isLoadingDir = isDir && loadingDirs.has(path)
              const isFocused = i === focusedIdx
              const pad = isDir ? 8 + node.depth * 16 : 12 + node.depth * 16
              if (isDir) {
                return (
                  <div
                    key={`${path}:${i}`}
                    className={`kv-tree-folder-row${isExpanded ? ' is-open' : ''}${
                      isFocused ? ' is-focused' : ''
                    }`}
                    style={{ paddingLeft: Math.max(4, pad - 4) }}
                  >
                    <button
                      type="button"
                      className="kv-tree-expand"
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? `折叠 ${ent.name}` : `展开 ${ent.name}`}
                      title={isExpanded ? '折叠' : '展开'}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setFocusedIdx(i)
                        toggleExpand(ent)
                      }}
                    >
                      <KvTreeCaret open={isExpanded} size={14} />
                    </button>
                    <button
                      type="button"
                      className="kv-tree-folder-head"
                      onClick={() => {
                        setFocusedIdx(i)
                        onRowClick(ent)
                      }}
                      onContextMenu={(e) => onRowContextMenu(e, ent)}
                    >
                      <KvFolderIcon name={isExpanded ? 'folder-open' : 'folder'} size={15} />
                      <span className="kv-tree-label">{ent.name}</span>
                      {isLoadingDir ? <span className="kv-tree-meta">…</span> : null}
                    </button>
                  </div>
                )
              }
              return (
                <button
                  key={`${path}:${i}`}
                  type="button"
                  className={`kv-tree-file${attached ? ' is-attached' : ''}${
                    isPreviewing ? ' is-previewing is-selected' : ''
                  }${isFocused ? ' is-focused' : ''}`}
                  style={{ paddingLeft: pad }}
                  draggable
                  onDragStart={(e) => {
                    const abs = String(ent.path || path || '').trim()
                    if (!abs) return
                    setWorkspacePathDragData(e.dataTransfer, {
                      path: abs,
                      name: ent.name || basename(abs),
                    })
                  }}
                  onClick={() => {
                    setFocusedIdx(i)
                    onRowClick(ent)
                  }}
                  onContextMenu={(e) => onRowContextMenu(e, ent)}
                >
                  <KvFolderIcon name="file" size={15} />
                  <span className="kv-tree-label">
                    {isSearchMode && ent.path !== ent.name ? (
                      <>
                        {ent.name}
                        <span className="kv-tree-label-sub">
                          {formatWorkspacePathForDisplay(ent.path)}
                        </span>
                      </>
                    ) : (
                      ent.name
                    )}
                  </span>
                  {ent.size != null || ent.mtime ? (
                    <span className="kv-tree-meta">
                      {formatSize(ent.size)}
                      {ent.size != null && ent.mtime ? ' · ' : ''}
                      {formatTime(ent.mtime)}
                    </span>
                  ) : null}
                  {attached ? (
                    <span className="kv-tree-attach" title="已附加到会话">
                      @
                    </span>
                  ) : null}
                </button>
              )
            })}

            {truncatedCount > 0 ? (
              <div className="kv-empty-inline">
                还有 {truncatedCount} 个项目未显示，请折叠部分目录或使用搜索
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <div
      className={`react-chat-workspace-drawer-inner${showPreviewColumn ? ' has-preview' : ''}${
        streamingWritePreview?.streaming ? ' is-agent-writing' : ''
      }${inWritePreviewLayout ? ' is-agent-write-preview' : ''}`}
    >
      {hideFileTreeMenu ? null : treeColumn}
      {showPreviewColumn ? (
        <div className="react-chat-workspace-preview-col">
          <WorkspaceFilePreviewPane
            preview={streamPreviewForPane}
            onClose={onEscapeStreamPreview}
            workspaceRoot={root}
          />
        </div>
      ) : null}
      {menuNode}
    </div>
  )
}

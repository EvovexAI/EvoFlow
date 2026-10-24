/**
 * Composer context-file attach (toggle / drag-drop / OS drop / home route).
 * Extracted from ChatApp.tsx (P4).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react'
import { composeAttachDragOver, parseComposeDataTransfer } from '../lib/compose-attach.js'
import type { ContextFileEntry } from '../components/WorkspaceFileTree.js'

export function useChatContextFiles(opts: { selectedSessionKey: string }) {
  const { selectedSessionKey } = opts

  const [contextFiles, setContextFiles] = useState<ContextFileEntry[]>([])
  /** 拖入/路径引用的本地图片全屏预览：null=关闭，number=打开的索引（仅统计图片项） */
  const [contextImagePreviewIndex, setContextImagePreviewIndex] = useState<number | null>(null)
  /** Home surface: attach routes to dashboard event instead of chat session context. */
  const isHomeSurfaceRef = useRef(false)

  const persistContextFiles = useCallback(
    async (files: ContextFileEntry[], sessionKey?: string) => {
      const sk = (sessionKey || selectedSessionKey || '').trim()
      if (!sk) return
      try {
        const { api } = await import('../../lib/tauri-api.js')
        await api.chatUpdateContext(sk, { context_files: files })
      } catch {
        /* ignore */
      }
    },
    [selectedSessionKey],
  )

  const toggleContextFile = useCallback(
    (entry: ContextFileEntry) => {
      setContextFiles((prev) => {
        const path = String(entry.path || '').trim()
        if (!path) return prev
        const hit = prev.find((x) => x.path === path)
        const next = hit
          ? prev.filter((x) => x.path !== path)
          : [...prev, { path, name: entry.name || path }]
        void persistContextFiles(next)
        return next
      })
    },
    [persistContextFiles],
  )

  const attachContextFiles = useCallback(
    (entries: Array<{ path: string; name?: string }>) => {
      setContextFiles((prev) => {
        const map = new Map(prev.map((f) => [f.path, f]))
        const added: Array<{ path: string; name: string }> = []
        for (const e of entries) {
          const path = String(e.path || '').trim()
          if (!path) continue
          if (!map.has(path)) {
            const name = String(e.name || '').trim() || path.replace(/^.*[/\\]/, '') || path
            map.set(path, { path, name })
            added.push({ path, name })
          }
        }
        const next = [...map.values()]
        if (next.length === prev.length) return prev
        void persistContextFiles(next)
        if (added.length) {
          void import('../../components/toast.js').then(({ toast }) => {
            for (const f of added) {
              toast(`已附加：${f.name}（发送后注入 Agent 上下文）`, 'info')
            }
          })
        }
        return next
      })
    },
    [persistContextFiles],
  )
  const attachContextFilesRef = useRef(attachContextFiles)
  attachContextFilesRef.current = attachContextFiles

  const dispatchHomeContextAttach = useCallback((entries: Array<{ path: string; name: string }>) => {
    if (!entries.length) return
    window.dispatchEvent(
      new CustomEvent('evopanel:home-attach-context', { detail: { contextFiles: entries } }),
    )
  }, [])

  const routeContextFileAttach = useCallback(
    (entries: Array<{ path: string; name?: string }>) => {
      const cleaned = entries
        .map((e) => {
          const path = String(e.path || '').trim()
          if (!path) return null
          const name = String(e.name || '').trim() || path.replace(/^.*[/\\]/, '') || path
          return { path, name }
        })
        .filter((x): x is { path: string; name: string } => !!x)
      if (!cleaned.length) return
      if (isHomeSurfaceRef.current) dispatchHomeContextAttach(cleaned)
      else attachContextFilesRef.current(cleaned)
    },
    [dispatchHomeContextAttach],
  )

  const handleConversationComposeDragOver = useCallback((e: ReactDragEvent<HTMLElement>) => {
    composeAttachDragOver(e)
  }, [])

  const handleConversationComposeDrop = useCallback(
    (e: ReactDragEvent<HTMLElement>) => {
      const result = parseComposeDataTransfer(e.dataTransfer, { fromPaste: false })
      if (!result.handled) return
      e.preventDefault()
      e.stopPropagation()
      if (result.contextFiles.length) routeContextFileAttach(result.contextFiles)
    },
    [routeContextFileAttach],
  )

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void import('../lib/compose-attach.js')
      .then(({ subscribeOsFileDrop, basenameFromPath }) =>
        subscribeOsFileDrop((paths) => {
          const entries = paths.map((path) => ({
            path,
            name: basenameFromPath(path),
          }))
          routeContextFileAttach(entries)
        }),
      )
      .then((fn) => {
        if (!fn) return
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [routeContextFileAttach])

  return {
    contextFiles,
    setContextFiles,
    contextImagePreviewIndex,
    setContextImagePreviewIndex,
    isHomeSurfaceRef,
    persistContextFiles,
    toggleContextFile,
    attachContextFiles,
    attachContextFilesRef,
    routeContextFileAttach,
    handleConversationComposeDragOver,
    handleConversationComposeDrop,
  }
}

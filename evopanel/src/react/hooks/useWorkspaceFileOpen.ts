/**
 * Open / reveal workspace files & session artifacts in right-stage / OS shell.
 * Extracted from ChatApp.tsx (P6).
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import { wsClient } from '../../lib/ws-client.js'
import { toast } from '../../components/toast.js'
import { toUserFacingError } from '../../lib/user-facing-error.js'
import { rightStageStore } from '../../lib/right-stage/right-stage-store.js'
import {
  resolveOpenableWorkspaceFile,
  resolveWorkspacePreviewTarget,
} from '../../lib/workspace-preview-path.js'
import { setWorkspaceRevertExecutor } from '../../lib/workspace-change-journal.js'
import type { ChatArtifact } from '../lib/chat-artifact.js'

export type WorkspaceOpenScope = {
  root: string
  configuredRoot: string
  useVirtualPaths: boolean
  sessionKey: string
}

export type OpenWorkspaceFilePreviewOpts = {
  poll?: boolean
  name?: string
  focusLine?: number
  focusEndLine?: number
  focusAnnotation?: { title?: string; body?: string; priority?: number }
}

export function useWorkspaceFileOpen(opts: {
  workspaceOpenScopeRef: MutableRefObject<WorkspaceOpenScope>
  rightStageSessionKeyRef: MutableRefObject<string>
}) {
  const { workspaceOpenScopeRef, rightStageSessionKeyRef } = opts

  const openWorkspaceFilePreview = useCallback(
    (rawUrl: string, previewOpts?: OpenWorkspaceFilePreviewOpts) => {
      const target = resolveWorkspacePreviewTarget(rawUrl, { name: previewOpts?.name })
      if (!target?.path) return
      const fileId = String(target.path || '').replace(/\\/g, '/')
      const showFileTab = (path: string, name: string) => {
        const id = String(path || '').replace(/\\/g, '/')
        rightStageStore.show({
          kind: 'file',
          id,
          title: name || id.split('/').filter(Boolean).pop() || '文件',
          layout: 'wide',
          sessionKey: rightStageSessionKeyRef.current || undefined,
          data: {
            path: id,
            name: name || '',
            poll: !!previewOpts?.poll,
            focusLine: previewOpts?.focusLine,
            focusEndLine: previewOpts?.focusEndLine,
            focusAnnotation: previewOpts?.focusAnnotation || null,
          },
        })
      }
      showFileTab(fileId, target.name)
      void (async () => {
        try {
          const scope = workspaceOpenScopeRef.current
          const root = scope.root
          const tid = root
            ? undefined
            : wsClient.getSessionThreadId(scope.sessionKey || '') || undefined
          const openable = await resolveOpenableWorkspaceFile({
            workspaceRoot: root,
            path: target.path,
            name: target.name,
            threadId: tid,
            workspaceScopeOpts: {
              configuredRoot: scope.configuredRoot,
              useVirtualPaths: scope.useVirtualPaths,
            },
          })
          if (!openable?.path || openable.path === target.path) return
          const nextId = String(openable.path || '').replace(/\\/g, '/')
          if (nextId !== fileId) {
            rightStageStore.closeTab(`file:${fileId}`)
          }
          showFileTab(nextId, openable.name || target.name)
        } catch {
          /* 保留原路径；预览面板会展示读取错误 */
        }
      })()
    },
    [workspaceOpenScopeRef, rightStageSessionKeyRef],
  )

  const openMessageFilePreview = useCallback(
    (
      rawUrl: string,
      name?: string,
      previewOpts?: {
        line?: number
        endLine?: number
        annotation?: { title?: string; body?: string; priority?: number }
      },
    ) => {
      const target = resolveWorkspacePreviewTarget(rawUrl, { name })
      if (!target?.path) {
        toast('无法在工作区预览该文件', 'warning')
        return
      }
      openWorkspaceFilePreview(rawUrl, {
        name: target.name,
        poll: false,
        focusLine: previewOpts?.line,
        focusEndLine: previewOpts?.endLine,
        focusAnnotation: previewOpts?.annotation,
      })
    },
    [openWorkspaceFilePreview],
  )

  useEffect(() => {
    let cancelled = false
    setWorkspaceRevertExecutor(
      async (
        sessionKey: string,
        entries: Array<{
          path: string
          beforeContent: string | null
          existed: boolean
          deleted: boolean
        }>,
      ) => {
        const { api } = await import('../../lib/tauri-api.js')
        if (cancelled) return { restored: [], skipped: entries.map((e) => e.path) }
        const scope = workspaceOpenScopeRef.current
        const root = String(scope.root || '').trim()
        const tid = root ? undefined : wsClient.getSessionThreadId(sessionKey || '') || undefined
        const scopeOpts = root
          ? undefined
          : { configuredRoot: scope.configuredRoot, useVirtualPaths: scope.useVirtualPaths }
        const restored: string[] = []
        const skipped: string[] = []
        for (const entry of entries) {
          try {
            if (entry.existed && typeof entry.beforeContent === 'string') {
              await api.writeWorkspaceFile(root, entry.path, entry.beforeContent, tid, scopeOpts)
              restored.push(entry.path)
            } else {
              skipped.push(entry.path)
            }
          } catch {
            skipped.push(entry.path)
          }
        }
        if (restored.length) toast(`已撤销 ${restored.length} 个文件的更改`)
        if (skipped.length) toast(`${skipped.length} 个文件没有修改前快照，已跳过`, 'warning')
        return { restored, skipped }
      },
    )
    return () => {
      cancelled = true
      setWorkspaceRevertExecutor(null)
    }
  }, [workspaceOpenScopeRef])

  const openWorkspaceFilePreviewRef = useRef(openWorkspaceFilePreview)
  openWorkspaceFilePreviewRef.current = openWorkspaceFilePreview

  const revealWorkspacePath = useCallback(async (rawPath: string) => {
    const path = String(rawPath || '').trim()
    if (!path) {
      toast('没有可打开的本地路径', 'info')
      return
    }
    try {
      const { api } = await import('../../lib/tauri-api.js')
      const scope = workspaceOpenScopeRef.current
      const root = String(scope.root || '').trim()
      const tid = root
        ? undefined
        : wsClient.getSessionThreadId(scope.sessionKey || '') || undefined
      let resolved = path
      const looksAbs =
        /^[a-zA-Z]:[\\/]/.test(path) || (path.startsWith('/') && !path.startsWith('//'))
      if (looksAbs) {
        try {
          const info = await api.resolveWorkspacePath(path)
          resolved = String(info?.resolved || path).trim() || path
        } catch {
          resolved = path
        }
      } else {
        const info = await api.resolveWorkspaceTarget(root || undefined, path, tid, {
          configuredRoot: scope.configuredRoot,
          useVirtualPaths: scope.useVirtualPaths,
        })
        resolved = String(info?.resolved || path).trim() || path
        if (info?.exists === false) {
          toast(`文件不存在：${resolved}`, 'error')
          return
        }
      }
      await api.revealPathInFileManager(resolved)
      toast('已在文件管理器中打开', 'success')
    } catch (e) {
      toast(toUserFacingError((e as Error)?.message || e), 'error')
    }
  }, [workspaceOpenScopeRef])

  const revealWorkspacePathRef = useRef(revealWorkspacePath)
  revealWorkspacePathRef.current = revealWorkspacePath

  const openSessionArtifact = useCallback((item: ChatArtifact) => {
    if (item.url && !item.path) {
      try {
        window.open(item.url, '_blank', 'noopener,noreferrer')
      } catch {
        /* ignore */
      }
      return
    }
    if (item.path) {
      openWorkspaceFilePreviewRef.current(item.path, { name: item.name })
    }
  }, [])

  const revealSessionArtifact = useCallback(
    (item: ChatArtifact) => {
      if (item.url && !item.path) {
        try {
          window.open(item.url, '_blank', 'noopener,noreferrer')
        } catch {
          /* ignore */
        }
        return
      }
      if (item.path) void revealWorkspacePath(item.path)
    },
    [revealWorkspacePath],
  )

  return {
    openWorkspaceFilePreview,
    openMessageFilePreview,
    openWorkspaceFilePreviewRef,
    revealWorkspacePath,
    revealWorkspacePathRef,
    openSessionArtifact,
    revealSessionArtifact,
  }
}

/**
 * Session workspace pick / bind / clear / reveal helpers.
 * Extracted from ChatApp.tsx (P9). Delete-group stays in ChatApp (heavy session teardown).
 */
import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { wsClient } from '../../lib/ws-client.js'
import { toast } from '../../components/toast.js'
import { toUserFacingError } from '../../lib/user-facing-error.js'
import {
  normalizeWorkspacePathKey,
  resolveShellGroupWorkspacePath,
  WORKSPACE_GROUP_UNBOUND,
} from '../lib/session-list/workspace-groups.js'
import type { ShellWorkspaceGroup } from '../lib/session-list/types.js'
import {
  _pathBasename,
  isDesktopTauriRuntime,
  promptWorkspacePath,
} from '../chat-app/utils/desktop-workspace.js'

export function useSessionWorkspaceBind(opts: {
  selectedSessionKey: string
  localWorkspaceRoot: string
  setLocalWorkspaceRoot: Dispatch<SetStateAction<string>>
  runtimeDataDir: string
  globalWorkspaceHistory: string[]
  setGlobalWorkspaceHistory: Dispatch<SetStateAction<string[]>>
  setBottomWorkspaceOpen: Dispatch<SetStateAction<boolean>>
  sessionRef: MutableRefObject<string>
  shellIntentWorkspaceRef: MutableRefObject<string | null | undefined>
  startNewSessionWithWorkspaceRef: MutableRefObject<(workspacePath: string | null) => void>
}) {
  const {
    selectedSessionKey,
    localWorkspaceRoot,
    setLocalWorkspaceRoot,
    runtimeDataDir,
    globalWorkspaceHistory,
    setGlobalWorkspaceHistory,
    setBottomWorkspaceOpen,
    sessionRef,
    shellIntentWorkspaceRef,
    startNewSessionWithWorkspaceRef,
  } = opts

  const pickWorkspaceFolder = useCallback(async (): Promise<string | null> => {
    const isDesktop = isDesktopTauriRuntime()
    if (isDesktop) {
      try {
        const dlg = await import('@tauri-apps/plugin-dialog')
        const picked = await dlg.open({
          directory: true,
          multiple: false,
          title: '选择工作空间文件夹',
        })
        const p = Array.isArray(picked) ? picked[0] : picked
        return p ? String(p) : null
      } catch (err) {
        toast(`打开系统目录选择失败：${String((err as Error)?.message || err)}`, 'error')
        return null
      }
    }
    const current = (localWorkspaceRoot || '').trim()
    const next = await promptWorkspacePath(current)
    return next || null
  }, [localWorkspaceRoot])

  const resolveWorkspacePathForSidebar = useCallback(async (raw: string): Promise<string | null> => {
    const trimmed = String(raw || '').trim()
    if (!trimmed) return null
    try {
      const { api } = await import('../../lib/tauri-api.js')
      const resolvedInfo = await api.resolveWorkspacePath(trimmed)
      const resolved = String(resolvedInfo?.resolved || trimmed).trim()
      if (!resolved) return null
      if (resolvedInfo && resolvedInfo.exists === false) {
        toast(`目录不存在：${resolved}`, 'error')
        return null
      }
      if (resolvedInfo && resolvedInfo.is_dir === false) {
        toast(`不是文件夹：${resolved}`, 'error')
        return null
      }
      return resolved
    } catch (err) {
      toast(toUserFacingError((err as Error)?.message || err), 'error')
      return null
    }
  }, [])

  const handleNewWorkspace = useCallback(async () => {
    const picked = await pickWorkspaceFolder()
    if (!picked) return
    const resolved = await resolveWorkspacePathForSidebar(picked)
    if (!resolved) return
    try {
      await wsClient.registerGlobalWorkspacePath(resolved)
      setGlobalWorkspaceHistory(wsClient.getGlobalWorkspaceHistory())
      shellIntentWorkspaceRef.current = resolved
      window.dispatchEvent(
        new CustomEvent('evopanel:shell-expand-workspace', {
          detail: { workspaceKey: normalizeWorkspacePathKey(resolved) },
        }),
      )
      toast(`已添加工作空间：${_pathBasename(resolved)}`, 'success')
    } catch (err) {
      toast(toUserFacingError((err as Error)?.message || err), 'error')
    }
  }, [pickWorkspaceFolder, resolveWorkspacePathForSidebar, setGlobalWorkspaceHistory, shellIntentWorkspaceRef])

  /** 把当前会话绑到项目目录（没有会话则新建） */
  const bindCurrentSessionToWorkspace = useCallback(
    async (workspacePath: string) => {
      const resolved = await resolveWorkspacePathForSidebar(workspacePath)
      if (!resolved) return
      const sk = String(selectedSessionKey || sessionRef.current || '').trim()
      try {
        await wsClient.registerGlobalWorkspacePath(resolved)
        setGlobalWorkspaceHistory(wsClient.getGlobalWorkspaceHistory())
        if (!sk) {
          startNewSessionWithWorkspaceRef.current(resolved)
          setBottomWorkspaceOpen(false)
          return
        }
        await wsClient.bindSessionWorkspace(sk, resolved, { userPinned: true })
        setLocalWorkspaceRoot(resolved)
        shellIntentWorkspaceRef.current = resolved
        window.dispatchEvent(
          new CustomEvent('evopanel:shell-expand-workspace', {
            detail: { workspaceKey: normalizeWorkspacePathKey(resolved) },
          }),
        )
        window.dispatchEvent(
          new CustomEvent('evopanel:session-workspace-changed', {
            detail: { sessionKey: sk, local_workspace_root: resolved },
          }),
        )
        setBottomWorkspaceOpen(false)
        toast(`已切换工作空间：${_pathBasename(resolved)}`, 'success')
      } catch (err) {
        toast(toUserFacingError((err as Error)?.message || err), 'error')
      }
    },
    [
      resolveWorkspacePathForSidebar,
      selectedSessionKey,
      sessionRef,
      setGlobalWorkspaceHistory,
      startNewSessionWithWorkspaceRef,
      setBottomWorkspaceOpen,
      setLocalWorkspaceRoot,
      shellIntentWorkspaceRef,
    ],
  )

  const pickAndBindCurrentWorkspace = useCallback(async () => {
    const picked = await pickWorkspaceFolder()
    if (!picked) return
    await bindCurrentSessionToWorkspace(picked)
  }, [pickWorkspaceFolder, bindCurrentSessionToWorkspace])

  const pickAndStartNewSessionWithWorkspace = useCallback(async () => {
    const picked = await pickWorkspaceFolder()
    if (!picked) return
    const resolved = await resolveWorkspacePathForSidebar(picked)
    if (!resolved) return
    try {
      await wsClient.registerGlobalWorkspacePath(resolved)
      setGlobalWorkspaceHistory(wsClient.getGlobalWorkspaceHistory())
    } catch {
      /* still create */
    }
    setBottomWorkspaceOpen(false)
    startNewSessionWithWorkspaceRef.current(resolved)
    toast(`已在「${_pathBasename(resolved)}」新建对话`, 'success')
  }, [
    pickWorkspaceFolder,
    resolveWorkspacePathForSidebar,
    setGlobalWorkspaceHistory,
    setBottomWorkspaceOpen,
    startNewSessionWithWorkspaceRef,
  ])

  const clearCurrentSessionWorkspace = useCallback(async () => {
    const sk = String(selectedSessionKey || sessionRef.current || '').trim()
    try {
      if (sk) {
        await wsClient.updateSessionContext(sk, {
          local_workspace_root: null,
          workspace_user_pinned: false,
        })
      }
      setLocalWorkspaceRoot('')
      shellIntentWorkspaceRef.current = null
      setBottomWorkspaceOpen(false)
      toast('已切回默认工作空间（应用数据目录）', 'success')
    } catch (err) {
      toast(toUserFacingError((err as Error)?.message || err), 'error')
    }
  }, [selectedSessionKey, sessionRef, setLocalWorkspaceRoot, shellIntentWorkspaceRef, setBottomWorkspaceOpen])

  const openCurrentWorkspaceInFileManager = useCallback(async () => {
    const raw = String(localWorkspaceRoot || runtimeDataDir || '').trim()
    if (!raw) {
      toast('没有可打开的本地目录', 'info')
      return
    }
    try {
      const { api } = await import('../../lib/tauri-api.js')
      const resolvedInfo = await api.resolveWorkspacePath(raw)
      const resolved = String(resolvedInfo?.resolved || raw).trim()
      await api.revealPathInFileManager(resolved)
      toast('已在文件管理器中打开', 'success')
    } catch (e) {
      toast(String((e as Error)?.message || e), 'error')
    }
  }, [localWorkspaceRoot, runtimeDataDir])

  const handleOpenWorkspaceFolder = useCallback(
    async (group: ShellWorkspaceGroup) => {
      let raw = resolveShellGroupWorkspacePath(group, globalWorkspaceHistory)
      if (!raw && group.workspaceKey === WORKSPACE_GROUP_UNBOUND) {
        raw = String(runtimeDataDir || '').trim()
      }
      if (!raw) {
        toast('该工作空间没有可打开的本地文件夹', 'info')
        return
      }
      try {
        const { api } = await import('../../lib/tauri-api.js')
        const resolvedInfo = await api.resolveWorkspacePath(raw)
        const resolved = String(resolvedInfo?.resolved || raw).trim()
        if (!resolved) {
          toast('无法解析文件夹路径', 'error')
          return
        }
        if (resolvedInfo?.exists === false) {
          toast(`目录不存在：${resolved}`, 'error')
          return
        }
        if (resolvedInfo?.is_dir === false) {
          toast(`不是文件夹：${resolved}`, 'error')
          return
        }
        await api.revealPathInFileManager(resolved)
        toast(
          group.workspaceKey === WORKSPACE_GROUP_UNBOUND
            ? '已打开默认数据目录'
            : '已在文件管理器中打开',
          'success',
        )
      } catch (e) {
        toast(String((e as Error)?.message || e), 'error')
      }
    },
    [globalWorkspaceHistory, runtimeDataDir],
  )

  return {
    pickWorkspaceFolder,
    resolveWorkspacePathForSidebar,
    handleNewWorkspace,
    bindCurrentSessionToWorkspace,
    pickAndBindCurrentWorkspace,
    pickAndStartNewSessionWithWorkspace,
    clearCurrentSessionWorkspace,
    openCurrentWorkspaceInFileManager,
    handleOpenWorkspaceFolder,
  }
}

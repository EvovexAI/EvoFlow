/**
 * 功能页（知识库/自动化…）上的全局 right-stage：
 * 与 ChatApp 共用 rightStageStore + RightStagePanel，在 #content 旁做真正左右分割。
 * Chat 工作台可见时不渲染（由 ChatApp 挂载）。
 */
import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import {
  RightStagePanel,
  buildDefaultRightStageLauncherItems,
} from '../components/RightStagePanel.js'
import { rightStageStore } from '../../lib/right-stage/right-stage-store.js'
import { getRightStageKind } from '../../lib/right-stage/right-stage-registry.js'
import { normalizeRightStageKind, type RightStageSurface } from '../../lib/right-stage/right-stage-types.js'
import {
  getChatHostVisible,
  subscribeChatHostVisible,
} from '../../lib/chat-host-visibility.js'
import { ensureRightStageKindsRegistered } from './register-kinds.js'

/** 未进全局注册表的会话级签：功能页给可读兜底，避免「未注册的 kind」。 */
function renderUnregisteredStageFallback(surface: RightStageSurface): ReactNode {
  const kind = normalizeRightStageKind(surface.kind)
  const title = String(surface.title || kind || '面板').trim() || '面板'
  return (
    <aside className="react-chat-right-stage-panel" role="region" aria-label={title}>
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-4 text-center text-ui-sm text-foreground-subtlest">
        <p>「{title}」需在主对话中查看</p>
        <button
          type="button"
          className="btn btn-sm btn-outline"
          onClick={() => {
            try {
              void import('../../router.js').then((m) => m.navigate?.('/chat'))
            } catch {
              /* ignore */
            }
          }}
        >
          打开主对话
        </button>
      </div>
    </aside>
  )
}

ensureRightStageKindsRegistered()

function subscribeStore(cb: () => void) {
  return rightStageStore.subscribe(cb)
}

function getStoreSnapshot() {
  return rightStageStore.getSnapshot()
}

function syncShellSplit(show: boolean) {
  try {
    const mainCol = document.getElementById('main-col')
    const hostEl = document.getElementById('global-right-stage-host')
    mainCol?.classList.toggle('is-global-rs-open', show)
    if (hostEl) {
      if (show) hostEl.removeAttribute('hidden')
      else hostEl.setAttribute('hidden', '')
    }
  } catch {
    /* ignore */
  }
}

export function GlobalRightStageHost() {
  const chatVisible = useSyncExternalStore(
    subscribeChatHostVisible,
    getChatHostVisible,
    () => false,
  )
  const snap = useSyncExternalStore(subscribeStore, getStoreSnapshot, getStoreSnapshot)

  const open = !snap.collapsed && snap.tabs.length > 0
  const show = !chatVisible && open

  useLayoutEffect(() => {
    syncShellSplit(show)
    return () => {
      if (show) syncShellSplit(false)
    }
  }, [show])

  const launcherItems = useMemo(
    () =>
      buildDefaultRightStageLauncherItems({
        onOpenXiaomi: () => {
          // 直接写 store，避免 import openXiaomiRightStage → mount 形成环
          rightStageStore.show({
            kind: 'xiaomi',
            id: 'global',
            title: '小V',
            layout: 'narrow',
            data: { globalAssistant: true },
            openedBy: 'user',
            forceExpand: true,
          })
        },
        onOpenBrowser: () => {
          void import('../../lib/browser-panel-store.js')
            .then((m) => {
              m.ensureBrowserStage?.({})
            })
            .catch(() => {})
        },
        onOpenWorkspace: () => {
          /* 功能页无会话工作区 */
        },
        onOpenWorkflow: () => {
          /* 功能页无会话工作流选择器 */
        },
      }),
    [],
  )

  const onActivateTab = useCallback((key: string) => {
    rightStageStore.activateTab(key)
  }, [])
  const onCloseTab = useCallback((key: string) => {
    rightStageStore.closeTab(key)
  }, [])
  const onCloseOtherTabs = useCallback((keepKey: string) => {
    rightStageStore.closeOtherTabs(keepKey)
  }, [])
  const onCloseAllTabs = useCallback(() => {
    rightStageStore.closeAllTabs()
  }, [])
  const onReorderTab = useCallback((activeId: string, overId: string) => {
    rightStageStore.reorderTab(activeId, overId)
  }, [])
  const onReopenClosedTab = useCallback((key: string) => {
    rightStageStore.reopenClosedTab(key)
  }, [])
  const onCollapse = useCallback(() => {
    rightStageStore.collapse()
  }, [])

  const renderContent = useCallback((surface: RightStageSurface) => {
    // 注册表已覆盖的 kind 不会走到这里；此处只兜未注册的会话级签
    if (getRightStageKind(normalizeRightStageKind(surface.kind))) return null
    return renderUnregisteredStageFallback(surface)
  }, [])

  if (!show) return null

  return (
    <RightStagePanel
      tabs={snap.tabs}
      activeKey={snap.activeKey}
      recentClosed={snap.recentClosed}
      onActivateTab={onActivateTab}
      onCloseTab={onCloseTab}
      onCloseOtherTabs={onCloseOtherTabs}
      onCloseAllTabs={onCloseAllTabs}
      onReorderTab={onReorderTab}
      onReopenClosedTab={onReopenClosedTab}
      onCollapse={onCollapse}
      launcherItems={launcherItems}
      renderContent={renderContent}
    />
  )
}

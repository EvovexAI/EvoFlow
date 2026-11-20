/**
 * 员工名册页内嵌右栏：只渲染 employeeProcess（与任务中心同构，不弹 modal）。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { RightStagePanel } from './RightStagePanel.js'
import { RightStageUnavailableShell } from './RightStageUnavailableShell.js'
import { useRightStageStore } from '../../lib/right-stage/use-right-stage.js'
import { rightStageStore } from '../../lib/right-stage/right-stage-store.js'
import { EMPLOYEES_ROSTER_STAGE_SESSION_KEY } from '../../lib/right-stage/employees-roster-stage-key.js'
import {
  getCurrentRightStageSessionKey,
  setCurrentRightStageSessionKey,
} from '../../lib/right-stage/right-stage-scope.js'
import { normalizeRightStageKind, type RightStageSurface } from '../../lib/right-stage/right-stage-types.js'
import { V4EmployeeProcessPane } from '../chat-app/right-stage/v4-employee-process-pane.js'

function tabKeyOf(tab: RightStageSurface): string {
  return `${normalizeRightStageKind(tab.kind)}:${tab.id}`
}

export function ProactiveRosterRightStageHost() {
  const stageSk = EMPLOYEES_ROSTER_STAGE_SESSION_KEY
  const { tabs, activeKey, collapsed, recentClosed, expand, collapse } = useRightStageStore()

  const visibleTabs = useMemo(
    () => (tabs || []).filter((t) => String(t.sessionKey || '').trim() === stageSk),
    [tabs, stageSk],
  )

  const visibleActiveKey = useMemo(() => {
    if (activeKey && visibleTabs.some((t) => tabKeyOf(t) === activeKey)) return activeKey
    return visibleTabs.length ? tabKeyOf(visibleTabs[visibleTabs.length - 1]) : null
  }, [activeKey, visibleTabs])

  const visibleRecent = useMemo(
    () =>
      (recentClosed || []).filter((e) => String(e.tab?.sessionKey || '').trim() === stageSk),
    [recentClosed, stageSk],
  )

  const open = visibleTabs.length > 0 && !collapsed
  const prevTabCountRef = useRef(0)

  useEffect(() => {
    setCurrentRightStageSessionKey(stageSk)
    return () => {
      if (getCurrentRightStageSessionKey() === stageSk) {
        setCurrentRightStageSessionKey('')
      }
    }
  }, [stageSk])

  useEffect(() => {
    const count = visibleTabs.length
    const arrived = count > 0 && prevTabCountRef.current === 0
    prevTabCountRef.current = count
    if (arrived && collapsed) expand()

    const page = document.querySelector('.proactive-page')
    const stagePane = document.getElementById('pro-right-stage-slot')
    const paneOpen = count > 0 && !collapsed
    if (page) page.classList.toggle('pro-with-right-stage', paneOpen)
    if (stagePane) {
      if (paneOpen) stagePane.removeAttribute('hidden')
      else stagePane.setAttribute('hidden', '')
    }
  }, [visibleTabs.length, collapsed, expand])

  const renderContent = useCallback(
    (surface: RightStageSurface) => {
      const kind = normalizeRightStageKind(surface.kind)
      const data = surface.data || {}
      // 【self-evolution-bot · 2026-11-20 · 第89轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：兜底由 <SidePanelBootShell>（永久「加载中…」）改为终态提示。
      // 为什么：与 TaskDetailRightStageHost 同型缺陷——把瞬时载入占位当成「不支持」
      //   的兜底，用户会看到永不结束的「加载中」。注意本函数只在注册表查不到时
      //   才被调到（RightStagePanel 先问 getRightStageKind），所以这里不需要、
      //   也不许再问一次注册表（问了也永远 undefined，是死代码）。
      if (kind === 'employeeProcess') {
        const agentCode = String(data.agentCode || '').trim()
        if (!agentCode) {
          return (
            <RightStageUnavailableShell
              title={String(surface.title || '工作过程')}
              kind={kind}
              onClose={() => rightStageStore.closeTab(tabKeyOf(surface))}
            />
          )
        }
        const roleName = String(data.roleName || '').trim()
        const empTitle =
          String(surface.title || data.title || roleName || agentCode).trim() || '工作过程'
        return (
          <V4EmployeeProcessPane
            agentCode={agentCode}
            roleName={roleName}
            busy={!!data.busy}
            title={empTitle}
            roundId={String(data.roundId || '').trim()}
            taskId={String(data.taskId || '').trim()}
            sessionKey={stageSk}
            onClose={() => rightStageStore.closeTab(tabKeyOf(surface))}
          />
        )
      }
      return (
        <RightStageUnavailableShell
          title={String(surface.title || kind || '面板')}
          kind={kind}
          onClose={() => rightStageStore.closeTab(tabKeyOf(surface))}
        />
      )
    },
    [stageSk],
  )

  if (!open) return null

  return (
    <div className="pro-right-stage">
      <RightStagePanel
        tabs={visibleTabs}
        activeKey={visibleActiveKey}
        recentClosed={visibleRecent}
        onActivateTab={(key) => rightStageStore.activateTab(key)}
        onCloseTab={(key) => rightStageStore.closeTab(key)}
        onCloseOtherTabs={(key) => {
          for (const t of visibleTabs) {
            const k = tabKeyOf(t)
            if (k !== key) rightStageStore.closeTab(k)
          }
        }}
        onCloseAllTabs={() => {
          for (const t of visibleTabs) rightStageStore.closeTab(tabKeyOf(t))
          collapse()
        }}
        onReorderTab={(a, b) => rightStageStore.reorderTab(a, b)}
        onReopenClosedTab={(key) => rightStageStore.reopenClosedTab(key)}
        onCollapse={() => collapse()}
        launcherItems={[]}
        renderContent={renderContent}
      />
    </div>
  )
}

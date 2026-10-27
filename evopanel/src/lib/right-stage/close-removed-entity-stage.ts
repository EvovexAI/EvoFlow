/**
 * 实体删除后收掉右栏对应页签（shell-page / employeeProcess），
 * 避免再点回去出现「Role '…' not found」等挂载失败。
 */
import { rightStageStore } from './right-stage-store.js'
import { normalizeRightStageKind, type RightStageSurface } from './right-stage-types.js'
import { shellPageTabId } from './shell-page-mount-table.js'
import { purgeMatchingTabsFromSessionMemory } from './right-stage-session-memory.js'
import { logRightStage } from './panel-set-debug-log.js'

export type RemovedEntityStageTarget = {
  domain?: string | null
  entityId?: string | null
  /** 员工域可额外传 agentCode（与 entityId 等价） */
  agentCode?: string | null
}

function normalizePath(raw: string): string {
  let p = String(raw || '').trim()
  if (!p) return ''
  if (p.startsWith('#')) p = p.slice(1)
  if (!p.startsWith('/')) p = `/${p}`
  p = p.split('?')[0].replace(/\/+$/, '') || '/'
  if (p === '/employees') return '/proactive'
  const emp = p.match(/^\/employees\/([^/]+)$/)
  if (emp) return `/proactive/${emp[1]}`
  return p
}

function tabKeyOf(tab: RightStageSurface): string {
  return `${normalizeRightStageKind(tab.kind)}:${tab.id}`
}

function shellPathsForEntity(domain: string, entityId: string): string[] {
  if (domain === 'employees') {
    return [`/proactive/${entityId}`, `/employees/${entityId}`].map(normalizePath)
  }
  if (domain === 'tasks') {
    return [`/task/${entityId}`].map(normalizePath)
  }
  return []
}

function shellPageMatches(tab: RightStageSurface, domain: string, entityId: string): boolean {
  if (normalizeRightStageKind(tab.kind) !== 'shell-page') return false
  const paths = shellPathsForEntity(domain, entityId)
  if (!paths.length) return false
  const path = normalizePath(String(tab.data?.path || tab.data?.route || ''))
  if (path && paths.includes(path)) return true
  const id = String(tab.id || '')
  return paths.some((p) => id === shellPageTabId(p) || id === `shell:${p}`)
}

function employeeProcessMatches(tab: RightStageSurface, domain: string, entityId: string): boolean {
  if (normalizeRightStageKind(tab.kind) !== 'employeeProcess') return false
  const data = tab.data || {}
  const code = String(data.agentCode || data.agent_code || '').trim()
  const taskId = String(data.taskId || data.task_id || '').trim()
  const id = String(tab.id || '')
  if (domain === 'employees') {
    if (code && code === entityId) return true
    if (id.includes(`live:${entityId}`)) return true
    return false
  }
  if (domain === 'tasks') {
    return Boolean(taskId && taskId === entityId)
  }
  return false
}

export function tabMatchesRemovedEntity(
  tab: RightStageSurface,
  target: RemovedEntityStageTarget,
): boolean {
  const domain = String(target.domain || '').trim().toLowerCase()
  const entityId =
    String(target.entityId || '').trim() ||
    (domain === 'employees' ? String(target.agentCode || '').trim() : '')
  if (!domain || !entityId) return false
  return shellPageMatches(tab, domain, entityId) || employeeProcessMatches(tab, domain, entityId)
}

/**
 * 关掉当前 live store + 各会话记忆里指向已删实体的标签。
 * @returns 关掉的 live tab 数
 */
export function closeRightStageTabsForRemovedEntity(target: RemovedEntityStageTarget): number {
  const domain = String(target.domain || '').trim().toLowerCase()
  const entityId =
    String(target.entityId || '').trim() ||
    (domain === 'employees' ? String(target.agentCode || '').trim() : '')
  if (!domain || !entityId) return 0

  const snap = rightStageStore.getSnapshot()
  const victims = snap.tabs.filter((t) => tabMatchesRemovedEntity(t, { domain, entityId }))
  for (const t of victims) {
    rightStageStore.discardTab(tabKeyOf(t))
  }

  const memoryPurged = purgeMatchingTabsFromSessionMemory((t) =>
    tabMatchesRemovedEntity(t, { domain, entityId }),
  )

  if (victims.length || memoryPurged) {
    logRightStage('closeRemovedEntity', {
      domain,
      entityId,
      liveClosed: victims.length,
      memoryPurged,
      keys: victims.map(tabKeyOf),
    })
  }

  const remaining = rightStageStore.getSnapshot().tabs
  if (victims.length && remaining.length === 0 && !rightStageStore.getSnapshot().collapsed) {
    rightStageStore.collapse()
  }

  return victims.length
}

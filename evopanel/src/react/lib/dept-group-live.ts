/**
 * 部门群聊 · 成员实时态（排队 / 回复中）。
 * HomeDeptGroupChat 写入；摘要 DeptGroupPane 订阅，避免点名单只能看到静态「在岗」。
 */

export type DeptMemberLivePhase = 'idle' | 'queued' | 'running'

export type DeptGroupLiveMap = Record<string, DeptMemberLivePhase>

const liveByDept = new Map<string, DeptGroupLiveMap>()
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* ignore */
    }
  })
}

function sameMap(a: DeptGroupLiveMap, b: DeptGroupLiveMap): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (a[k] !== b[k]) return false
  }
  return true
}

/** 整表覆盖：只保留 queued/running；idle 不进表 */
export function setDeptGroupLiveMap(deptId: string, next: DeptGroupLiveMap) {
  const id = String(deptId || '').trim()
  if (!id) return
  const cleaned: DeptGroupLiveMap = {}
  for (const [code, phase] of Object.entries(next || {})) {
    const c = String(code || '').trim()
    if (!c) continue
    if (phase === 'queued' || phase === 'running') cleaned[c] = phase
  }
  const prev = liveByDept.get(id) || {}
  if (sameMap(prev, cleaned)) return
  if (!Object.keys(cleaned).length) liveByDept.delete(id)
  else liveByDept.set(id, cleaned)
  notify()
}

export function clearDeptGroupLiveMap(deptId: string) {
  const id = String(deptId || '').trim()
  if (!id) return
  if (!liveByDept.has(id)) return
  liveByDept.delete(id)
  notify()
}

export function getDeptGroupLiveMap(deptId: string): DeptGroupLiveMap {
  const id = String(deptId || '').trim()
  if (!id) return {}
  return { ...(liveByDept.get(id) || {}) }
}

export function getDeptMemberLivePhase(
  deptId: string,
  agentCode: string,
): DeptMemberLivePhase {
  const code = String(agentCode || '').trim()
  if (!code) return 'idle'
  return getDeptGroupLiveMap(deptId)[code] || 'idle'
}

export function subscribeDeptGroupLive(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function deptMemberLiveLabel(phase: DeptMemberLivePhase): string {
  if (phase === 'running') return '回复中'
  if (phase === 'queued') return '排队中'
  return ''
}

/** 摘要「@点名」→ 主区输入框插入（跨组件） */
export const DEPT_GROUP_INSERT_MENTION_EVENT = 'evoflow:dept-group-insert-mention'

export type DeptGroupInsertMentionDetail = {
  deptId: string
  agentCode: string
  roleName: string
}

export function requestDeptGroupInsertMention(detail: DeptGroupInsertMentionDetail) {
  const deptId = String(detail?.deptId || '').trim()
  const agentCode = String(detail?.agentCode || '').trim()
  if (!deptId || !agentCode) return
  try {
    window.dispatchEvent(
      new CustomEvent(DEPT_GROUP_INSERT_MENTION_EVENT, {
        detail: {
          deptId,
          agentCode,
          roleName: String(detail.roleName || '').trim() || agentCode,
        } satisfies DeptGroupInsertMentionDetail,
      }),
    )
  } catch {
    /* ignore */
  }
}

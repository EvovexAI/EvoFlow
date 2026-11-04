/**
 * 部门群聊：从工具结果里抽出 handlers / handlers_dispatched，
 * 用于群时间线镜像 + 叫醒下游（即使正文漏写 @）。
 */

export type DeptGroupHandoff = {
  agentCode: string
  content: string
  taskId?: string
}

function asObj(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

function parseJsonish(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  const t = raw.trim()
  if (!t) return raw
  if (!(t.startsWith('{') || t.startsWith('['))) return raw
  try {
    return JSON.parse(t)
  } catch {
    return raw
  }
}

function pushHandler(byCode: Map<string, DeptGroupHandoff>, row: unknown) {
  const o = asObj(row)
  if (!o) return
  const code = String(o.agent_code || o.agentCode || o.assignee || '').trim()
  if (!code) return
  const content = String(
    o.content || o.goal || o.summary || o.description || o.title || '',
  ).trim()
  const taskId = String(o.task_id || o.taskId || '').trim()
  const next: DeptGroupHandoff = {
    agentCode: code,
    content,
    ...(taskId ? { taskId } : {}),
  }
  const prev = byCode.get(code)
  if (
    !prev ||
    (next.content && next.content.length > (prev.content || '').length) ||
    (next.taskId && !prev.taskId)
  ) {
    byCode.set(code, {
      agentCode: code,
      content: next.content || prev?.content || '',
      ...(next.taskId || prev?.taskId
        ? { taskId: next.taskId || prev?.taskId }
        : {}),
    })
  }
}

/** 从 tasks tool 结果 / chat tool 事件 payload 收集下游岗位 */
export function extractDeptGroupHandoffs(payload: unknown): DeptGroupHandoff[] {
  const byCode = new Map<string, DeptGroupHandoff>()
  const root = parseJsonish(payload)
  const bag: unknown[] = [root]

  const o = asObj(root)
  if (o) {
    for (const k of ['data', 'result', 'output', 'content', 'message']) {
      if (o[k] != null) bag.push(parseJsonish(o[k]))
    }
  }

  for (const item of bag) {
    const obj = asObj(item)
    if (!obj) continue
    const handlers = obj.handlers
    if (Array.isArray(handlers)) {
      for (const h of handlers) pushHandler(byCode, h)
    }
    const dispatched = obj.handlers_dispatched
    if (Array.isArray(dispatched)) {
      for (const h of dispatched) pushHandler(byCode, h)
    }
    // 单条 handler 形态
    if (obj.agent_code || obj.agentCode) pushHandler(byCode, obj)
  }
  return [...byCode.values()]
}

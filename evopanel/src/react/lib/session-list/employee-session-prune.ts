/**
 * 员工作用域孤儿会话的客户端对账剪枝（方案A：纯前端兜底）。
 *
 * 后端删员工时已清扫其会话并在列表 SQL 里过滤孤儿行（d3ac39b8，
 * session_repositories 的 `_ORPHAN_EMPLOYEE_SESSION_FILTER`）。但侧栏合并是
 * 并集合并 —— mergeSessionsFromApi 会把「本次接口没返回」的旧行原样粘回，
 * 快照（evopanel_sessions_snapshot_v1）也会在冷启动时水合旧行，导致删掉
 * 的员工会话永远留在侧栏、「刷新」看起来没作用。
 *
 * 这里在客户端镜像后端的 owner 归属判定：员工作用域 key 且 owner 已不在
 * 花名册 → 视为孤儿行，可从合并结果中剪掉。判定必须与后端保持同形：
 * - 员工作用域 key 只有两族：proactive:{code}[:kind:...] 与
 *   agent:{code}:{channel}:{chat}（对应 `_SESSION_OWNER_CODE_SQL`）。
 * - owner 为空或系统保留码（main / executor / lead_agent / agent）、
 *   ou_ 前缀（IM 外部身份）不算员工归属（对应过滤 SQL 的豁免分支）。
 * - 在册判定 = agent_code 存在于 `GET /proactive/roles`（不带 status，
 *   active + paused + draft 全量，与后端 `SELECT agent_code FROM
 *   evoflow_proactive_roles` 一致；带 active 会误剪已停用 BOT 的会话）。
 *
 * 故意不写删除墓碑：agent_code 可由用户显式指定，删掉重录同名 code 是
 * 合法操作，墓碑会把新员工的会话一并藏掉。快照靠剪枝后 saveSessionSnapshot
 * 覆写自愈；当前正在查看的会话由 merge 的 ensureSessionRowPresent 豁免。
 */

/** 系统保留 owner code：这些不是「员工」，其会话永不剪（与后端豁免一致）。 */
const SYSTEM_EMPLOYEE_SESSION_OWNER_EXEMPT = new Set(['', 'main', 'executor', 'lead_agent', 'agent'])

/**
 * 从 session_key 提取员工作用域 owner code，镜像后端 `_SESSION_OWNER_CODE_SQL`。
 * 非员工作用域 key（dept_group: / thread: / 裸 main 等）返回 ''。
 * 注意 `:code:...` 形状（冒号开头）后端取到空串，这里同样返回 ''。
 */
export function parseEmployeeSessionOwner(sessionKey: string | null | undefined): string {
  const sk = String(sessionKey || '').trim()
  const ownerOf = (rest: string): string => {
    const i = rest.indexOf(':')
    return i >= 0 ? rest.slice(0, i) : rest
  }
  if (sk.startsWith('proactive:')) return ownerOf(sk.slice('proactive:'.length))
  if (sk.startsWith('agent:')) return ownerOf(sk.slice('agent:'.length))
  return ''
}

/** 该行是否为「owner 已不在花名册」的员工作用域孤儿行。 */
export function isOrphanEmployeeSessionRow(
  row: { sessionKey?: string | null },
  liveEmployeeCodes: ReadonlySet<string>,
): boolean {
  const owner = parseEmployeeSessionOwner(row?.sessionKey)
  if (SYSTEM_EMPLOYEE_SESSION_OWNER_EXEMPT.has(owner)) return false
  if (owner.startsWith('ou_')) return false
  return !liveEmployeeCodes.has(owner)
}

/**
 * 从会话行列表中剪掉孤儿员工会话。
 * `liveEmployeeCodes` 传 null / undefined 表示花名册未知（拉取失败），
 * 原样返回 —— 宁漏剪不误剪。
 */
export function pruneOrphanEmployeeSessions<T extends { sessionKey?: string | null }>(
  rows: T[],
  liveEmployeeCodes: ReadonlySet<string> | null | undefined,
): T[] {
  if (!liveEmployeeCodes) return rows
  return rows.filter((s) => !isOrphanEmployeeSessionRow(s, liveEmployeeCodes))
}

/**
 * 会话级工作区变更日志（撤销用）。
 *
 * 数据来源：助手回合内带 before_content 的文件变更工具行（write / replace / delete）。
 * 每个文件只保留**最早一次**快照——即本会话内代理第一次动手前的内容，
 * 撤销即把文件恢复到"代理没碰过"的状态。
 *
 * 已知边界（与 ZCode 的 Edit/Write 追踪一致）：
 * - 终端命令等绕过文件工具的写入不在日志里；
 * - 快照在内存里，刷新页面后仅保留展示、不可撤销；
 * - 撤销只做"还原到快照"，不删除文件（避免刷新后把历史写入误判为新建而误删）。
 */

/** @typedef {{ path: string, beforeContent: string | null, existed: boolean, deleted: boolean, toolIds: Set<string> } } JournalEntry */

const sessions = new Map()

let revertExecutor = null

/**
 * ChatApp 启动时注册撤销执行器（需要工作区 root / threadId / toast 等宿主上下文）。
 * @param {((sessionKey: string, files: JournalEntry[]) => Promise<{ restored: string[], skipped: string[] }>) | null} fn
 */
export function setWorkspaceRevertExecutor(fn) {
  revertExecutor = typeof fn === 'function' ? fn : null
}

/**
 * 记录一次文件变更。以 toolCallId 做幂等；同文件多次编辑保留最早快照。
 * @param {string} sessionKey
 * @param {string} path
 * @param {{ toolCallId?: string, beforeContent?: string | null, deleted?: boolean }} [info]
 */
export function recordWorkspaceFileChange(sessionKey, path, info = {}) {
  const key = String(sessionKey || '').trim()
  const p = String(path || '').trim()
  if (!key || !p) return
  let files = sessions.get(key)
  if (!files) {
    files = new Map()
    sessions.set(key, files)
  }
  const toolId = String(info.toolCallId || '').trim()
  let entry = files.get(p)
  if (!entry) {
    const hasBefore = typeof info.beforeContent === 'string'
    entry = {
      path: p,
      beforeContent: hasBefore ? info.beforeContent : null,
      existed: hasBefore,
      deleted: info.deleted === true,
      toolIds: new Set(),
    }
    files.set(p, entry)
  }
  if (toolId) {
    if (entry.toolIds.has(toolId)) return
    entry.toolIds.add(toolId)
  }
  if (info.deleted === true) entry.deleted = true
  // 首个拿到 before_content 的记录生效（= 代理动手前状态），后续编辑不覆盖
  if (entry.beforeContent === null && typeof info.beforeContent === 'string') {
    entry.beforeContent = info.beforeContent
    entry.existed = true
    entry.deleted = false
  }
}

/**
 * 查询可撤销的文件数：仅统计有内容快照的文件（撤销 = 还原内容）。
 * 代理新建 / 无快照的文件一律不可撤销——刷新后历史工具行不带快照，
 * 若按"新建=撤销时删除"处理会误删用户文件，因此删除分支不启用。
 * @param {string} sessionKey
 * @param {readonly string[]} paths
 */
export function revertibleCountFor(sessionKey, paths) {
  const files = sessions.get(String(sessionKey || '').trim())
  if (!files) return 0
  let count = 0
  for (const p of paths || []) {
    const entry = files.get(String(p || '').trim())
    if (entry && entry.existed && entry.beforeContent != null) count += 1
  }
  return count
}

/**
 * 执行撤销：交给宿主注册的执行器逐文件还原，成功后清掉对应日志。
 * @param {string} sessionKey
 * @param {Array<{ path: string }>} files
 */
export async function revertWorkspaceFiles(sessionKey, files) {
  if (!revertExecutor) throw new Error('revert executor unavailable')
  const key = String(sessionKey || '').trim()
  const filesMap = sessions.get(key)
  const entries = []
  for (const f of files || []) {
    const entry = filesMap?.get(String(f?.path || '').trim())
    if (entry) entries.push(entry)
  }
  const result = await revertExecutor(key, entries)
  const restored = new Set(result?.restored || [])
  for (const p of restored) filesMap?.delete(p)
  return result
}

/** @param {string} sessionKey */
export function clearWorkspaceChangeJournal(sessionKey) {
  sessions.delete(String(sessionKey || '').trim())
}

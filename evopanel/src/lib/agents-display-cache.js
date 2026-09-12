/** 与 ChatApp / SessionSidebar 共用的 `/api/agents` 快照，供工具展示解析 agent_code → agent_name。 */

let _agents = []

/** @param {unknown[] | null | undefined} list */
export function setAgentsDisplayCache(list) {
  _agents = Array.isArray(list) ? list : []
}

/** @returns {unknown[]} */
export function getAgentsDisplayCache() {
  return _agents
}

/**
 * 部门群播报用的 agents 声线缓存刷新。
 * 成员卡 / 平台改完后派发事件，群聊壳立刻重拉，下一句用新音色语速。
 */

export const DEPT_GROUP_TTS_AGENTS_CHANGED = 'evoflow:dept-group-tts-agents-changed'

export function notifyDeptGroupTtsAgentsChanged(detail?: {
  agentCode?: string
}) {
  try {
    window.dispatchEvent(
      new CustomEvent(DEPT_GROUP_TTS_AGENTS_CHANGED, {
        detail: detail || {},
      }),
    )
  } catch {
    /* ignore */
  }
}

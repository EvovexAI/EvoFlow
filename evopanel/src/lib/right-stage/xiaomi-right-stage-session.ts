/**
 * 小V 占用右栏会话表：与主对话侧栏缓存隔离。
 *
 * 进语音 / 小V 前台时：把当前聊天会话的 tabs 冻进 memory，换入小V sessionKey 的表。
 * 退出时换回。主对话切会话 effect 在占用期间不得把 live 表切回去（会污染双方缓存）。
 */
import { getCurrentRightStageSessionKey, switchRightStageSession } from './right-stage-session-memory.js'
import { logRightStage } from './panel-set-debug-log.js'

/** null = 未占用；字符串（可空）= 退出时要恢复的主对话 sessionKey */
let parkedChatSessionKey: string | null = null

/** ChatApp 监听：adopt 完成后用 selectedSessionKey 补 park。 */
export const XIAOMI_RIGHT_STAGE_ADOPTED_EVENT = 'xw-right-stage-session-adopted'
export const XIAOMI_RIGHT_STAGE_RELEASED_EVENT = 'xw-right-stage-session-released'

function emitAdopted(): void {
  try {
    window.dispatchEvent(new CustomEvent(XIAOMI_RIGHT_STAGE_ADOPTED_EVENT))
  } catch {
    /* ignore */
  }
}

function emitReleased(): void {
  try {
    window.dispatchEvent(new CustomEvent(XIAOMI_RIGHT_STAGE_RELEASED_EVENT))
  } catch {
    /* ignore */
  }
}

export function isXiaomiRightStageSessionAdopted(): boolean {
  return parkedChatSessionKey !== null
}

export function getParkedChatRightStageSessionKey(): string | null {
  return parkedChatSessionKey
}

/**
 * 语音占用期间主对话又切了会话：只更新「退出后恢复到哪」，不动 live 表。
 */
export function updateParkedChatRightStageSessionKey(sessionKey: string | null | undefined): void {
  if (parkedChatSessionKey === null) return
  parkedChatSessionKey = String(sessionKey || '').trim()
}

/**
 * 换入小V 右栏会话表。已占用则 noop。
 * @returns 是否完成占用
 */
export async function adoptXiaomiRightStageSession(): Promise<boolean> {
  if (parkedChatSessionKey !== null) return true

  let xiaomiKey = ''
  try {
    const { getState } = await import('../../components/global-assistant/assistant-store.js')
    xiaomiKey = String(getState()?.sessionKey || '').trim()
    if (!xiaomiKey) {
      const { ensureXiaomiSession } = await import(
        '../../components/global-assistant/assistant-session.js'
      )
      await ensureXiaomiSession({ reloadHistory: false })
      xiaomiKey = String(getState()?.sessionKey || '').trim()
    }
  } catch (e) {
    console.warn('[xiaomi-right-stage] adopt: ensure session failed', e)
  }
  if (!xiaomiKey) {
    logRightStage('xiaomi adopt skipped: no sessionKey', {})
    return false
  }

  const from = getCurrentRightStageSessionKey()
  if (from === xiaomiKey) {
    // 已在小V 表：仍标记占用；park 空串占位，等 chat 侧 updateParked 补上主对话 key。
    // 切勿 park=xiaomiKey，否则退出 release 会 noop，主对话侧栏回不去。
    parkedChatSessionKey = ''
    logRightStage('xiaomi adopt: already on xiaomi key', { key: xiaomiKey })
    emitAdopted()
    return true
  }

  parkedChatSessionKey = from || ''
  // 小V 与主对话右栏缓存彻底隔离：勿 carry 员工详情/工作流等 workspace 签
  switchRightStageSession(from, xiaomiKey, { carryWorkspace: false })
  logRightStage('xiaomi adopt: switched', {
    from: from || '(空)',
    to: xiaomiKey,
    carryWorkspace: false,
  })
  emitAdopted()
  return true
}

/** 退出小V 占用：冻小结 V 表，换回主对话。 */
export function releaseXiaomiRightStageSession(): void {
  if (parkedChatSessionKey === null) return
  const to = parkedChatSessionKey
  parkedChatSessionKey = null
  const from = getCurrentRightStageSessionKey()
  // 同样不把小V 侧签带回主对话
  switchRightStageSession(from, to, { carryWorkspace: false })
  logRightStage('xiaomi release: switched', {
    from: from || '(空)',
    to: to || '(空)',
    carryWorkspace: false,
  })
  emitReleased()
}

/** 右栏可见性过滤用的会话 key：占用中用小V 当前表，否则用主对话选中会话。 */
export function resolveRightStageFilterSessionKey(
  chatSelectedSessionKey: string | null | undefined,
): string {
  if (parkedChatSessionKey !== null) {
    return getCurrentRightStageSessionKey() || String(chatSelectedSessionKey || '').trim()
  }
  return String(chatSelectedSessionKey || '').trim()
}

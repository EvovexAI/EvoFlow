import { getState as getXiaomiAssistantState } from '../../components/global-assistant/assistant-store.js'

/**
 * 主对话 WS：何时把 chat 事件当「后台」（只写 runtime，不灌主栏 setRows）。
 *
 * 历史坑：工作台首页 selectedSessionKey 为空时，旧逻辑把「uiSk 空」当成前台，
 * 小V 侧栏对话的 eventSk 会灌进主栏 rows → 指挥台消失、中间出现「已工作」碎片。
 * 小V 有独立 bindXiaomiStreamListener，主栏未选中该 key 时一律后台。
 */
export function isChatWsEventBackground(opts: {
  eventSk: string
  uiSk: string
  /** 小V 当前 sessionKey（assistant-store / localStorage） */
  xiaomiSk?: string
}): boolean {
  const eventSk = String(opts.eventSk || '').trim()
  const uiSk = String(opts.uiSk || '').trim()
  if (!eventSk) return false
  // 主栏已有选中会话，且与事件归属不同 → 后台
  if (uiSk && eventSk !== uiSk) return true
  const xiaomiSk = String(opts.xiaomiSk || '').trim()
  // 小V 会话：仅当主栏正选中该 key 才当前台（正常不会）
  if (xiaomiSk && eventSk === xiaomiSk && eventSk !== uiSk) return true
  return false
}

/** 读小V 当前 sessionKey（store 优先，localStorage 兜底）。 */
export function readXiaomiAssistantSessionKey(): string {
  try {
    const live = String(getXiaomiAssistantState()?.sessionKey || '').trim()
    if (live) return live
  } catch {
    /* ignore */
  }
  try {
    return String(localStorage.getItem('evopanel_xiaomi_assistant_session_key') || '').trim()
  } catch {
    return ''
  }
}

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

/**
 * 决定一条 chat 事件应该写进哪个会话的 runtime。
 *
 * ⚠️ 竞态防线（会话切换错乱的根因修复）：
 * 切会话那一帧，UI 的 selectedSessionKey 已是新会话，但 sessionRef.current 可能还指向旧会话。
 * 若此时把「事件归属会话」的流灌进「UI 当前会话」的 runtime，就会出现：
 *   - 切回去看到别的会话内容（串台）
 *   - 当前会话看不到 AI 回复（delta 写错 runtime 被 runId 闸门丢弃）
 *
 * 规则：**事件永远只写进它自己归属的会话**（eventSk）。
 * eventSk 与 uiSk 不一致 ⇒ 该事件对当前 UI 而言是后台事件，
 * 只写 eventSk 的 runtime，绝不触碰当前可见的 rows。
 */
export function resolveChatEventTarget(opts: {
  /** 事件自带的归属会话 key（payload.sessionKey） */
  eventSk: string
  /** UI 当前选中的会话 key */
  uiSk: string
  /** 小V 当前 sessionKey */
  xiaomiSk?: string
}): { targetSk: string; isBackground: boolean } {
  const eventSk = String(opts.eventSk || '').trim()
  const uiSk = String(opts.uiSk || '').trim()
  const isBackground = isChatWsEventBackground({
    eventSk,
    uiSk,
    xiaomiSk: opts.xiaomiSk,
  })
  // 事件归属优先：绝不把 eventSk 的流写进别的会话。
  if (eventSk) return { targetSk: eventSk, isBackground }
  // 无归属信息时才退回 UI 会话（理论上不会发生）。
  return { targetSk: isBackground ? '' : uiSk, isBackground }
}

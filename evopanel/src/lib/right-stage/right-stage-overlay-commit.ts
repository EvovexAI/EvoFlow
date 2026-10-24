/**
 * 右栏开合的统一写入口（overlay defer + 可选 flushSync + 恢复 stream bump）。
 *
 * 这不是 ZCode「高频 store commit」：EvoFlow 流式写右栏走 rightStageStore 自己的
 * 路径；这里只收敛「用户点开/关掉侧栏时」反复出现的三件套——
 *   1. setChatOverlayDefer：挡住 scheduleBump，避免布局抖动中途被流式 UI 抢重绘；
 *   2. flushSync：布局相关 setState 同帧落地，再让后续逻辑读到新 DOM/状态；
 *   3. 清 defer 后若无其它 overlay，立刻 resume bump。
 *
 * 会话切换、发送消息等其它 flushSync 不归这里管。
 */
import { flushSync } from 'react-dom'
import { isChatOverlayDeferActive, setChatOverlayDefer } from '../chat-overlay-defer.js'

export const RIGHT_STAGE_OVERLAY_DEFER_KEYS = ['workspace', 'workflow', 'knowledge-map'] as const

export type RightStageOverlayDeferKey = (typeof RIGHT_STAGE_OVERLAY_DEFER_KEYS)[number] | string

function asKeyList(keys: RightStageOverlayDeferKey | readonly RightStageOverlayDeferKey[]): string[] {
  return (Array.isArray(keys) ? keys : [keys]).map((k) => String(k || '').trim()).filter(Boolean)
}

export function setRightStageOverlayDefer(
  keys: RightStageOverlayDeferKey | readonly RightStageOverlayDeferKey[],
  active: boolean,
): void {
  for (const key of asKeyList(keys)) setChatOverlayDefer(key, active)
}

export function clearAllRightStageOverlayDefer(): void {
  setRightStageOverlayDefer(RIGHT_STAGE_OVERLAY_DEFER_KEYS, false)
}

/** 打开/展开：先 defer 再同帧提交布局 setState。 */
export function commitRightStageOpen(
  deferKey: RightStageOverlayDeferKey | readonly RightStageOverlayDeferKey[],
  mutate: () => void,
): void {
  setRightStageOverlayDefer(deferKey, true)
  flushSync(mutate)
}

export type CommitRightStageCloseOpts = {
  /** 要清掉的 defer key；省略则不动 defer。 */
  clearDefer?: RightStageOverlayDeferKey | readonly RightStageOverlayDeferKey[]
  mutate?: () => void
  /** 有 mutate 时默认 flushSync；纯 store/ref 可传 false。 */
  flush?: boolean
  resumeBump?: () => void
}

/** 关闭/收起：清 defer → 可选同帧 mutate → 空闲则恢复 bump。 */
export function commitRightStageClose(opts: CommitRightStageCloseOpts): void {
  if (opts.clearDefer) setRightStageOverlayDefer(opts.clearDefer, false)
  if (opts.mutate) {
    if (opts.flush === false) opts.mutate()
    else flushSync(opts.mutate)
  }
  resumeStreamBumpIfIdle(opts.resumeBump)
}

export function resumeStreamBumpIfIdle(resumeBump?: () => void): void {
  if (resumeBump && !isChatOverlayDeferActive()) resumeBump()
}

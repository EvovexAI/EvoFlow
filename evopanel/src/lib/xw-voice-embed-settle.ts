/**
 * 语音全屏退出后：先让内嵌浏览器按「普通分栏」槽位贴一次，再折叠/切走。
 *
 * 否则同一拍里 exit → collapse → park，set_bounds 永远贴不上窄槽位，
 * HWND 停在语音态大矩形（embed 对比 Δ≈-600）；再开图片时大窗盖住预览。
 */
import { notifyLayoutChromeChanged } from './layout-chrome.js'

export type AfterVoiceExitOpts = {
  /** 布局 settle 后再跑（折叠右栏、关按钮态等） */
  then?: () => void
  /** 额外等待（ms），默认 80 */
  settleMs?: number
}

/**
 * 假定调用方已同步 `exitXwVoiceMode()`（或等价清掉 data-xw-voice）。
 * 双 rAF + 短延时后再通知 layout-chrome，并执行 then。
 */
export function afterXwVoiceExitSettle(opts: AfterVoiceExitOpts = {}): void {
  const settleMs = Math.max(0, Number(opts.settleMs) || 80)
  const run = () => {
    notifyLayoutChromeChanged('xw-voice-exit-settle')
    try {
      opts.then?.()
    } catch {
      /* ignore */
    }
  }
  if (typeof requestAnimationFrame !== 'function') {
    window.setTimeout(run, settleMs)
    return
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (settleMs <= 0) run()
      else window.setTimeout(run, settleMs)
    })
  })
}

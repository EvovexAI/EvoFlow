/** Apply decideRightStage results to rightStageStore (+ optional delayed show). */

import {
  decideRightStage,
  decideResultWillOpenPanel,
  type RightStageDecideInput,
  type RightStageDecideResult,
} from './decide-right-stage.js'
import { logRightStage } from './panel-set-debug-log.js'
import { defaultTitleForKind } from './right-stage-types.js'
import { rightStageStore } from './right-stage-store.js'

export type ApplyDecideOptions = {
  data?: Record<string, unknown>
  title?: string
  /** hint 时可选回调（如 toast） */
  onHint?: (result: RightStageDecideResult) => void
  /** 延迟 show 的 timer 存放；调用方可 clear */
  scheduleShow?: (delayMs: number, run: () => void) => void
}

export function applyDecideRightStage(
  input: RightStageDecideInput,
  opts?: ApplyDecideOptions,
): RightStageDecideResult {
  const result = decideRightStage(input)
  const kind = result.kind || input.kind || ''

  logRightStage('decide', {
    intent: input.intent,
    action: result.action,
    reason: result.reason,
    delayMs: result.delayMs ?? 0,
    currentKind: input.currentKind ?? null,
    hasProgressTab: input.hasProgressTab ?? null,
    hasArtifacts: input.hasArtifacts ?? null,
    targetKind: kind || null,
  }, { store: rightStageStore })

  if (result.action === 'noop' || result.action === 'stream-only') {
    return result
  }

  if (result.action === 'hide') {
    // 回合结束收栏：不得拆掉工作流/节点/员工/浏览器（V4 autoOpen 的进度签 id≠primary）
    const safeHide = () => {
      logRightStage('decide.hide:run', { reason: result.reason }, { stack: true, store: rightStageStore })
      rightStageStore.hideUnlessProgressOpen()
    }
    const delay = result.delayMs || 0
    if (delay > 0 && opts?.scheduleShow) {
      logRightStage('decide.hide:schedule', { delayMs: delay, reason: result.reason }, {
        store: rightStageStore,
      })
      opts.scheduleShow(delay, safeHide)
    } else {
      safeHide()
    }
    return result
  }

  const show = () => {
    if (!kind) return
    rightStageStore.show({
      kind,
      title: opts?.title || defaultTitleForKind(kind),
      data: opts?.data || {},
    })
  }

  if (result.action === 'hint') {
    opts?.onHint?.(result)
    const delay = result.delayMs ?? 300
    if (opts?.scheduleShow && delay > 0) {
      opts.scheduleShow(delay, show)
    } else {
      show()
    }
    return result
  }

  // show
  show()
  return result
}

export { decideResultWillOpenPanel }

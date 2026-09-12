/** Apply decideRightStage results to rightStageStore (+ optional delayed show). */

import {
  decideRightStage,
  decideResultWillOpenPanel,
  type RightStageDecideInput,
  type RightStageDecideResult,
} from './decide-right-stage.js'
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

  if (result.action === 'noop' || result.action === 'stream-only') {
    return result
  }

  if (result.action === 'hide') {
    const delay = result.delayMs || 0
    if (delay > 0 && opts?.scheduleShow) {
      opts.scheduleShow(delay, () => rightStageStore.hide())
    } else {
      rightStageStore.hide()
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

/** Distance from bottom under which we treat the viewport as "at bottom". */
export const SCROLL_EDGE_SLACK = 48

/**
 * 折叠收拢的最小高度骤降。过小会把虚拟列表测高抖动 / 用户上滑误判成 fold，
 * 进而强制 scrollTop=scrollHeight，表现为上滑时上下打架。
 */
export const FOLD_MIN_HEIGHT_SHRINK_PX = 120

/** scrollTop 下降与 height 收缩的最大偏差（浏览器钳位余量） */
export const FOLD_SCROLL_HEIGHT_MATCH_SLACK_PX = 48

/**
 * 内容折叠（思考收起 / Exploring 高度骤降）时：scrollHeight 下降，scrollTop 常同步下掉，
 * 且会短暂离开底部。这不是用户上滑，不应关掉 autoFollow。
 *
 * 覆盖：流式中，以及流式刚结束后的短暂收拢窗口（settlingPostStream）。
 *
 * 判定须同时满足：显著缩高 + scrollTop 几乎按同量下降。
 * 用户上滑时 height 几乎不变或只小幅测高抖动，不应命中。
 */
export function isFoldInducedScrollAway(opts: {
  heightDelta: number
  scrollTopDelta: number
  distBottom: number
  streamActive: boolean
  /** 流式结束后数秒内的折叠收拢（思考/工具收起） */
  settlingPostStream?: boolean
  /** 用户已明确上滑离开（wheel/touch）：禁止误判回贴底 */
  userScrollAwayIntent?: boolean
  edgeSlack?: number
  minHeightShrink?: number
  matchSlack?: number
}) {
  const { heightDelta, scrollTopDelta, distBottom, streamActive } = opts
  const settlingPostStream = !!opts.settlingPostStream
  const edgeSlack = opts.edgeSlack ?? SCROLL_EDGE_SLACK
  const minShrink = opts.minHeightShrink ?? FOLD_MIN_HEIGHT_SHRINK_PX
  const matchSlack = opts.matchSlack ?? FOLD_SCROLL_HEIGHT_MATCH_SLACK_PX
  if (opts.userScrollAwayIntent) return false
  if (!streamActive && !settlingPostStream) return false
  if (heightDelta > -minShrink) return false
  if (scrollTopDelta >= -1) return false
  // scrollTop 下降量与高度收缩大致相当（锚定/浏览器钳位），且下方出现空隙
  if (distBottom <= edgeSlack) return false
  return Math.abs(scrollTopDelta - heightDelta) <= matchSlack
}

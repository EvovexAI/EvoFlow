/**
 * 侧栏标题"微光"的前置判断（从 components/shell-aside.js 抽出以便测试）。
 *
 * 微光靠每帧写 `background-position` 让渐变底图滑动，只有**标题本身带渐变底图**时
 * 才有视觉产出：
 * - 默认主题：react-chat.css 的 `.react-chat-aside-toolbar-title` 是 `background: none`
 * - 科技风：sci-fi-theme.css 才挂 `linear-gradient(...) + background-clip: text`
 *
 * 历史实现无条件跑 60fps rAF：默认主题下纯空转，却让主线程永久保持唤醒，
 * 拖窗/流式时与拖窗消息泵抢时间片（表现为拖动顶部略发涩）。
 * 所以启动前必须确认 computed background-image 里真的有 gradient。
 */

/**
 * 元素当前是否带可位移的渐变底图。
 * @param {Element | null | undefined} el
 * @param {(el: Element) => CSSStyleDeclaration} [getStyle] 便于测试注入
 * @returns {boolean}
 */
export function hasShimmerGradient(el, getStyle) {
  if (!el || typeof el !== 'object') return false
  const read =
    typeof getStyle === 'function'
      ? getStyle
      : typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
        ? (node) => window.getComputedStyle(node)
        : null
  if (!read) return false
  try {
    const style = read(el)
    const bg = style && style.backgroundImage
    return !!bg && bg !== 'none' && String(bg).indexOf('gradient') !== -1
  } catch {
    return false
  }
}

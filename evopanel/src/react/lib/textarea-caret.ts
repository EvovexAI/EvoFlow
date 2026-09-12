/** Mirror-div caret measurement for positioning UI near the typed end of a textarea. */

const MIRROR_STYLE_PROPS = [
  'direction',
  'boxSizing',
  'width',
  'height',
  'overflowX',
  'overflowY',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontFamily',
  'lineHeight',
  'letterSpacing',
  'textIndent',
  'textTransform',
  'wordSpacing',
  'tabSize',
  'whiteSpace',
  'wordBreak',
  'wordWrap',
] as const

export type TextareaCaretPoint = {
  /** px from textarea border box left (content area) */
  left: number
  /** px from textarea border box top (content area) */
  top: number
}

/**
 * Returns caret coordinates inside the textarea (content coordinates, scroll-adjusted).
 * `position` is the index after which the marker is placed (typically selectionEnd).
 */
export function measureTextareaCaret(
  textarea: HTMLTextAreaElement,
  position: number,
): TextareaCaretPoint | null {
  if (!textarea || typeof document === 'undefined') return null

  const value = textarea.value ?? ''
  const pos = Math.max(0, Math.min(position, value.length))
  const style = window.getComputedStyle(textarea)

  const mirror = document.createElement('div')
  const marker = document.createElement('span')
  document.body.appendChild(mirror)

  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.overflow = 'hidden'
  mirror.style.whiteSpace = style.whiteSpace === 'nowrap' ? 'pre' : 'pre-wrap'

  for (const prop of MIRROR_STYLE_PROPS) {
    mirror.style[prop] = style[prop]
  }

  const width =
    textarea.clientWidth -
    parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight)
  mirror.style.width = `${Math.max(0, width)}px`

  const before = value.slice(0, pos)
  const after = value.slice(pos) || '\u200b'
  mirror.textContent = before
  marker.textContent = after
  mirror.appendChild(marker)

  const top =
    marker.offsetTop -
    textarea.scrollTop +
    parseFloat(style.borderTopWidth) +
    parseFloat(style.paddingTop)
  const left =
    marker.offsetLeft +
    marker.offsetWidth -
    textarea.scrollLeft +
    parseFloat(style.borderLeftWidth) +
    parseFloat(style.paddingLeft)

  document.body.removeChild(mirror)
  return { left, top }
}

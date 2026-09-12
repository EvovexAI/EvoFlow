/**
 * Voice listen session control: stop-listen phrases + pause until re-wake.
 */

/** Phrases that mean “stop listening for now” (not wake-word ear). */
const STOP_LISTEN_PHRASES = [
  '停止',
  '停下',
  '暂停',
  '暂停监听',
  '别听了',
  '不要听了',
  '先别听',
  '闭嘴',
  '够了',
  '没事了',
  '先这样',
  '结束',
  '结束对话',
  '退出监听',
  '不要再说了',
  '别说了',
  '你可以歇了',
]

/** Stop TTS only (still keep listening). */
const STOP_TTS_ONLY_PHRASES = ['停止播报', '别播了', '不要播了', '安静', '小声点']

function normalizeZh(text) {
  return String(text || '')
    .replace(/[\s\u3000，,。.！!？?、·\-_/\\'"`~]+/g, '')
    .toLowerCase()
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isStopListenCommand(text) {
  const n = normalizeZh(text)
  if (!n) return false
  // Avoid matching long task sentences that merely contain 停止/结束.
  if (n.length > 12) return false
  for (const phrase of STOP_LISTEN_PHRASES) {
    const p = normalizeZh(phrase)
    if (!p) continue
    if (n === p || n === `请${p}` || n === `${p}吧` || n === `${p}啊`) return true
  }
  return false
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isStopTtsOnlyCommand(text) {
  const n = normalizeZh(text)
  if (!n || n.length > 12) return false
  for (const phrase of STOP_TTS_ONLY_PHRASES) {
    if (n === normalizeZh(phrase)) return true
  }
  return false
}

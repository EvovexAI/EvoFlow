/** 思考区展示：压成段落流式文本，保留段落空行。 */
export function normalizeReasoningDisplayText(text: string): string {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!raw) return ''
  const blocks = raw
    .replace(/\n{3,}/g, '\n\n')
    .split(/\n\n/)
    .map((block) =>
      block
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' '),
    )
    .filter(Boolean)
  return blocks.join('\n\n')
}

export function reasoningPreviewOneLine(text: string, maxLen = 140): string {
  const flat = normalizeReasoningDisplayText(text).replace(/\n+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat
}

/**
 * 流式思考单行：压平换行，过长时露尾部（看最新在想什么）。
 */
export function reasoningStreamOneLine(text: string, maxLen = 160): string {
  const flat = normalizeReasoningDisplayText(text).replace(/\n+/g, ' ').trim()
  if (!flat) return ''
  if (flat.length <= maxLen) return flat
  return flat.slice(-maxLen)
}

/** 历史记录（非流式）展开时只保留前若干字符，思考内容不重要不必占满版面。 */
export function reasoningHeadForDisplay(text: string, maxChars = 500): string {
  const normalized = normalizeReasoningDisplayText(text)
  if (normalized.length <= maxChars) return normalized
  const head = normalized.slice(0, maxChars)
  // 尽量在段落边界截断，避免半句
  const paraBreak = head.lastIndexOf('\n\n')
  if (paraBreak >= 0 && paraBreak > maxChars * 0.5) {
    return head.slice(0, paraBreak).trimEnd() + '…'
  }
  return head.trimEnd() + '…'
}

/** 流式展开时只保留末尾，降低 DOM 体量。 */
export function reasoningTailForDisplay(text: string, maxChars = 1200): string {
  const normalized = normalizeReasoningDisplayText(text)
  if (normalized.length <= maxChars) return normalized
  const tail = normalized.slice(-maxChars)
  const paraBreak = tail.indexOf('\n\n')
  if (paraBreak >= 0 && paraBreak < tail.length - 80) {
    return tail.slice(paraBreak + 2).trimStart()
  }
  return tail.trimStart()
}

export function reasoningDisplayParagraphs(text: string): string[] {
  const normalized = normalizeReasoningDisplayText(text)
  if (!normalized) return []
  return normalized.split('\n\n').filter(Boolean)
}

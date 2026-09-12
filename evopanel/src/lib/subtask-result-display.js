/**
 * 子任务结果展示：合并流式误拆的「一字/一词一行」、压缩多余空行。
 * 任务详情页与子任务弹窗、侧栏弹窗复制前统一走此函数。
 */

/**
 * 拼接 LangChain/Anthropic content 中的多个 text 块，或连续 assistant 快照片段。
 * 流式 delta（每块很短、无空格）用空串/空格拼接，避免变成「一词一行」。
 */
export function joinTextContentParts(parts) {
  const list = (parts || []).map((p) => String(p ?? '')).filter((p) => p.length > 0)
  if (list.length <= 1) return list[0] || ''
  const trimmed = list.map((p) => p.trim()).filter(Boolean)
  if (!trimmed.length) return ''
  const shortOrToken = trimmed.filter((p) => p.length <= 2 || (p.length <= 56 && !/\s/.test(p)))
  const ratio = shortOrToken.length / trimmed.length
  if (ratio < 0.6) return trimmed.join('\n')
  const ascii = shortOrToken.filter((p) => /^[\u0020-\u007F\d.,!?;:'"()[\]{}_\-+/\\@#$%^&*]+$/.test(p)).length
  const joiner = ascii / Math.max(1, shortOrToken.length) >= 0.35 ? ' ' : ''
  return trimmed.join(joiner)
}

function looksLikeMarkdownStructure(line) {
  const t = String(line || '').trim()
  if (!t) return false
  return (
    /^#{1,6}\s/.test(t) ||
    /^[-*+]\s+\S/.test(t) ||
    /^\|.+\|/.test(t) ||
    /^```/.test(t) ||
    /^\d+\.\s+\S/.test(t)
  )
}

function isSingleTokenLine(line) {
  const t = String(line || '').trim()
  if (!t) return false
  if (/\s/.test(t)) return false
  if (t.length > 56) return false
  return true
}

/** 段落内若为 broken stream（每行一个 token），合并为正常句子 */
function collapseBrokenParagraph(paragraph) {
  const raw = String(paragraph ?? '')
  if (!raw.trim()) return raw
  const lines = raw.split('\n').map((l) => String(l).trim())
  const nonEmpty = lines.filter((l) => l.length > 0)
  if (nonEmpty.length < 2) return raw
  if (nonEmpty.some(looksLikeMarkdownStructure)) return raw

  const singleToken = nonEmpty.filter(isSingleTokenLine)
  const perChar = nonEmpty.filter((l) => l.length <= 2).length
  const brokenRatio = Math.max(singleToken.length / nonEmpty.length, perChar / nonEmpty.length)
  if (brokenRatio < 0.6) return raw

  const asciiLike = singleToken.filter((l) => /^[\u0020-\u007F\d.,!?;:'"()[\]{}_\-+/\\@#$%^&*]+$/.test(l)).length
  const joiner = asciiLike / Math.max(1, singleToken.length) >= 0.35 ? ' ' : ''
  return nonEmpty.join(joiner)
}

/** 连续 assistant 快照合并（execution_conversation 流式 delta） */
export function mergeStreamReplicaAssistantText(prevText, nextText) {
  const prev = String(prevText || '')
  const next = String(nextText || '')
  if (!prev) return normalizeSubtaskResultForDisplay(next)
  if (!next) return normalizeSubtaskResultForDisplay(prev)
  if (next.startsWith(prev)) return normalizeSubtaskResultForDisplay(next)
  if (prev.startsWith(next)) return normalizeSubtaskResultForDisplay(prev)
  const p = prev.trim()
  const n = next.trim()
  if (p && n && !p.includes('\n\n') && !n.includes('\n\n') && !p.includes('\n') && !n.includes('\n')) {
    if (p.length + n.length <= 8000) {
      const ascii =
        /^[\u0020-\u007F\d.,!?;:'"()[\]{}_\-+/\\@#$%^&*]+$/.test(p) &&
        /^[\u0020-\u007F\d.,!?;:'"()[\]{}_\-+/\\@#$%^&*]+$/.test(n)
      const joiner = ascii && (p.length <= 32 || n.length <= 32) ? ' ' : ''
      return normalizeSubtaskResultForDisplay(`${p}${joiner}${n}`)
    }
  }
  return normalizeSubtaskResultForDisplay(joinTextContentParts([prev, next]))
}

export function normalizeSubtaskResultForDisplay(raw) {
  let s = String(raw ?? '')
  if (!s) return ''
  const parts = s.split(/\n{2,}/)
  s = parts.map((p) => collapseBrokenParagraph(p)).join('\n\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s
}

/** runtime ``drain_pending_messages_for_restore``: merge interrupted pending inputs. */

export function mergeInterruptedComposerDraft(
  parts: string[],
  existingDraft = '',
): string {
  const texts = parts.map((t) => String(t || '').trim()).filter(Boolean)
  const existing = String(existingDraft || '').trim()
  if (!texts.length) return existing
  if (!existing) return texts.join('\n\n')
  return [...texts, existing].join('\n\n')
}

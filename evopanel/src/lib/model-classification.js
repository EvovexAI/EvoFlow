/** Shared heuristics for chat vs embedding models (matches Settings → Models tabs). */

/** @param {Record<string, unknown> | null | undefined} m */
export function isEmbeddingModel(m) {
  if (!m) return false
  const vendor = String(m.vendor || '').trim().toLowerCase()
  const name = String(m.name || '').toLowerCase()
  const model = String(m.model || '').toLowerCase()
  // vendor=local → local embedding (e.g. bge-small-zh)
  if (vendor === 'local') return true
  return (
    name.includes('embedding') ||
    model.includes('embedding') ||
    model.includes('bge') ||
    model.includes('e5-') ||
    model.includes('nomic-embed')
  )
}

/** @param {Record<string, unknown>[]} models */
export function filterChatModels(models) {
  return (models || []).filter((m) => !isEmbeddingModel(m))
}

/** @param {Record<string, unknown>[]} models */
export function collectEmbeddingModelOptions(models) {
  return (models || [])
    .filter(isEmbeddingModel)
    .map((m) => ({
      value: String(m.name || '').trim(),
      label: String(m.display_name || m.name || m.model || '').trim() || m.name,
    }))
    .filter((o) => o.value)
}

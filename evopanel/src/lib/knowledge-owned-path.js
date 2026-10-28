/** Map an absolute/relative workspace path to an owned KB document. */
export function findOwnedDocByWorkspacePath(docs, workspaceRoot, absOrRelPath) {
  const root = String(workspaceRoot || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  let full = String(absOrRelPath || '').replace(/\\/g, '/')
  if (!full) return null

  let rel = full
  if (root) {
    const rootLower = root.toLowerCase()
    const fullLower = full.toLowerCase()
    if (fullLower === rootLower) return null
    if (fullLower.startsWith(`${rootLower}/`)) {
      rel = full.slice(root.length + 1)
    }
  }
  rel = rel.replace(/^\/+/, '')
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length) return null
  const fileName = parts[parts.length - 1]
  const folderPath = parts.slice(0, -1).join('/')

  const list = Array.isArray(docs) ? docs : []
  const exact = list.find(
    (d) =>
      String(d.fileName || '') === fileName &&
      String(d.folderPath || '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '') === folderPath,
  )
  if (exact) return exact

  return (
    list.find((d) => {
      const name = String(d.fileName || '')
      const folder = String(d.folderPath || '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
      const candidate = folder ? `${folder}/${name}` : name
      return candidate === rel || rel.endsWith(`/${candidate}`) || candidate.endsWith(`/${rel}`)
    }) || null
  )
}

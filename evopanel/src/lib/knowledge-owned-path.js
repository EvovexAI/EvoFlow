/** Normalize folder path (slash, trim ends). */
function normFolder(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

/** Map an absolute/relative workspace path to an owned KB document. */
export function findOwnedDocByWorkspacePath(docs, workspaceRoot, absOrRelPath) {
  const root = normFolder(workspaceRoot)
  const full = String(absOrRelPath || '').replace(/\\/g, '/')
  if (!full) return null

  let rel = full
  if (root) {
    const rootLower = root.toLowerCase()
    const fullLower = full.toLowerCase()
    if (fullLower === rootLower) return null
    if (fullLower.startsWith(`${rootLower}/`)) {
      // root / full 仅大小写不同时长度一致，按 root.length 切片即可
      rel = full.slice(root.length + 1)
    }
  }
  rel = normFolder(rel)
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length) return null
  const fileName = parts[parts.length - 1]
  const folderPath = parts.slice(0, -1).join('/')
  const fileKey = fileName.toLowerCase()
  const folderKey = folderPath.toLowerCase()
  const relKey = rel.toLowerCase()

  const list = Array.isArray(docs) ? docs : []
  const exact = list.find((d) => {
    const name = String(d.fileName || '')
    const folder = normFolder(d.folderPath)
    return name.toLowerCase() === fileKey && folder.toLowerCase() === folderKey
  })
  if (exact) return exact

  return (
    list.find((d) => {
      const name = String(d.fileName || '')
      const folder = normFolder(d.folderPath)
      const candidate = folder ? `${folder}/${name}` : name
      const candidateKey = candidate.toLowerCase()
      return (
        candidateKey === relKey ||
        relKey.endsWith(`/${candidateKey}`) ||
        candidateKey.endsWith(`/${relKey}`)
      )
    }) || null
  )
}

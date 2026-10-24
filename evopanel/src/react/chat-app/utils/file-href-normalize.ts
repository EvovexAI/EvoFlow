/**
 * Normalize history/stream file URLs into browser-openable /mnt/user-data/… hrefs.
 * Extracted from ChatApp.tsx (P8).
 */

export function normalizeFileHrefForThread(_threadId: string, rawUrl: string): string {
  const u = String(rawUrl || '').trim()
  if (!u) return '#'
  if (/^https?:\/\//i.test(u)) return u
  // Windows absolute path (e.g. D:\repo\outputs\a.txt). Browser can't open it directly;
  // map into /mnt/user-data/{outputs,uploads}/... so 1421 can serve it.
  if (/^[a-zA-Z]:[\\/]/.test(u)) {
    const norm = u.replace(/\\/g, '/')
    const pickRel = (marker: string) => {
      const idx = norm.toLowerCase().lastIndexOf(marker)
      if (idx < 0) return null
      const rel = norm.slice(idx + marker.length).replace(/^\/+/, '')
      return rel ? rel : null
    }
    const relOut = pickRel('/outputs/')
    if (relOut) {
      return `/mnt/user-data/outputs/${relOut.split('/').map((seg) => encodeURIComponent(seg)).join('/')}`
    }
    const relUp = pickRel('/uploads/')
    if (relUp) {
      return `/mnt/user-data/uploads/${relUp.split('/').map((seg) => encodeURIComponent(seg)).join('/')}`
    }
    const relWs = pickRel('/workspace/')
    if (relWs) {
      return relWs
    }
    // Unknown absolute path: cannot safely infer; leave unchanged.
    return u
  }

  const stripped0 = u.replace(/^\/+/, '')
  // Accept: outputs/... | uploads/... | mnt/user-data/... | /mnt/user-data/...
  const vpath = stripped0
  if (vpath.startsWith('mnt/user-data/')) {
    // ok
    return `/${vpath.split('/').filter(Boolean).map((seg) => encodeURIComponent(seg)).join('/')}`
  }
  if (vpath.startsWith('outputs/') || vpath === 'outputs') {
    const rest = vpath === 'outputs' ? '' : vpath.slice('outputs/'.length)
    const enc = rest ? rest.split('/').filter(Boolean).map((seg) => encodeURIComponent(seg)).join('/') : ''
    return `/mnt/user-data/outputs/${enc}`.replace(/\/+$/, '')
  }
  if (vpath.startsWith('uploads/') || vpath === 'uploads') {
    const rest = vpath === 'uploads' ? '' : vpath.slice('uploads/'.length)
    const enc = rest ? rest.split('/').filter(Boolean).map((seg) => encodeURIComponent(seg)).join('/') : ''
    return `/mnt/user-data/uploads/${enc}`.replace(/\/+$/, '')
  }
  if (vpath.startsWith('workspace/') || vpath === 'workspace') {
    const rest = vpath === 'workspace' ? '' : vpath.slice('workspace/'.length)
    return rest || u
  }
  // Unknown local-ish path; don't rewrite.
  return u
}

export function normalizeRowFilesInPlace(threadId: string, r: any): any {
  const files = Array.isArray(r?.files) ? r.files : null
  if (!files || !threadId) return r
  let changed = false
  const nextFiles = files.map((f: any) => {
    const url = String(f?.url || '').trim()
    if (!url) return f
    const nextUrl = normalizeFileHrefForThread(threadId, url)
    if (nextUrl !== url) {
      changed = true
      return { ...f, url: nextUrl }
    }
    return f
  })
  return changed ? { ...r, files: nextFiles } : r
}

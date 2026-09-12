export function buildConfigCandidates(preferredRoot = '', savedPath = '') {
  const candidates = []
  const root = String(preferredRoot || '').trim().replace(/\\/g, '/').replace(/\/$/, '')
  if (root) {
    candidates.push(`${root}/config.yaml`)
    candidates.push(`${root}/backend/config.yaml`)
  }
  if (savedPath) candidates.push(String(savedPath).trim())
  candidates.push(
    'config.yaml',
    'backend/config.yaml',
    '../config.yaml',
    '../backend/config.yaml',
    '../../config.yaml',
    'config.example.yaml',
  )
  return [...new Set(candidates.filter(Boolean))]
}

export async function readConfigWithFallback({
  readFile,
  preferredRoot = '',
  savedPath = '',
  resolveByShell,
}) {
  const candidates = buildConfigCandidates(preferredRoot, savedPath)
  for (const path of candidates) {
    try {
      const content = await readFile(path)
      if (typeof content === 'string' && content.length > 0) {
        return { path, content }
      }
    } catch {}
  }
  if (typeof resolveByShell === 'function') {
    const resolved = await resolveByShell(preferredRoot || savedPath || '')
    if (resolved) {
      const content = await readFile(resolved)
      if (typeof content === 'string' && content.length > 0) {
        return { path: resolved, content }
      }
    }
  }
  throw new Error('未找到 EvoFlow 配置文件，请先填写 EvoFlow 项目地址后点“使用此地址”')
}

/**
 * Bound local workspace root for chat media path resolution (serve-file API).
 */

let _workspaceRoot = ''

/**
 * 未展开的场景包占位符（`${ORG_WORKSPACE}`）不得当作 root 发给网关。
 * 【self-evolution-bot · 2026-11-23 · 第130轮 · 模型:qwen3.8-flash】
 * 为什么：员工会话的工作区根取自 pack 声明时可能带字面占位符，前端把它原样塞进
 * `resolve-target`/`serve-file` 的 `root=` → 网关 400（右栏报 read failed: HTTP 400）。
 * 网关侧已做容错，这里按同一判据把发送侧也堵住（第106轮教训：同一判据前后端必须同轮改完）。
 * 剥空即视作「未绑根」，由调用方回落到 runtimeDataDir / 网关 host 根。
 * @param {string} root
 */
export function setChatWorkspaceRoot(root) {
  const raw = String(root || '').trim()
  if (!raw.includes('${')) {
    _workspaceRoot = raw
    return
  }
  const kept = raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && !/^\$\{[A-Za-z0-9_.]+\}$/.test(seg.trim()))
  _workspaceRoot = kept.join('/')
}

export function getChatWorkspaceRoot() {
  return _workspaceRoot
}

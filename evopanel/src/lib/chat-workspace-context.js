/**
 * Bound local workspace root for chat media path resolution (serve-file API).
 */

let _workspaceRoot = ''

/** @param {string} root */
export function setChatWorkspaceRoot(root) {
  _workspaceRoot = String(root || '').trim()
}

export function getChatWorkspaceRoot() {
  return _workspaceRoot
}

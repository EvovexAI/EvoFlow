/**
 * Collapse global left nav only while Owned KB detail is open.
 * List hub does not touch the aside.
 */
import {
  getShellAsideCollapsed,
  setShellAsideCollapsed,
} from '../components/shell-aside.js'

/** @type {boolean | null} */
let _asideCollapsedBeforeDetail = null

/** @param {boolean} inDetail */
export function syncKnowledgeAsideForDetail(inDetail) {
  if (!document.getElementById('app-shell-aside')) return
  if (inDetail) {
    if (_asideCollapsedBeforeDetail === null) {
      _asideCollapsedBeforeDetail = getShellAsideCollapsed()
    }
    try {
      setShellAsideCollapsed(true)
    } catch {
      /* ignore */
    }
    return
  }
  restoreKnowledgeAsideFromDetail()
}

export function restoreKnowledgeAsideFromDetail() {
  if (_asideCollapsedBeforeDetail === null) return
  try {
    setShellAsideCollapsed(_asideCollapsedBeforeDetail)
  } catch {
    /* ignore */
  }
  _asideCollapsedBeforeDetail = null
}

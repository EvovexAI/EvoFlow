/**
 * 工作流详情 / 填参 / 历史：左侧全局菜单收成图标栏（与知识库详情同款），
 * 不再整栏隐藏（去掉「全屏沉浸」）。
 */
import {
  getShellAsideCollapsed,
  setShellAsideCollapsed,
} from '../components/shell-aside.js'

/** @type {boolean | null} */
let _asideCollapsedBeforeStudio = null

function currentPath() {
  return String(window.location.hash || '')
    .replace(/^#/, '')
    .split('?')[0]
}

function stillInAppsStudio() {
  return /^\/apps\/[^/]+(?:\/(?:run|history))?$/.test(currentPath())
}

/** @param {boolean} inStudio */
export function syncAppsStudioAside(inStudio) {
  if (!document.getElementById('app-shell-aside')) return
  if (inStudio) {
    if (_asideCollapsedBeforeStudio === null) {
      _asideCollapsedBeforeStudio = getShellAsideCollapsed()
    }
    try {
      setShellAsideCollapsed(true)
    } catch {
      /* ignore */
    }
    return
  }
  restoreAppsStudioAside()
}

export function restoreAppsStudioAside() {
  // 在 /apps/:id ↔ /run ↔ /history 之间跳转时不要还原（hash 已是新路由）
  if (stillInAppsStudio()) return
  if (_asideCollapsedBeforeStudio === null) return
  try {
    setShellAsideCollapsed(_asideCollapsedBeforeStudio)
  } catch {
    /* ignore */
  }
  _asideCollapsedBeforeStudio = null
}

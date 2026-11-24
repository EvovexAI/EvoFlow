/**
 * 功能页全局 RightStage 宿主：挂在 #global-right-stage-host，与 #content 左右分割。
 *
 * HMR / 双调用注意：模块级 `_root` 被重置后若再 `createRoot(host)`，旧 aside 会留在
 * host 里变成兄弟节点——表现成「上下两个小V、各半高」。root 挂到 host 上并在重建前
 * unmount + 清孤儿。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalRightStageHost } from '../../react/right-stage/GlobalRightStageHost.tsx'

const ROOT_KEY = '__evoGlobalRsRoot'

/** @type {import('react-dom/client').Root | null} */
let _root = null

function ensureHost() {
  let el = document.getElementById('global-right-stage-host')
  if (el) return el
  const row = document.getElementById('main-body-row')
  const mainCol = document.getElementById('main-col')
  el = document.createElement('div')
  el.id = 'global-right-stage-host'
  el.setAttribute('hidden', '')
  el.setAttribute('aria-label', '右侧面板')
  if (row) row.appendChild(el)
  else if (mainCol) mainCol.appendChild(el)
  else document.body.appendChild(el)
  return el
}

/** @param {HTMLElement} host */
function readCachedRoot(host) {
  try {
    return /** @type {import('react-dom/client').Root | null} */ (
      _root || host[ROOT_KEY] || null
    )
  } catch {
    return _root
  }
}

/** @param {HTMLElement} host @param {import('react-dom/client').Root} root */
function writeCachedRoot(host, root) {
  _root = root
  try {
    host[ROOT_KEY] = root
  } catch {
    /* ignore */
  }
}

/**
 * 删掉未被当前 container fiber 认领的兄弟 aside（HMR 二次 createRoot 孤儿）。
 * @param {HTMLElement} host
 */
function pruneOrphanPanels(host) {
  const kids = [...host.children]
  if (kids.length <= 1) return
  let kept = null
  try {
    const containerKey = Object.keys(host).find((k) => k.startsWith('__reactContainer'))
    const container = containerKey ? host[containerKey] : null
    const current = container?.current || container?._internalRoot?.current
    kept = current?.child?.stateNode || null
  } catch {
    kept = null
  }
  for (const kid of kids) {
    if (kept) {
      if (kid !== kept) kid.remove()
    } else if (kid !== kids[kids.length - 1]) {
      // 找不到 fiber 时保留最后一个（通常是新树）
      kid.remove()
    }
  }
}

/** 幂等：boot / 打开小V 时可多次调用。 */
export function mountGlobalRightStage() {
  const host = ensureHost()
  const cached = readCachedRoot(host)
  if (cached) {
    writeCachedRoot(host, cached)
    cached.render(createElement(GlobalRightStageHost))
    pruneOrphanPanels(host)
    return host
  }
  // 无可用 root：清残留再挂，避免叠第二个 aside
  host.replaceChildren()
  const root = createRoot(host)
  writeCachedRoot(host, root)
  root.render(createElement(GlobalRightStageHost))
  return host
}

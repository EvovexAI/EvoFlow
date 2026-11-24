/**
 * Chat 工作台（#chat-persistent-host）是否在前台。
 * 功能页开全局 RightStage 时与 ChatApp 内 RightStagePanel 互斥挂载。
 */

type Listener = () => void

const listeners = new Set<Listener>()
let observing = false
let cached: boolean | null = null

function readVisible(): boolean {
  try {
    const host = document.getElementById('chat-persistent-host')
    return !!(host && !host.hasAttribute('hidden'))
  } catch {
    return false
  }
}

function notify() {
  const next = readVisible()
  if (cached === next) return
  cached = next
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
}

function ensureObserver() {
  if (observing || typeof MutationObserver === 'undefined') return
  const host = document.getElementById('chat-persistent-host')
  if (!host) return
  observing = true
  cached = readVisible()
  const mo = new MutationObserver(() => notify())
  mo.observe(host, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] })
  window.addEventListener('hashchange', () => {
    // 路由切换后 hidden 可能异步落定
    requestAnimationFrame(() => notify())
  })
}

export function getChatHostVisible(): boolean {
  ensureObserver()
  if (cached === null) cached = readVisible()
  return cached
}

export function subscribeChatHostVisible(fn: Listener): () => void {
  ensureObserver()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 全局目标入口浮动按钮（FAB）
 * 右下角可拖动按钮 → 点击打开「目标面板」
 */

/** 机器人图标：线条更清晰，适配小按钮内显示 */
const BOT_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
  <path d="M12 3v2" />
  <circle cx="12" cy="2" r="1" fill="currentColor" stroke="none" />
  <rect x="5" y="6" width="14" height="12" rx="4" />
  <circle cx="9.5" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
  <circle cx="14.5" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
  <path d="M9 14.8h6" />
  <path d="M3.8 10.2h1.4M18.8 10.2h1.4" />
  <path d="M9.2 18v2M14.8 18v2" />
</svg>`

const POS_KEY = 'evopanel-fab-pos'
/** 全局右下角「目标」浮动按钮；false 时不挂载（入口仍可用聊天区底部「目标」药丸等） */
const ENABLE_AI_FAB = false

// ── 页面上下文收集器注册表 ──
const _contextProviders = {}

/**
 * 注册页面上下文提供器
 * @param {string} route - 路由路径，如 '/chat-debug'
 * @param {function} provider - 返回 { label, detail } 的函数（可 async）
 */
export function registerPageContext(route, provider) {
  _contextProviders[route] = provider
}

// ── 单例 ──
let _fab = null

/** 初始化 FAB */
export function initAIFab() {
  if (!ENABLE_AI_FAB) {
    document.querySelectorAll('.ai-fab').forEach(el => el.remove())
    _fab = null
    return null
  }
  if (_fab) return _fab
  _fab = createFab()
  showDragHintOnce(_fab.el)
  return _fab
}

/** 写入诊断上下文，点击悬浮按钮后在目标页继续处理 */
export function openAIDrawerWithError(errorCtx) {
  sessionStorage.setItem('assistant-error-context', JSON.stringify({
    scene: errorCtx.scene || '',
    title: errorCtx.title || '操作失败',
    hint: errorCtx.hint || '',
    error: truncate(errorCtx.error || '', 3000),
    ts: Date.now(),
  }))
  // 不自动导航 — FAB 按钮会出现红点提示，用户主动点击时跳转
  if (getCurrentRoute() !== '/assistant') {
    if (_fab?.el) {
      _fab.el.classList.add('has-error')
    } else {
      import('./toast.js')
        .then(({ toast }) => toast('已保存诊断上下文，点击悬浮宠物打开目标面板继续处理', 'info'))
        .catch(() => {})
    }
  } else {
    // 已在助手页 → 直接触发 banner 显示
    window.dispatchEvent(new CustomEvent('assistant-error-injected'))
  }
}

function truncate(str, max) {
  if (!str || str.length <= max) return str
  return str.slice(0, max) + '\n... (截断)'
}

// ── 创建 FAB ──
function createFab() {
  const fab = document.createElement('button')
  fab.className = 'ai-fab'
  fab.title = '目标小宠物 · 可拖动'
  fab.innerHTML = BOT_ICON
  document.body.appendChild(fab)

  // 恢复保存的位置
  restorePosition(fab)

  // ── 拖动逻辑 ──
  let _dragging = false
  let _dragMoved = false
  let _startX = 0, _startY = 0
  let _fabX = 0, _fabY = 0

  function onPointerDown(e) {
    if (e.button !== 0) return
    _dragging = true
    _dragMoved = false
    _startX = e.clientX
    _startY = e.clientY
    const rect = fab.getBoundingClientRect()
    _fabX = rect.left
    _fabY = rect.top
    fab.style.transition = 'none'
    fab.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  function onPointerMove(e) {
    if (!_dragging) return
    const dx = e.clientX - _startX
    const dy = e.clientY - _startY
    if (!_dragMoved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
    _dragMoved = true
    fab.classList.add('dragging')

    // 计算新位置（限制在视口内）
    const vw = window.innerWidth
    const vh = window.innerHeight
    const size = 48
    let newX = Math.max(8, Math.min(vw - size - 8, _fabX + dx))
    let newY = Math.max(8, Math.min(vh - size - 8, _fabY + dy))

    fab.style.left = newX + 'px'
    fab.style.top = newY + 'px'
    fab.style.right = 'auto'
    fab.style.bottom = 'auto'
  }

  function onPointerUp(e) {
    if (!_dragging) return
    _dragging = false
    fab.classList.remove('dragging')
    fab.style.transition = ''

    if (_dragMoved) {
      // 吸附到最近的边（左/右）
      const rect = fab.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const snapRight = rect.left > vw / 2
      const y = Math.max(8, Math.min(vh - 56, rect.top))

      if (snapRight) {
        fab.style.left = 'auto'
        fab.style.right = '24px'
      } else {
        fab.style.left = '24px'
        fab.style.right = 'auto'
      }
      fab.style.top = y + 'px'
      fab.style.bottom = 'auto'

      // 保存位置
      savePosition(snapRight ? 'right' : 'left', y)
    } else {
      // 没有拖动 → 点击
      handleClick()
    }
  }

  fab.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', onPointerUp)

  // ── 点击 → 打开目标面板（必要时跳转到 /chat） ──
  async function handleClick() {
    const route = getCurrentRoute()

    // 清除红点
    fab.classList.remove('has-error')

    // 若不在聊天页，先跳过去；由 ChatApp 在路由就绪后自动弹出目标面板
    if (route !== '/chat') {
      sessionStorage.setItem('evopanel-open-hosted-panel', '1')
      window.location.hash = '#/chat'
      return
    }
    window.dispatchEvent(new CustomEvent('evopanel:open-hosted-panel'))
  }

  // ── 路由：目标入口在非聊天页也可见；仅助手页隐藏 ──
  function updateVisibility() {
    const route = getCurrentRoute()
    const onAssistant = route === '/assistant'
    fab.style.display = onAssistant ? 'none' : 'flex'
    fab.classList.toggle('ai-fab--on-chat', route === '/chat')
  }

  window.addEventListener('hashchange', updateVisibility)
  updateVisibility()

  return { el: fab }
}

function getCurrentRoute() {
  return (window.location.hash.replace('#', '') || '/dashboard').split('?')[0]
}

function savePosition(side, top) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ side, top }))
  } catch {}
}

function restorePosition(fab) {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return
    const { side, top } = JSON.parse(raw)
    if (side === 'left') {
      fab.style.left = '24px'
      fab.style.right = 'auto'
    }
    if (typeof top === 'number') {
      fab.style.top = top + 'px'
      fab.style.bottom = 'auto'
    }
  } catch {}
}

const HINT_KEY = 'evopanel-fab-hint-shown'
function showDragHintOnce(el) {
  if (!el || localStorage.getItem(HINT_KEY)) return
  const tip = document.createElement('div')
  tip.className = 'ai-fab-hint'
  tip.textContent = '长按可拖动'
  el.appendChild(tip)
  localStorage.setItem(HINT_KEY, '1')
  setTimeout(() => tip.remove(), 4000)
}

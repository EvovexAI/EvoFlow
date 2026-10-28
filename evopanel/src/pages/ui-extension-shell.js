/**
 * 全页扩展嵌套壳：#/extensions/:id
 *
 * 打开策略：拿到 entry 后立刻挂 iframe（骨架盖在上面），服务启动并行进行；
 * 健康检查通过后再揭开骨架 / 必要时刷新 iframe，避免「等服务就绪才开始加载页面」。
 */
import { getCurrentRoute, navigate } from '../router.js'
import '../style/ext-apps.css'
import { toast } from '../components/toast.js'
import {
  getShellAsideCollapsed,
  setShellAsideCollapsed,
} from '../components/shell-aside.js'
import {
  ensureUiExtensionReady,
  getUiExtension,
  uiExtensionServiceStatus,
} from '../lib/ui-extensions.js'
import { attachUiExtensionBridge } from '../lib/ui-extension-bridge.js'

let _cleanupBridge = null
let _poll = null
let _mountGen = 0
/** 打开应用时自动折叠了侧栏 → 离开时恢复原状 */
let _autoCollapsedSidebar = false
/** 挂进 #tauri-main-chrome 的导航条清理 */
let _cleanupUiextChrome = null

/** restart = stop + start */
async function restartService(id) {
  const { uiExtensionServiceStop, uiExtensionServiceStart } = await import('../lib/ui-extensions.js')
  try {
    await uiExtensionServiceStop(id)
  } catch {
    /* ignore */
  }
  return uiExtensionServiceStart(id)
}

function unmountUiextNavFromChrome() {
  if (typeof _cleanupUiextChrome === 'function') {
    try {
      _cleanupUiextChrome()
    } catch {
      /* ignore */
    }
    _cleanupUiextChrome = null
  }
  const chrome = document.getElementById('tauri-main-chrome')
  if (chrome) chrome.classList.remove('tauri-main-chrome--uiext')
}

/**
 * 把返回/标题/操作挂进全局顶栏，与其它页面同一条 chrome（可拖窗）。
 * @param {HTMLElement} page
 * @param {string} id
 */
function mountUiextNavToChrome(page, id) {
  unmountUiextNavFromChrome()
  const chrome = document.getElementById('tauri-main-chrome')
  const nav = page.querySelector('.uiext-shell-nav')
  if (!chrome || !nav) return

  const actions = chrome.querySelector('.tauri-main-chrome-actions')
  chrome.classList.add('tauri-main-chrome--uiext')
  if (actions) chrome.insertBefore(nav, actions)
  else chrome.appendChild(nav)

  void import('../lib/tauri-titlebar.js')
    .then((m) => m.refreshTauriMainChromeVisibility?.())
    .catch(() => {})

  const onNavClick = async (e) => {
    const btn = e.target.closest?.('[data-act]')
    if (!btn || !nav.contains(btn)) return
    const act = btn.dataset.act
    if (act === 'back') {
      navigate('/chat')
      return
    }
    if (act === 'manage') {
      navigate('/extensions')
      return
    }
    if (act === 'restart') {
      try {
        toast('重启中…', 'info')
        await restartService(id)
        await mountFrame(page, id)
        toast('已重启', 'success')
      } catch (err) {
        toast(String(err?.message || err), 'error')
      }
    }
  }
  nav.addEventListener('click', onNavClick)

  _cleanupUiextChrome = () => {
    nav.removeEventListener('click', onNavClick)
    // 把 nav 挪回 page，避免路由切走后残留在 chrome 里
    if (nav.parentElement === chrome) {
      page.prepend(nav)
    }
    chrome.classList.remove('tauri-main-chrome--uiext')
  }
}
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
}

function extensionIdFromRoute() {
  const path = String(getCurrentRoute() || '').split('?')[0]
  const m = path.match(/^\/extensions\/([^/]+)$/)
  return m ? decodeURIComponent(m[1]) : ''
}

function stillInShellRoute() {
  return /^\/extensions\/[^/]+$/.test(String(getCurrentRoute() || '').split('?')[0])
}

export function cleanup() {
  _mountGen += 1
  if (_cleanupBridge) {
    _cleanupBridge()
    _cleanupBridge = null
  }
  if (_poll) {
    clearInterval(_poll)
    _poll = null
  }
  unmountUiextNavFromChrome()
  // 离开应用壳：把自动折叠的侧栏还原成进入前的状态
  if (_autoCollapsedSidebar && !stillInShellRoute()) {
    _autoCollapsedSidebar = false
    try {
      setShellAsideCollapsed(false)
    } catch {
      /* ignore */
    }
  }
}

export async function render() {
  cleanup()
  const page = document.createElement('div')
  page.className = 'page uiext-shell-page'
  const id = extensionIdFromRoute()
  if (!id) {
    page.innerHTML = `<div class="uiext-shell-error">缺少扩展 id</div>`
    return page
  }

  // 应用页不默认全屏:自动把左侧栏收成图标栏,离开时在 cleanup 还原
  if (document.getElementById('app-shell-aside') && !getShellAsideCollapsed()) {
    _autoCollapsedSidebar = true
    try {
      setShellAsideCollapsed(true)
    } catch {
      /* ignore */
    }
  }

  // 不另起顶栏：操作挂进全局 #tauri-main-chrome，拖窗与其它页面同一条。
  page.innerHTML = `
    <div class="uiext-shell-nav" data-tauri-no-drag>
      <button type="button" class="btn btn-ghost btn-sm" data-act="back" title="返回">←</button>
      <div class="uiext-shell-title">
        <strong class="uiext-shell-title-text" id="uiext-shell-name">加载中…</strong>
        <span class="uiext-shell-status" id="uiext-shell-status">—</span>
      </div>
      <div class="uiext-shell-ops">
        <button type="button" class="btn btn-secondary btn-sm" data-act="restart">重启服务</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="manage">管理</button>
      </div>
    </div>
    <div class="uiext-shell-body" id="uiext-shell-body">
      <div class="uiext-shell-skeleton" id="uiext-shell-skeleton">
        <div class="uiext-shell-skeleton-progress">
          <div class="uiext-shell-skeleton-bar" id="uiext-shell-skeleton-bar"></div>
        </div>
        <div class="uiext-shell-skeleton-steps">
          <span class="uiext-shell-skeleton-step" data-step="info">⏳ 正在获取扩展信息…</span>
          <span class="uiext-shell-skeleton-step" data-step="service">⏳ 正在检查服务状态…</span>
          <span class="uiext-shell-skeleton-step" data-step="start">⏳ 正在启动服务…</span>
          <span class="uiext-shell-skeleton-step" data-step="loading">⏳ 正在加载扩展…</span>
        </div>
      </div>
    </div>
  `

  queueMicrotask(() => {
    mountUiextNavToChrome(page, id)
    void mountFrame(page, id)
  })

  return page
}

/** 更新骨架屏的阶段和进度条 */
function setPhase(page, phase, progress) {
  const bar = page.querySelector('#uiext-shell-skeleton-bar')
  const steps = page.querySelectorAll('.uiext-shell-skeleton-step')
  if (bar) bar.style.width = progress + '%'
  if (steps) {
    steps.forEach((el) => {
      el.classList.toggle('is-active', el.dataset.step === phase)
    })
  }
}

/** 隐藏骨架屏、显示 iframe */
function hideSkeleton(page) {
  const skel = page.querySelector('#uiext-shell-skeleton')
  if (skel) {
    skel.hidden = true
    skel.style.display = 'none'
  }
}

function showSkeleton(page) {
  const skel = page.querySelector('#uiext-shell-skeleton')
  if (skel) {
    skel.hidden = false
    skel.style.display = ''
  }
}

function resolveEntry(row, id) {
  let entry = String(row.manifest?.ui?.entry || '').trim()
  try {
    const override = sessionStorage.getItem(`evoflow_uiext_entry:${id}`)
    if (override && /^https?:\/\//i.test(override)) {
      entry = override
      sessionStorage.removeItem(`evoflow_uiext_entry:${id}`)
    }
  } catch {
    /* ignore */
  }
  return entry
}

function paintFrame(body, { title, entry, sandbox }) {
  const skelHtml = body.querySelector('#uiext-shell-skeleton')?.outerHTML || ''
  body.innerHTML = `
    ${skelHtml}
    <iframe
      class="uiext-shell-frame"
      title="${esc(title)}"
      src="${esc(entry)}"
      sandbox="${esc(sandbox)}"
      allow="clipboard-read; clipboard-write"
    ></iframe>
  `
  return body.querySelector('iframe')
}

async function mountFrame(page, id) {
  const body = page.querySelector('#uiext-shell-body')
  // nav 已挂进 #tauri-main-chrome，不能只在 page 里查
  const nameEl =
    page.querySelector('#uiext-shell-name') || document.getElementById('uiext-shell-name')
  const stEl =
    page.querySelector('#uiext-shell-status') || document.getElementById('uiext-shell-status')
  if (!body) return

  const gen = ++_mountGen
  showSkeleton(page)
  setPhase(page, 'info', 12)

  try {
    const row = await getUiExtension(id)
    if (gen !== _mountGen) return
    if (!row) throw new Error('扩展未安装')
    if (row.enabled === false) throw new Error('扩展已禁用，请先在设置中启用')

    const title = row.manifest?.nav?.title || row.manifest?.name || id
    if (nameEl) nameEl.textContent = title

    const entry = resolveEntry(row, id)
    if (!entry) throw new Error('缺少 ui.entry')

    const sandbox = (row.manifest?.ui?.sandbox || [
      'allow-scripts',
      'allow-same-origin',
      'allow-forms',
      'allow-popups',
    ]).join(' ')

    const mode = row.manifest?.service?.mode || 'none'
    const stEarly = await uiExtensionServiceStatus(id).catch(() => null)
    if (gen !== _mountGen) return
    if (stEl) stEl.textContent = stEarly?.state || '—'
    const alreadyRunning =
      mode === 'none' ||
      stEarly?.state === 'running' ||
      stEarly?.state === 'external' ||
      stEarly?.state === 'none'

    // 立刻挂 iframe，与服务启动并行
    setPhase(page, alreadyRunning ? 'loading' : 'start', alreadyRunning ? 70 : 40)
    const iframe = paintFrame(body, { title, entry, sandbox })
    showSkeleton(page)

    if (_cleanupBridge) _cleanupBridge()
    _cleanupBridge = attachUiExtensionBridge({
      iframe,
      extensionId: id,
      manifest: row.manifest,
    })

    let iframeLoaded = false
    iframe?.addEventListener(
      'load',
      () => {
        iframeLoaded = true
        // 服务本来就在跑：首屏 load 后马上揭开，不必等 ensure
        if (gen === _mountGen && alreadyRunning) hideSkeleton(page)
      },
      { once: true },
    )

    const ready = alreadyRunning
      ? { ok: true, entry, state: stEarly?.state || 'running' }
      : await ensureUiExtensionReady(id)
    if (gen !== _mountGen) return

    if (stEl) stEl.textContent = ready.state || stEarly?.state || 'ready'
    setPhase(page, 'loading', 90)

    // 冷启动：健康检查通过前 iframe 可能已失败，就绪后刷新一次
    if (iframe && !alreadyRunning) {
      try {
        iframe.src = entry
      } catch {
        /* ignore */
      }
      await new Promise((r) => {
        const done = () => r()
        iframe.addEventListener('load', done, { once: true })
        setTimeout(done, 1200)
      })
    } else if (iframe && alreadyRunning && !iframeLoaded) {
      // 已在跑但首屏还没 load：再等一小会儿
      await new Promise((r) => {
        const done = () => r()
        iframe.addEventListener('load', done, { once: true })
        setTimeout(done, 800)
      })
    }

    hideSkeleton(page)

    if (_poll) clearInterval(_poll)
    _poll = setInterval(async () => {
      try {
        const s = await uiExtensionServiceStatus(id)
        if (stEl) stEl.textContent = s.state || '—'
      } catch {
        /* ignore */
      }
    }, 5000)
  } catch (e) {
    if (gen !== _mountGen) return
    hideSkeleton(page)
    body.innerHTML = `
      <div class="uiext-shell-error">
        <p>${esc(e?.message || e)}</p>
        <button type="button" class="btn btn-primary btn-sm" data-act="restart">重试启动</button>
        <button type="button" class="btn btn-secondary btn-sm" data-act="manage">去管理页</button>
      </div>`
  }
}

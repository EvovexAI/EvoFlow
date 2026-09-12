/**
 * 全页扩展嵌套壳：#/extensions/:id
 *
 * 打开策略：拿到 entry 后立刻挂 iframe（骨架盖在上面），服务启动并行进行；
 * 健康检查通过后再揭开骨架 / 必要时刷新 iframe，避免「等服务就绪才开始加载页面」。
 */
import { getCurrentRoute, navigate } from '../router.js'
import { toast } from '../components/toast.js'
import {
  ensureUiExtensionReady,
  getUiExtension,
  uiExtensionServiceStatus,
} from '../lib/ui-extensions.js'
import { attachUiExtensionBridge } from '../lib/ui-extension-bridge.js'

let _cleanupBridge = null
let _poll = null
let _mountGen = 0

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

  page.innerHTML = `
    <div class="uiext-shell-chrome uiext-shell-chrome--left" id="uiext-shell-chrome-left">
      <header class="uiext-shell-bar" id="uiext-shell-bar">
        <button type="button" class="btn btn-ghost btn-sm" data-act="back" title="返回">←</button>
        <div class="uiext-shell-title">
          <strong class="uiext-shell-title-text" id="uiext-shell-name">加载中…</strong>
          <span class="uiext-shell-status" id="uiext-shell-status">—</span>
        </div>
        <div class="uiext-shell-ops">
          <button type="button" class="btn btn-secondary btn-sm" data-act="restart">重启服务</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="manage">管理</button>
        </div>
      </header>
    </div>
    <div class="uiext-shell-chrome uiext-shell-chrome--right" id="uiext-shell-chrome-right" hidden>
      <div class="uiext-shell-win" id="uiext-shell-win">
        <button type="button" class="ep-window-controls-btn ep-window-controls-btn--min" data-act="win-min" title="最小化">−</button>
        <button type="button" class="ep-window-controls-btn ep-window-controls-btn--max" data-act="win-max" title="最大化">□</button>
        <button type="button" class="ep-window-controls-btn ep-window-controls-btn--close" data-act="win-close" title="关闭">×</button>
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

  if (window.__TAURI_INTERNALS__) {
    const winChrome = page.querySelector('#uiext-shell-chrome-right')
    if (winChrome) winChrome.hidden = false
  }

  page.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]')
    if (!btn) return
    const act = btn.dataset.act
    if (act === 'back') {
      navigate('/chat')
      return
    }
    if (act === 'manage') {
      navigate('/extensions')
      return
    }
    if (act === 'win-min' || act === 'win-max' || act === 'win-close') {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()
        if (act === 'win-min') void win.minimize()
        else if (act === 'win-max') void win.toggleMaximize()
        else void win.close()
      } catch {
        /* ignore */
      }
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
  })

  queueMicrotask(() => {
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
  const nameEl = page.querySelector('#uiext-shell-name')
  const stEl = page.querySelector('#uiext-shell-status')
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

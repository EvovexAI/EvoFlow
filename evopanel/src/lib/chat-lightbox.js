/** Full-screen image preview with wheel / click zoom (shared by chat + tool screenshots). */

const MIN_SCALE = 0.2
const MAX_SCALE = 8
const WHEEL_STEP = 0.12
const CLICK_STEP = 0.35

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * 复制图片到系统剪贴板。
 * - 桌面端（Tauri）：通过 Rust arboard 原生写入，最可靠
 * - Web 端：navigator.clipboard.write + ClipboardItem 兜底
 * @param {string} url — 图片 src（http/data/blob/tauri 协议均可）
 */
async function copyImageToClipboard(url) {
  // 1. 把 url 转成 data URI（base64）
  const dataUri = await urlToDataUri(url)

  // 2. 桌面端走 Rust 原生命令
  const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__?.core?.invoke)
  if (isTauri) {
    const { api } = await import('./tauri-api.js')
    await api.copyImageToClipboard(dataUri)
    return
  }

  // 3. Web 端用 Clipboard API
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    const blob = await (await fetch(dataUri)).blob()
    const item = new ClipboardItem({ [blob.type]: blob })
    await navigator.clipboard.write([item])
    return
  }

  throw new Error('当前环境不支持复制图片到剪贴板')
}

/**
 * 把任意图片 URL 转成 data URI（base64）。
 * 支持 data:/blob:/http(s):// 协议。
 */
function urlToDataUri(url) {
  return new Promise((resolve, reject) => {
    // 已经是 data URI 直接返回
    if (url.startsWith('data:')) return resolve(url)

    // blob: 或 http(s): 用 fetch + FileReader
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`fetch 失败: ${r.status}`)
        return r.blob()
      })
      .then((blob) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(reader.error || new Error('FileReader 失败'))
        reader.readAsDataURL(blob)
      })
      .catch(reject)
  })
}

/**
 * @param {string} src
 */
export function showChatLightbox(src) {
  const url = String(src || '').trim()
  if (!url) return

  const existing = document.querySelector('.chat-lightbox')
  if (existing) existing.remove()

  const el = (tag) => document.createElement(tag)

  const lb = el('div')
  lb.className = 'chat-lightbox'
  lb.setAttribute('role', 'dialog')
  lb.setAttribute('aria-modal', 'true')

  const toolbar = el('di' + 'v')
  toolbar.className = 'chat-lightbox-toolbar'

  const btnZoomOut = el('button')
  btnZoomOut.type = 'button'
  btnZoomOut.className = 'chat-lightbox-btn'
  btnZoomOut.title = 'Zoom out'
  btnZoomOut.setAttribute('aria-label', 'Zoom out')
  btnZoomOut.textContent = '\u2212'

  const zoomLabel = el('span')
  zoomLabel.className = 'chat-lightbox-zoom'

  const btnZoomIn = el('button')
  btnZoomIn.type = 'button'
  btnZoomIn.className = 'chat-lightbox-btn'
  btnZoomIn.title = 'Zoom in'
  btnZoomIn.setAttribute('aria-label', 'Zoom in')
  btnZoomIn.textContent = '+'

  const btnReset = el('button')
  btnReset.type = 'button'
  btnReset.className = 'chat-lightbox-btn chat-lightbox-btn--reset'
  btnReset.title = 'Reset'
  btnReset.setAttribute('aria-label', 'Reset zoom')
  btnReset.textContent = '100%'

  // ── 复制图片到剪贴板 ──
  const btnCopy = el('button')
  btnCopy.type = 'button'
  btnCopy.className = 'chat-lightbox-btn chat-lightbox-btn--copy'
  btnCopy.title = '复制图片'
  btnCopy.setAttribute('aria-label', '复制图片到剪贴板')
  btnCopy.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'

  // ── 下载图片 ──
  const btnDownload = el('button')
  btnDownload.type = 'button'
  btnDownload.className = 'chat-lightbox-btn chat-lightbox-btn--download'
  btnDownload.title = '下载图片'
  btnDownload.setAttribute('aria-label', '下载图片到本地')
  btnDownload.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>'

  const btnClose = el('button')
  btnClose.type = 'button'
  btnClose.className = 'chat-lightbox-btn chat-lightbox-btn--close'
  btnClose.title = 'Close'
  btnClose.setAttribute('aria-label', 'Close')
  btnClose.textContent = '\u00d7'

  toolbar.append(btnZoomOut, zoomLabel, btnZoomIn, btnReset, btnCopy, btnDownload, btnClose)
  toolbar.addEventListener('click', (e) => e.stopPropagation())

  const stage = el('di' + 'v')
  stage.className = 'chat-lightbox-stage'

  const imgWrap = el('di' + 'v')
  imgWrap.className = 'chat-lightbox-img-wrap'

  const img = el('img')
  img.className = 'chat-lightbox-img'
  img.alt = ''
  img.draggable = false
  img.src = url

  imgWrap.appendChild(img)
  stage.appendChild(imgWrap)
  lb.append(toolbar, stage)

  let scale = 1
  let panX = 0
  let panY = 0
  let dragging = false
  let didDrag = false
  let dragStartX = 0
  let dragStartY = 0
  let panStartX = 0
  let panStartY = 0

  const applyTransform = () => {
    imgWrap.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`
    zoomLabel.textContent = `${Math.round(scale * 100)}%`
    btnReset.textContent = scale === 1 && panX === 0 && panY === 0 ? '100%' : 'Reset'
    stage.classList.toggle('chat-lightbox-stage--zoomed', scale > 1.02)
    img.style.cursor = scale > 1.02 ? 'grab' : 'zoom-in'
  }

  const setScale = (next, anchorX, anchorY) => {
    const prev = scale
    const clamped = clamp(next, MIN_SCALE, MAX_SCALE)
    if (clamped === prev) return
    if (anchorX != null && anchorY != null && prev > 0) {
      const ratio = clamped / prev
      panX = anchorX - (anchorX - panX) * ratio
      panY = anchorY - (anchorY - panY) * ratio
    }
    scale = clamped
    if (scale <= 1.02) {
      panX = 0
      panY = 0
    }
    applyTransform()
  }

  const resetView = () => {
    scale = 1
    panX = 0
    panY = 0
    applyTransform()
  }

  const zoomBy = (delta, clientX, clientY) => {
    const rect = stage.getBoundingClientRect()
    const ax = clientX != null ? clientX - rect.left - rect.width / 2 : 0
    const ay = clientY != null ? clientY - rect.top - rect.height / 2 : 0
    setScale(scale + delta, ax, ay)
  }

  const close = () => {
    document.removeEventListener('keydown', onKey)
    lb.remove()
  }

  btnZoomIn.addEventListener('click', (e) => {
    e.stopPropagation()
    zoomBy(CLICK_STEP)
  })
  btnZoomOut.addEventListener('click', (e) => {
    e.stopPropagation()
    zoomBy(-CLICK_STEP)
  })
  btnReset.addEventListener('click', (e) => {
    e.stopPropagation()
    resetView()
  })
  btnClose.addEventListener('click', (e) => {
    e.stopPropagation()
    close()
  })

  // ── 复制图片到剪贴板 ──
  btnCopy.addEventListener('click', async (e) => {
    e.stopPropagation()
    if (btnCopy.disabled) return
    btnCopy.disabled = true
    const originalHTML = btnCopy.innerHTML
    btnCopy.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
    try {
      await copyImageToClipboard(url)
      btnCopy.title = '已复制 ✓'
      setTimeout(() => { btnCopy.title = '复制图片' }, 2000)
    } catch (err) {
      console.warn('[lightbox] copy image failed:', err)
      btnCopy.title = '复制失败'
      setTimeout(() => { btnCopy.title = '复制图片' }, 2000)
    } finally {
      btnCopy.innerHTML = originalHTML
      btnCopy.disabled = false
    }
  })

  // ── 下载图片 ──
  btnDownload.addEventListener('click', (e) => {
    e.stopPropagation()
    const a = el('a')
    a.href = url
    a.download = url.split('/').pop()?.split('?')[0] || `image-${Date.now()}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
  })

  img.addEventListener('click', (e) => {
    e.stopPropagation()
    if (didDrag) {
      didDrag = false
      return
    }
    const rect = stage.getBoundingClientRect()
    const ax = e.clientX - rect.left - rect.width / 2
    const ay = e.clientY - rect.top - rect.height / 2
    if (e.shiftKey) {
      zoomBy(-CLICK_STEP, e.clientX, e.clientY)
    } else if (scale >= MAX_SCALE - 0.01) {
      resetView()
    } else {
      zoomBy(CLICK_STEP, ax, ay)
    }
  })

  img.addEventListener('dblclick', (e) => {
    e.stopPropagation()
    e.preventDefault()
    resetView()
  })

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      e.stopPropagation()
      const delta = e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP
      zoomBy(delta, e.clientX, e.clientY)
    },
    { passive: false },
  )

  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || scale <= 1.02) return
    if (e.target !== img && e.target !== imgWrap && e.target !== stage) return
    e.preventDefault()
    dragging = true
    didDrag = false
    dragStartX = e.clientX
    dragStartY = e.clientY
    panStartX = panX
    panStartY = panY
    img.style.cursor = 'grabbing'
  })

  window.addEventListener(
    'mousemove',
    (e) => {
      if (!dragging) return
      if (Math.abs(e.clientX - dragStartX) > 4 || Math.abs(e.clientY - dragStartY) > 4) {
        didDrag = true
      }
      panX = panStartX + (e.clientX - dragStartX)
      panY = panStartY + (e.clientY - dragStartY)
      applyTransform()
    },
    { capture: true },
  )

  window.addEventListener(
    'mouseup',
    () => {
      if (!dragging) return
      dragging = false
      img.style.cursor = scale > 1.02 ? 'grab' : 'zoom-in'
    },
    { capture: true },
  )

  lb.addEventListener('click', (e) => {
    if (e.target === lb || e.target === stage) close()
  })

  const onKey = (e) => {
    if (e.key === 'Escape') close()
    if (e.key === '+' || e.key === '=') zoomBy(CLICK_STEP)
    if (e.key === '-' || e.key === '_') zoomBy(-CLICK_STEP)
    if (e.key === '0') resetView()
  }
  document.addEventListener('keydown', onKey)

  document.body.appendChild(lb)
  applyTransform()
}

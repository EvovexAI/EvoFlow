/**
 * Agent应用页 — 应用商店式入口
 * 路由：/extensions
 */
import '../style/ext-apps.css'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { navigate } from '../router.js'
import { showPageHelpPanel } from '../lib/page-help.js'
import { manifestHasSensitivePermissions } from '../lib/ui-extension-manifest.js'
import {
  installUiExtensionFromFolder,
  installUiExtensionFromZip,
  installUiExtensionRemote,
  listUiExtensions,
  onUiExtensionsChanged,
  resolveUiExtensionIconSrc,
  revealUiExtensionDir,
  setUiExtensionEnabled,
  uiExtensionServiceLogs,
  uiExtensionServiceStart,
  uiExtensionServiceStatus,
  uiExtensionServiceStop,
  uninstallUiExtension,
} from '../lib/ui-extensions.js'

/** @type {HTMLElement | null} */
let _root = null
/** @type {(() => void) | null} */
let _unsub = null
/** @type {string} */
let _filter = 'all'
/** @type {Array<Record<string, any>>} */
let _rows = []
/** @type {Record<string, { state?: string }>} */
let _statusMap = {}
/** 状态探测回流重绘时不再重播入场动画 */
let _firstPaintDone = false

const ICONS = {
  puzzle: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19.4 14a1.9 1.9 0 0 0 0 3.8h.6v3a1 1 0 0 1-1 1h-4.3v-1.1a1.9 1.9 0 0 0-3.8 0v1.1H6.6a1 1 0 0 1-1-1v-4.3h-1.1a1.9 1.9 0 0 1 0-3.8h1.1V8.4a1 1 0 0 1 1-1h4.3V6.3a1.9 1.9 0 0 1 3.8 0v1.1h4.3a1 1 0 0 1 1 1v4.3h-.6a1.9 1.9 0 0 0-1.9 1.2Z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  zip: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V3h7l2 2h9Z"/><path d="M12 6v4m0 3v2m0 3v1"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>',
  book: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>',
  search: '<svg class="ext-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>',
  folderArt: '<svg width="88" height="72" viewBox="0 0 88 72" fill="none" aria-hidden="true"><path d="M8 20c0-3.3 2.7-6 6-6h18l6 7h30c3.3 0 6 2.7 6 6v3H14l-6 26V20Z" fill="var(--ef-accent-soft, #eef2ff)"/><path d="M14 30h60.5c3.9 0 6.7 3.7 5.7 7.4l-5.6 21A6 6 0 0 1 68.8 63H12.5a6 6 0 0 1-5.9-7.1l5.7-21A6 6 0 0 1 14 30Z" fill="var(--accent, #5b5fef)" fill-opacity="0.16" stroke="var(--accent, #5b5fef)" stroke-opacity="0.35" stroke-width="1.5"/><circle cx="70" cy="16" r="3" fill="var(--accent, #5b5fef)" fill-opacity="0.35"/><circle cx="20" cy="9" r="2" fill="var(--accent, #5b5fef)" fill-opacity="0.22"/></svg>',
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function stateLabel(st) {
  const s = String(st || '')
  const map = {
    none: '无本地服务',
    stopped: '已停止',
    starting: '启动中',
    checking: '检测中',
    running: '运行中',
    failed: '失败',
    external: '外部服务',
    external_unknown: '需自行启动',
  }
  return map[s] || s || '—'
}

/** 卡片状态归一:用于筛选与胶囊展示 */
function statusBucket(statusState, enabled) {
  if (!enabled) return 'disabled'
  const s = String(statusState || '')
  if (s === 'running' || s === 'starting') return 'running'
  return 'stopped'
}

function pickEmoji(id) {
  const emojis = ['📦', '🔧', '🛠️', '🎨', '📊', '🤖', '🔌', '🧩', '📋', '⚡', '🧰', '📈', '🖥️', '📱', '🔗', '🔄']
  let hash = 0
  const s = String(id || '')
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i)
    hash |= 0
  }
  return emojis[Math.abs(hash) % emojis.length]
}

function closeAllMenus(root) {
  root?.querySelectorAll('.uiext-app-menu').forEach((m) => {
    m.hidden = true
  })
  root?.querySelectorAll('.uiext-app-more.is-open').forEach((b) => b.classList.remove('is-open'))
}

export function cleanup() {
  if (_unsub) {
    _unsub()
    _unsub = null
  }
  _root = null
  _rows = []
  _statusMap = {}
  _filter = 'all'
  _firstPaintDone = false
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page extensions-page'

  page.innerHTML = `
    <div class="page-header ext-hero">
      <span class="ext-hero-glow ext-hero-glow--1" aria-hidden="true"></span>
      <span class="ext-hero-glow ext-hero-glow--2" aria-hidden="true"></span>
      <div class="ext-hero-brand">
        <span class="ext-hero-icon" aria-hidden="true">${ICONS.puzzle}</span>
        <div class="ext-hero-text">
          <h1 class="page-title">Agent 应用</h1>
          <p class="page-desc">把网页应用挂进 EvoFlow：线上网址、本地目录或 zip 包，装好即可在侧栏与聊天里打开。</p>
        </div>
      </div>
      <div class="ext-page-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="ext-guide-toggle">
          ${ICONS.book}
          使用指南
        </button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="refresh" title="刷新列表">${ICONS.refresh}</button>
        <div class="ext-install-dropdown">
          <button type="button" class="btn btn-primary btn-sm" id="ext-install-toggle" aria-haspopup="menu" aria-expanded="false">
            安装应用
            ${ICONS.chevron}
          </button>
          <div class="ext-install-menu" id="ext-install-menu" hidden role="menu">
            <button type="button" class="ext-install-menu-item" data-act="folder" role="menuitem">
              <span class="ext-install-menu-ic">${ICONS.folder}</span>
              <span class="ext-install-menu-body"><b>本地文件夹</b><span>包含清单的源码工程或目录</span></span>
            </button>
            <button type="button" class="ext-install-menu-item" data-act="zip" role="menuitem">
              <span class="ext-install-menu-ic">${ICONS.zip}</span>
              <span class="ext-install-menu-body"><b>zip 包</b><span>导入打包好的应用压缩包</span></span>
            </button>
            <button type="button" class="ext-install-menu-item" data-act="remote" role="menuitem">
              <span class="ext-install-menu-ic">${ICONS.globe}</span>
              <span class="ext-install-menu-body"><b>远程入口</b><span>只填一个线上网址</span></span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="ext-remote-form" id="ext-remote-form" hidden>
      <div class="ext-remote-form-head">
        <div>
          <div class="ext-remote-form-title">添加远程 Agent 应用入口</div>
          <p class="ext-remote-form-desc">无需下载安装，填一个线上网址即可挂进侧栏。</p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-act="remote-cancel">取消</button>
      </div>
      <div class="ext-remote-form-fields">
        <div class="ext-remote-field">
          <label for="uiext-rid">应用 ID</label>
          <input class="form-input" id="uiext-rid" placeholder="my-ops" />
        </div>
        <div class="ext-remote-field">
          <label for="uiext-rname">名称</label>
          <input class="form-input" id="uiext-rname" placeholder="我的运营页" />
        </div>
        <div class="ext-remote-field ext-remote-field--wide">
          <label for="uiext-rentry">入口 URL</label>
          <input class="form-input" id="uiext-rentry" placeholder="https://example.com/my-ops" />
        </div>
      </div>
      <div class="ext-remote-form-actions">
        <button type="button" class="btn btn-primary btn-sm" data-act="remote-save">添加</button>
      </div>
    </div>

    <div class="ext-toolbar">
      <div class="ext-search-wrap">
        ${ICONS.search}
        <input class="ext-search-input" id="uiext-filter-input" placeholder="搜索应用名称、描述、ID…" aria-label="搜索应用">
      </div>
      <div class="ext-filter-chips" role="tablist" aria-label="按状态筛选">
        <button type="button" class="ext-filter-chip is-active" data-filter="all">全部</button>
        <button type="button" class="ext-filter-chip" data-filter="running">运行中</button>
        <button type="button" class="ext-filter-chip" data-filter="stopped">已停止</button>
        <button type="button" class="ext-filter-chip" data-filter="disabled">已禁用</button>
      </div>
      <span class="ext-count" id="uiext-count"></span>
    </div>

    <div id="uiext-list" class="ext-list-host">
      <div class="ext-list-loading">正在加载应用…</div>
    </div>
  `

  bindEvents(page)
  // Return shell immediately; list paints async (status probes must not block first paint).
  void refreshList(page)
  _root = page

  if (_unsub) _unsub()
  _unsub = onUiExtensionsChanged(() => {
    void refreshList(page)
  })

  return page
}

function setInstallMenuOpen(page, open) {
  const menu = page.querySelector('#ext-install-menu')
  const toggle = page.querySelector('#ext-install-toggle')
  if (!menu || !toggle) return
  menu.hidden = !open
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
}

function syncFilterChips(page) {
  page.querySelectorAll('.ext-filter-chip').forEach((chip) => {
    chip.classList.toggle('is-active', chip.getAttribute('data-filter') === _filter)
  })
}

function bindEvents(page) {
  page.querySelector('#ext-guide-toggle')?.addEventListener('click', () => showPageHelpPanel('/extensions'))

  // 安装下拉:开合 + 点外部收起
  page.querySelector('#ext-install-toggle')?.addEventListener('click', (e) => {
    e.stopPropagation()
    const menu = page.querySelector('#ext-install-menu')
    setInstallMenuOpen(page, !menu || menu.hidden)
  })

  page.querySelector('#uiext-filter-input')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase()
    page.querySelectorAll('.uiext-app').forEach((card) => {
      const name = card.dataset.name || ''
      const desc = card.dataset.desc || ''
      const id = card.dataset.id || ''
      card.style.display = !q || name.includes(q) || desc.includes(q) || id.includes(q) ? '' : 'none'
    })
  })

  page.addEventListener('click', async (e) => {
    if (!e.target.closest('.ext-install-dropdown')) {
      setInstallMenuOpen(page, false)
    }

    const filterChip = e.target.closest('.ext-filter-chip')
    if (filterChip && page.contains(filterChip)) {
      _filter = filterChip.getAttribute('data-filter') || 'all'
      syncFilterChips(page)
      paint(_statusMap)
      return
    }

    const moreBtn = e.target.closest('.uiext-app-more')
    if (moreBtn && page.contains(moreBtn)) {
      e.stopPropagation()
      const id = moreBtn.dataset.id
      const menu = page.querySelector(`.uiext-app-menu[data-menu-for="${CSS.escape(id)}"]`)
      const wasOpen = moreBtn.classList.contains('is-open')
      closeAllMenus(page)
      if (!wasOpen && menu) {
        menu.hidden = false
        moreBtn.classList.add('is-open')
      }
      return
    }

    const card = e.target.closest('.uiext-app')
    if (
      card &&
      page.contains(card) &&
      !e.target.closest('[data-act]') &&
      !e.target.closest('.uiext-app-more') &&
      !e.target.closest('.uiext-app-menu') &&
      !e.target.closest('.uiext-logs')
    ) {
      closeAllMenus(page)
      if (card.dataset.openable === '1') {
        navigate(`/extensions/${encodeURIComponent(card.dataset.id)}`)
      }
      return
    }

    if (!e.target.closest('.uiext-app-menu')) {
      closeAllMenus(page)
    }

    const btn = e.target.closest('[data-act]')
    if (!btn || !page.contains(btn)) return
    const act = btn.dataset.act
    const id = btn.dataset.id
    try {
      if (act === 'refresh') {
        await refreshList(page)
        return
      }
      if (act === 'folder') {
        setInstallMenuOpen(page, false)
        await installUiExtensionFromFolder()
        toast('已安装Agent应用', 'success')
        await refreshList(page)
        return
      }
      if (act === 'zip') {
        setInstallMenuOpen(page, false)
        await installUiExtensionFromZip()
        toast('已导入Agent应用', 'success')
        await refreshList(page)
        return
      }
      if (act === 'remote') {
        setInstallMenuOpen(page, false)
        const box = page.querySelector('#ext-remote-form')
        if (box) box.hidden = !box.hidden
        if (box && !box.hidden) box.querySelector('input')?.focus()
        return
      }
      if (act === 'remote-cancel') {
        const box = page.querySelector('#ext-remote-form')
        if (box) box.hidden = true
        return
      }
      if (act === 'remote-save') {
        const rid = page.querySelector('#uiext-rid')?.value?.trim()
        const rname = page.querySelector('#uiext-rname')?.value?.trim()
        const rentry = page.querySelector('#uiext-rentry')?.value?.trim()
        await installUiExtensionRemote({ id: rid, name: rname, entry: rentry })
        toast('已添加远程Agent应用', 'success')
        const box = page.querySelector('#ext-remote-form')
        if (box) box.hidden = true
        await refreshList(page)
        return
      }
      if (act === 'open' && id) {
        navigate(`/extensions/${encodeURIComponent(id)}`)
        return
      }
      if (act === 'toggle' && id) {
        const enabling = btn.dataset.enabled !== '1'
        if (enabling) {
          const { getUiExtension } = await import('../lib/ui-extensions.js')
          const row = await getUiExtension(id)
          if (manifestHasSensitivePermissions(row?.manifest)) {
            const ok = await showConfirm('该Agent应用申请了任务派发/打开权限，确认启用？')
            if (!ok) return
          }
        }
        await setUiExtensionEnabled(id, enabling)
        await refreshList(page)
        return
      }
      if (act === 'start' && id) {
        toast('正在启动…', 'info')
        await uiExtensionServiceStart(id)
        toast('服务已启动', 'success')
        await refreshList(page)
        return
      }
      if (act === 'stop' && id) {
        await uiExtensionServiceStop(id)
        toast('已停止', 'success')
        await refreshList(page)
        return
      }
      if (act === 'logs' && id) {
        const pre = page.querySelector(`[data-logs-for="${CSS.escape(id)}"]`)
        if (!pre) return
        const { log } = await uiExtensionServiceLogs(id)
        pre.textContent = log || '(空)'
        pre.hidden = !pre.hidden
        closeAllMenus(page)
        return
      }
      if (act === 'reveal' && id) {
        await revealUiExtensionDir(id)
        return
      }
      if (act === 'uninstall' && id) {
        const ok = await showConfirm(`确定卸载「${btn.dataset.title || id}」？`)
        if (!ok) return
        await uninstallUiExtension(id)
        toast('已卸载', 'success')
        await refreshList(page)
      }
    } catch (err) {
      toast(String(err?.message || err), 'error')
    }
  })

  page.addEventListener('keydown', (e) => {
    const card = e.target.closest?.('.uiext-app')
    if (!card || !page.contains(card)) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    if (e.target.closest('[data-act]') || e.target.closest('.uiext-app-more')) return
    if (card.dataset.openable !== '1') return
    e.preventDefault()
    navigate(`/extensions/${encodeURIComponent(card.dataset.id)}`)
  })
}

function iconInnerHtml(row, m) {
  const fallback = pickEmoji(row.id)
  const resolved = resolveUiExtensionIconSrc(m.icon, row.install_path || '', row.icon_src || '')
  if (resolved.kind === 'img') {
    return {
      html: `<img src="${esc(resolved.src)}" alt="" data-fallback="${esc(fallback)}" onerror="this.onerror=null;const f=this.getAttribute('data-fallback')||'📦';this.replaceWith(document.createTextNode(f))" />`,
      isImg: true,
    }
  }
  if (resolved.kind === 'glyph') return { html: resolved.text, isImg: false }
  return { html: fallback, isImg: false }
}

/** id → 稳定的图标色调(0..5),让卡片图标底色各有个性 */
function iconToneClass(id) {
  const tones = ['ext-tone-violet', 'ext-tone-sky', 'ext-tone-amber', 'ext-tone-emerald', 'ext-tone-rose', 'ext-tone-cyan']
  let hash = 0
  const s = String(id || '')
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i)
    hash |= 0
  }
  return tones[Math.abs(hash) % tones.length]
}

async function refreshList(page) {
  const el = page.querySelector('#uiext-list')
  if (!el) return
  _firstPaintDone = false

  // 骨架屏:先铺 8 张占位卡,数据到了再替换
  el.innerHTML = `<div class="ext-skel-grid">${Array.from({ length: 8 }, () => `
    <div class="ext-skel-card" aria-hidden="true">
      <div class="ext-skel-row">
        <span class="ext-skeleton ext-skel-icon"></span>
        <span class="ext-skeleton ext-skel-name"></span>
      </div>
      <span class="ext-skeleton ext-skel-line"></span>
      <span class="ext-skeleton ext-skel-line ext-skel-line--short"></span>
      <span class="ext-skeleton ext-skel-pill"></span>
    </div>`).join('')}</div>`

  try {
    const { takeNavWarm } = await import('../lib/nav-panel-prefetch.js')
    let allRows = takeNavWarm('extensions:list')
    if (!Array.isArray(allRows)) {
      allRows = await listUiExtensions()
    }
    const rows = allRows.filter((row) => row.kind !== 'suite' && String(row.manifest?.kind || '') !== 'suite')

    rows.sort((a, b) => {
      const na = a.manifest?.nav?.title || a.manifest?.name || a.id || ''
      const nb = b.manifest?.nav?.title || b.manifest?.name || b.id || ''
      return na.localeCompare(nb, 'zh-CN')
    })
    _rows = rows

    const countEl = page.querySelector('#uiext-count')
    if (!rows.length) {
      if (countEl) countEl.textContent = ''
      el.innerHTML = `<div class="ext-empty-state">
        <div class="ext-empty-art" aria-hidden="true">${ICONS.folderArt}</div>
        <h3 class="ext-empty-title">还没有 Agent 应用</h3>
        <p class="ext-empty-text">把常用的网页工具挂进来,像装应用一样:本地文件夹 / zip 包 / 远程网址,三种方式任选。</p>
        <div class="ext-empty-actions">
          <button type="button" class="btn btn-primary btn-sm" data-act="folder">安装本地应用</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="remote">添加远程入口</button>
        </div>
      </div>`
      return
    }

    // 先按名称出卡片，状态灯后台补齐（避免每个Agent应用 TCP 探测拖住整页）
    if (countEl) countEl.textContent = `${rows.length} 个`

    const pending = {}
    for (const row of rows) pending[row.id] = { state: 'checking' }
    _statusMap = { ...pending }
    paint(_statusMap)

    void Promise.all(
      rows.map(async (row) => {
        try {
          _statusMap[row.id] = await uiExtensionServiceStatus(row.id)
        } catch {
          _statusMap[row.id] = { state: '—' }
        }
      }),
    ).then(() => {
      if (page.isConnected) paint(_statusMap)
    })
  } catch (e) {
    el.innerHTML = `<div class="ext-list-error">
      <div class="ext-list-error-msg">加载失败: ${esc(e?.message || e)}</div>
      <button class="btn btn-secondary btn-sm" id="btn-uiext-retry">重试</button>
    </div>`
    el.querySelector('#btn-uiext-retry').onclick = () => refreshList(page)
  }
}

function paint(statusMap) {
  const el = _root?.querySelector('#uiext-list')
  if (!el || !_rows.length) return
  const page = _root
  if (!page) return
  const animate = !_firstPaintDone
  _firstPaintDone = true

  const statusOrder = { running: 0, starting: 1, stopped: 2, failed: 3 }
  const ordered = [..._rows].sort((a, b) => {
    const sa = statusMap[a.id]?.state || ''
    const sb = statusMap[b.id]?.state || ''
    const oa = statusOrder[sa] !== undefined ? statusOrder[sa] : 4
    const ob = statusOrder[sb] !== undefined ? statusOrder[sb] : 4
    if (oa !== ob) return oa - ob
    const na = a.manifest?.nav?.title || a.manifest?.name || a.id || ''
    const nb = b.manifest?.nav?.title || b.manifest?.name || b.id || ''
    return na.localeCompare(nb, 'zh-CN')
  })

  const visible = ordered.filter((row) => {
    if (_filter === 'all') return true
    const enabled = row.enabled !== false
    const state = String(statusMap[row.id]?.state || '')
    const statusState = !enabled
      ? 'disabled'
      : ['running', 'starting', 'failed', 'external', 'external_unknown', 'checking'].includes(state)
        ? state
        : 'stopped'
    return statusBucket(statusState, enabled) === _filter
  })

  const countEl = page.querySelector('#uiext-count')
  if (countEl) {
    countEl.textContent = _filter === 'all' ? `${_rows.length} 个` : `${visible.length} / ${_rows.length} 个`
  }

  const cards = visible.map((row, idx) => {
    const status = statusMap[row.id] || { state: 'checking' }
    const m = row.manifest || {}
    const title = m.nav?.title || m.name || row.id
    const enabled = row.enabled !== false
    const version = m.version || ''
    const desc = m.description || ''
    const state = String(status.state || '')
    const openable = enabled
    const statusState = !enabled
      ? 'disabled'
      : ['running', 'starting', 'failed', 'external', 'external_unknown', 'checking'].includes(state)
        ? state
        : 'stopped'
    const statusTitle = !enabled ? '已禁用' : stateLabel(statusState)
    const bucket = statusBucket(statusState, enabled)
    const icon = iconInnerHtml(row, m)

    return `
    <article
      class="uiext-app${enabled ? '' : ' is-disabled'}${animate ? ' ext-anim' : ''}"
      style="${animate ? `--i:${idx};` : ''}"
      data-id="${esc(row.id)}"
      data-name="${esc(title)}"
      data-desc="${esc(desc)}"
      data-openable="${openable ? '1' : '0'}"
      tabindex="${openable ? '0' : '-1'}"
    >
      <div class="uiext-app-top">
        <div class="uiext-app-icon ${icon.isImg ? '' : iconToneClass(row.id)}" aria-hidden="true">${icon.html}</div>
        <div class="uiext-app-idblock">
          <h3 class="uiext-app-name" title="${esc(title)}">${esc(title)}</h3>
          <div class="uiext-app-sub">
            ${version ? `<span class="uiext-app-version">v${esc(version)}</span>` : ''}
            ${enabled ? '' : '<span class="uiext-app-off-tag">已禁用</span>'}
          </div>
        </div>
        <button type="button" class="uiext-app-more" data-id="${esc(row.id)}" aria-label="管理 ${esc(title)}" title="管理">
          <span aria-hidden="true">···</span>
        </button>
      </div>
      <p class="uiext-app-desc">${esc(desc || '点击打开应用')}</p>
      <div class="uiext-app-foot">
        <span class="uiext-status-pill" data-bucket="${esc(bucket)}" data-state="${esc(statusState)}" title="${esc(statusTitle)}">
          <span class="uiext-status-dot" aria-hidden="true"></span>
          ${esc(statusTitle)}
        </span>
        ${openable ? `<span class="uiext-app-open" aria-hidden="true">${ICONS.arrow}</span>` : ''}
      </div>
      <div class="uiext-app-menu" hidden data-menu-for="${esc(row.id)}" role="menu">
        <button type="button" class="uiext-app-menu-item" data-act="toggle" data-id="${esc(row.id)}" data-enabled="${enabled ? '1' : '0'}">${enabled ? '禁用应用' : '启用应用'}</button>
        <button type="button" class="uiext-app-menu-item" data-act="start" data-id="${esc(row.id)}">启动服务</button>
        <button type="button" class="uiext-app-menu-item" data-act="stop" data-id="${esc(row.id)}">停止服务</button>
        <button type="button" class="uiext-app-menu-item" data-act="logs" data-id="${esc(row.id)}">查看日志</button>
        <button type="button" class="uiext-app-menu-item" data-act="reveal" data-id="${esc(row.id)}">打开目录</button>
        <button type="button" class="uiext-app-menu-item uiext-app-menu-item--danger" data-act="uninstall" data-id="${esc(row.id)}" data-title="${esc(title)}">卸载</button>
      </div>
      <pre class="uiext-logs" data-logs-for="${esc(row.id)}" hidden></pre>
    </article>`
  })

  el.innerHTML = visible.length
    ? `<div class="ext-app-grid">${cards.join('')}</div>`
    : `<div class="ext-empty-state ext-empty-state--filter">
        <p class="ext-empty-text">没有「${_filter === 'running' ? '运行中' : _filter === 'disabled' ? '已禁用' : '已停止'}」状态的应用。</p>
      </div>`
}

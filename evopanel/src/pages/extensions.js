/**
 * 扩展应用页 — 应用商店式入口
 * 路由：/extensions
 */
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

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
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
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page extensions-page'

  page.innerHTML = `
    <div class="page-header ext-page-header">
      <div>
        <h1 class="page-title">扩展应用</h1>
        <p class="page-desc">把网页应用挂进 EvoFlow：可以是线上网址，也可以是带清单的本地目录 / zip（源码工程需写明启动方式）。</p>
      </div>
      <div class="ext-page-actions">
        <button type="button" class="btn btn-primary btn-sm" data-act="folder">安装本地扩展</button>
        <button type="button" class="btn btn-secondary btn-sm" data-act="zip">导入 zip</button>
        <button type="button" class="btn btn-secondary btn-sm" data-act="remote" id="ext-remote-toggle">添加远程入口</button>
        <button type="button" class="btn btn-ghost btn-sm" id="ext-guide-toggle">使用指南</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="refresh">刷新</button>
      </div>
    </div>

    <div class="ext-remote-form" id="ext-remote-form" hidden>
      <div class="ext-remote-form-title">添加远程扩展入口</div>
      <div class="ext-remote-form-fields">
        <div class="ext-remote-field">
          <label for="uiext-rid">扩展 ID</label>
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
        <button type="button" class="btn btn-primary btn-sm" data-act="remote-save">安装</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="remote-cancel">取消</button>
      </div>
    </div>

    <div class="ext-toolbar">
      <div class="ext-search-wrap">
        <svg class="ext-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input class="ext-search-input" id="uiext-filter-input" placeholder="搜索应用…" aria-label="搜索应用">
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

function bindEvents(page) {
  page.querySelector('#ext-guide-toggle')?.addEventListener('click', () => showPageHelpPanel('/extensions'))

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
        await installUiExtensionFromFolder()
        toast('已安装扩展', 'success')
        await refreshList(page)
        return
      }
      if (act === 'zip') {
        await installUiExtensionFromZip()
        toast('已导入扩展', 'success')
        await refreshList(page)
        return
      }
      if (act === 'remote') {
        const box = page.querySelector('#ext-remote-form')
        if (box) box.hidden = !box.hidden
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
        toast('已添加远程扩展', 'success')
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
            const ok = await showConfirm('该扩展申请了任务派发/打开权限，确认启用？')
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
    return `<img src="${esc(resolved.src)}" alt="" data-fallback="${esc(fallback)}" onerror="this.onerror=null;const f=this.getAttribute('data-fallback')||'📦';this.replaceWith(document.createTextNode(f))" />`
  }
  if (resolved.kind === 'glyph') return resolved.text
  return fallback
}

async function refreshList(page) {
  const el = page.querySelector('#uiext-list')
  if (!el) return

  el.innerHTML = `<div class="ext-list-loading">正在加载应用…</div>`

  try {
    const { takeNavWarm } = await import('../lib/nav-panel-prefetch.js')
    let allRows = takeNavWarm('extensions:list')
    if (!Array.isArray(allRows)) {
      allRows = await listUiExtensions()
    }
    const rows = allRows.filter((row) => row.kind !== 'suite' && String(row.manifest?.kind || '') !== 'suite')
    if (!rows.length) {
      const countEl = page.querySelector('#uiext-count')
      if (countEl) countEl.textContent = ''
      el.innerHTML = `<div class="ext-empty-state">
        <div class="ext-empty-icon" aria-hidden="true">◇</div>
        <h3 class="ext-empty-title">还没有扩展应用</h3>
        <p class="ext-empty-text">选择本地文件夹安装，或导入 zip / 添加远程入口。</p>
        <button type="button" class="btn btn-primary" data-act="folder">安装本地扩展</button>
      </div>`
      return
    }

    // 先按名称出卡片，状态灯后台补齐（避免每个扩展 TCP 探测拖住整页）
    rows.sort((a, b) => {
      const na = a.manifest?.nav?.title || a.manifest?.name || a.id || ''
      const nb = b.manifest?.nav?.title || b.manifest?.name || b.id || ''
      return na.localeCompare(nb, 'zh-CN')
    })

    const countEl = page.querySelector('#uiext-count')
    if (countEl) countEl.textContent = `${rows.length} 个`

    const paint = (statusMap) => {
      const statusOrder = { running: 0, starting: 1, stopped: 2, failed: 3 }
      const ordered = [...rows].sort((a, b) => {
        const sa = statusMap[a.id]?.state || ''
        const sb = statusMap[b.id]?.state || ''
        const oa = statusOrder[sa] !== undefined ? statusOrder[sa] : 4
        const ob = statusOrder[sb] !== undefined ? statusOrder[sb] : 4
        if (oa !== ob) return oa - ob
        const na = a.manifest?.nav?.title || a.manifest?.name || a.id || ''
        const nb = b.manifest?.nav?.title || b.manifest?.name || b.id || ''
        return na.localeCompare(nb, 'zh-CN')
      })

      const cards = ordered.map((row) => {
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

        return `
        <article
          class="uiext-app${enabled ? '' : ' is-disabled'}"
          data-id="${esc(row.id)}"
          data-name="${esc(title)}"
          data-desc="${esc(desc)}"
          data-openable="${openable ? '1' : '0'}"
          tabindex="${openable ? '0' : '-1'}"
        >
          <span class="uiext-app-status" data-state="${esc(statusState)}" title="${esc(statusTitle)}" aria-label="${esc(statusTitle)}"></span>
          <div class="uiext-app-body">
            <div class="uiext-app-name-row">
              <div class="uiext-app-icon-stage">
                <div class="uiext-app-icon" aria-hidden="true">${iconInnerHtml(row, m)}</div>
              </div>
              <h3 class="uiext-app-name">${esc(title)}</h3>
              ${enabled ? '' : '<span class="uiext-app-off-tag">已禁用</span>'}
            </div>
            <p class="uiext-app-desc">${esc(desc || '点击打开应用')}</p>
            <div class="uiext-app-foot">
              <span class="uiext-app-meta">${version ? `v${esc(version)}` : ''}</span>
              <button type="button" class="uiext-app-more" data-id="${esc(row.id)}" aria-label="管理 ${esc(title)}" title="管理">
                <span aria-hidden="true">···</span>
              </button>
            </div>
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

      el.innerHTML = `<div class="ext-app-grid">${cards.join('')}</div>`
    }

    const pending = {}
    for (const row of rows) pending[row.id] = { state: 'checking' }
    paint(pending)

    const statusMap = { ...pending }
    void Promise.all(
      rows.map(async (row) => {
        try {
          statusMap[row.id] = await uiExtensionServiceStatus(row.id)
        } catch {
          statusMap[row.id] = { state: '—' }
        }
      }),
    ).then(() => {
      if (page.isConnected) paint(statusMap)
    })
  } catch (e) {
    el.innerHTML = `<div class="ext-list-error">
      <div class="ext-list-error-msg">加载失败: ${esc(e?.message || e)}</div>
      <button class="btn btn-secondary btn-sm" id="btn-uiext-retry">重试</button>
    </div>`
    el.querySelector('#btn-uiext-retry').onclick = () => refreshList(page)
  }
}

/**
 * 设置 → 资源中心 → 获取资源
 * 市场一键安装 / 本地包导入向导;catalog 来自 GitHub（EvovexAI/evoflow-resource-market）
 */
import '../../style/settings-resources.css'
import { api } from '../../lib/tauri-api.js'
import { toast } from '../../components/toast.js'

/** @type {HTMLElement | null} */
let _root = null
/** @type {string} */
let _packPath = ''
/** @type {boolean} */
let _isZip = false

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function isTauriDesktop() {
  return !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
}

function kindLabel(kind) {
  const k = String(kind || '').toLowerCase()
  if (k === 'team') return '团队'
  if (k === 'pipeline') return '流水线'
  if (k === 'full') return '完整'
  return kind || '—'
}

function reportCount(n) {
  _root?.dispatchEvent(new CustomEvent('sr-count', { detail: { panel: 'market', count: n }, bubbles: true }))
}

const ICONS = {
  folder: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  zip: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V3h7l2 2h9Z"/><path d="M12 6v4m0 3v2m0 3v1"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>',
  box: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
  folderOpen: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>',
}

function shellHtml(embedded) {
  const header = embedded
    ? ''
    : `
      <header class="sr-header">
        <div>
          <h2 class="sr-title">获取资源</h2>
          <p class="sr-desc">从市场一键安装资源包,或导入本地包(文件夹 / zip)。</p>
        </div>
        <div class="sr-header-actions">
          <button type="button" class="sr-btn" data-rm-act="goto-mine">打包分享</button>
          <button type="button" class="sr-btn" data-rm-act="refresh-catalog">刷新市场</button>
        </div>
      </header>`
  return `
    <div class="sr-root${embedded ? ' sr-root--embedded' : ''}">
      ${header}

      <section class="sr-section sr-import-hero">
        <div class="sr-import-hero__head">
          <h3>导入本地资源包</h3>
          <p>选择资源包所在位置(目录或 .zip),可选绑定工作区,预检确认后安装;装好在「已装资源」查看。</p>
        </div>
        <div class="sr-pick-cards">
          <button type="button" class="sr-pick-card" data-rm-act="pick-folder">
            <span class="sr-pick-card__icon">${ICONS.folder}</span>
            <span class="sr-pick-card__body">
              <b>选择文件夹</b>
              <span>包含 evoflow.organization.json 的资源包目录</span>
            </span>
          </button>
          <button type="button" class="sr-pick-card" data-rm-act="pick-zip">
            <span class="sr-pick-card__icon">${ICONS.zip}</span>
            <span class="sr-pick-card__body">
              <b>选择 zip 包</b>
              <span>.zip 压缩的资源包文件</span>
            </span>
          </button>
        </div>
        <div class="sr-import-selected" data-rm-selected hidden>
          <div class="sr-import-selected__path">
            <span class="sr-import-selected__file">${ICONS.file}</span>
            <span class="sr-import-selected__value" data-rm-path-label title=""></span>
            <button type="button" class="sr-btn sr-btn--tiny" data-rm-act="clear-path">更换</button>
          </div>
          <div class="sr-import-selected__row">
            <span class="sr-import-selected__ws-label">工作区(可选)</span>
            <input class="sr-input" type="text" data-rm-workspace placeholder="安装时绑定的工作区目录" />
            <button type="button" class="sr-btn" data-rm-act="pick-workspace">选择</button>
          </div>
          <div class="sr-import-selected__actions">
            <span class="sr-muted">同名 Agent / 员工已存在时安装会中止(冲突策略 fail)</span>
            <button type="button" class="sr-btn" data-rm-act="preflight">预检</button>
            <button type="button" class="sr-btn sr-btn--primary" data-rm-act="install">安装</button>
          </div>
        </div>
        <pre class="sr-log" data-rm-log hidden></pre>
      </section>

      <section class="sr-section sr-section--grow">
        <div class="sr-section-head">
          <h3>市场目录</h3>
          <div class="sr-inline-actions">
            <span class="sr-muted" data-rm-catalog-meta></span>
            <button type="button" class="sr-btn" data-rm-act="refresh-catalog">刷新</button>
          </div>
        </div>
        <div class="sr-list" data-rm-catalog>
          <div class="sr-empty">加载中…</div>
        </div>
        <p class="sr-footnote">市场与 catalog 中的资源包为第三方内容,遵循其自带许可证;一键安装不代表官方背书。</p>
      </section>
    </div>
  `
}

function setLog(obj) {
  const el = _root?.querySelector('[data-rm-log]')
  if (!el) return
  el.hidden = false
  el.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
}

function syncSelected() {
  const wrap = _root?.querySelector('[data-rm-selected]')
  const label = _root?.querySelector('[data-rm-path-label]')
  if (label instanceof HTMLElement) {
    label.textContent = _packPath || ''
    label.title = _packPath
  }
  if (wrap) wrap.hidden = !_packPath
}

async function pickPath({ directory, filters, title }) {
  if (!isTauriDesktop()) {
    const next = window.prompt(title || '请输入绝对路径', _packPath || '')
    return next == null ? null : String(next).trim()
  }
  const dlg = await import('@tauri-apps/plugin-dialog')
  const picked = await dlg.open({
    directory: !!directory,
    multiple: false,
    title: title || '选择',
    filters: filters || undefined,
  })
  const p = Array.isArray(picked) ? picked[0] : picked
  return p ? String(p) : null
}

async function onPickFolder() {
  const p = await pickPath({ directory: true, title: '选择资源包目录(含 evoflow.organization.json)' })
  if (!p) return
  _packPath = p
  _isZip = false
  syncSelected()
}

async function onPickZip() {
  const p = await pickPath({
    directory: false,
    title: '选择资源包 zip',
    filters: [{ name: 'Zip', extensions: ['zip'] }],
  })
  if (!p) return
  _packPath = p
  _isZip = true
  syncSelected()
}

async function onPickWorkspace() {
  const p = await pickPath({ directory: true, title: '选择工作区目录' })
  if (!p) return
  const input = _root?.querySelector('[data-rm-workspace]')
  if (input instanceof HTMLInputElement) input.value = p
}

function sourcePayload() {
  const path = _packPath.trim()
  if (!path) throw new Error('请先选择资源包目录或 zip')
  const isZip = _isZip || path.toLowerCase().endsWith('.zip')
  return { type: isZip ? 'zip_path' : 'path', path }
}

function workspaceValue() {
  const input = _root?.querySelector('[data-rm-workspace]')
  return input instanceof HTMLInputElement ? String(input.value || '').trim() : ''
}

async function onPreflight() {
  try {
    const source = sourcePayload()
    toast('预检中…')
    const res = await api.orgPreflight({
      source,
      workspace_path: workspaceValue() || null,
      options: { conflict_policy: 'fail' },
    })
    setLog(res)
    if (res?.ok) toast.success('预检通过,可以安装')
    else toast.error(res?.error || '预检未通过,见下方详情')
  } catch (e) {
    toast.error(String(e?.message || e))
    setLog(String(e?.message || e))
  }
}

async function afterInstalled(res) {
  setLog(res)
  toast.success(`已安装 ${res?.pack_name || res?.name || res?.pack_id || ''}`)
  try {
    const { switchResourcesPanel } = await import('./resources.js')
    switchResourcesPanel('installed')
  } catch {
    /* standalone */
  }
}

async function onInstall() {
  try {
    const source = sourcePayload()
    const ok = window.confirm('确认安装该资源包?同名 Agent / 员工已存在时将中止。')
    if (!ok) return
    toast('安装中…')
    const res = await api.orgInstall({
      source,
      workspace_path: workspaceValue() || null,
      options: { conflict_policy: 'fail' },
    })
    await afterInstalled(res)
  } catch (e) {
    const detail = e?.detail
    const msg =
      (detail && typeof detail === 'object' && (detail.error || detail.detail)) ||
      e?.message ||
      e
    toast.error(String(msg))
    setLog(detail || String(msg))
  }
}

function renderCatalog(data) {
  const list = _root?.querySelector('[data-rm-catalog]')
  const meta = _root?.querySelector('[data-rm-catalog-meta]')
  if (!list) return
  const packs = Array.isArray(data?.packs) ? data.packs : []
  reportCount(packs.length)
  if (meta) {
    meta.textContent = `${packs.length} 个包${data?.marketId ? ` · ${data.marketId}` : ''}`
  }
  if (!data?.configured) {
    list.innerHTML = `
      <div class="sr-empty">
        <b>暂时无法读取市场索引</b>
        <p>默认仓库 <code>EvovexAI/evoflow-resource-market</code> 连不上。请检查网络后点「刷新」;也可以先用上方「导入本地资源包」。</p>
      </div>`
    return
  }
  if (!packs.length) {
    list.innerHTML = `
      <div class="sr-empty">
        <b>catalog 还是空的</b>
        <p>仓库里还没有 packs;可以用上方「导入本地资源包」先装本机资源。</p>
      </div>`
    return
  }
  list.innerHTML = packs
    .map((p) => {
      const path = esc(p.path || '')
      const tags = (p.tags || []).map((t) => `<span class="sr-tag">${esc(t)}</span>`).join('')
      return `
      <article class="sr-card sr-catalog-card">
        <span class="sr-type-icon" title="资源包">${ICONS.box}</span>
        <div class="sr-card-main">
          <div class="sr-card-title">
            <span>${esc(p.name || p.id)}</span>
            <span class="sr-badge">${esc(kindLabel(p.kind))}</span>
            <span class="sr-badge sr-badge--muted">v${esc(p.version)}</span>
          </div>
          ${p.description ? `<div class="sr-card-meta">${esc(p.description)}</div>` : ''}
          <div class="sr-card-meta sr-card-meta--tags">
            ${tags}${p.author ? `<span class="sr-tag sr-tag--author">${esc(p.author)}</span>` : ''}
            <code class="sr-card-path" title="${path}">${path}</code>
          </div>
        </div>
        <div class="sr-card-actions">
          <button type="button" class="sr-btn sr-btn--primary" data-rm-act="install-market" data-pack-path="${path}">安装</button>
        </div>
      </article>`
    })
    .join('')
}

async function refreshCatalog() {
  const list = _root?.querySelector('[data-rm-catalog]')
  if (list) list.innerHTML = `<div class="sr-empty">加载中…</div>`
  try {
    const data = await api.orgMarketCatalog()
    renderCatalog(data)
  } catch (e) {
    if (list) {
      list.innerHTML = `
        <div class="sr-empty sr-empty--error">
          <b>市场目录加载失败</b>
          <p>${esc(e?.message || e)}</p>
        </div>`
    }
  }
}

async function onInstallMarket(packPath) {
  const path = String(packPath || '').trim()
  if (!path) return
  const ok = window.confirm(`从市场安装「${path}」?\n将下载 GitHub 仓库中该目录并安装。`)
  if (!ok) return
  try {
    toast('正在从市场下载并安装…')
    const res = await api.orgInstall({
      source: { type: 'market_path', path },
      workspace_path: workspaceValue() || null,
      options: { conflict_policy: 'fail' },
    })
    await afterInstalled(res)
  } catch (e) {
    const detail = e?.detail
    const msg =
      (detail && typeof detail === 'object' && (detail.error || detail.detail)) ||
      e?.message ||
      e
    toast.error(String(msg))
    setLog(detail || String(msg))
  }
}

function onClick(e) {
  const t = e.target
  if (!(t instanceof Element)) return
  const btn = t.closest('[data-rm-act]')
  if (!btn) return
  const act = btn.getAttribute('data-rm-act')
  if (act === 'pick-folder') void onPickFolder()
  if (act === 'pick-zip') void onPickZip()
  if (act === 'pick-workspace') void onPickWorkspace()
  if (act === 'clear-path') {
    _packPath = ''
    _isZip = false
    syncSelected()
  }
  if (act === 'preflight') void onPreflight()
  if (act === 'install') void onInstall()
  if (act === 'install-market') void onInstallMarket(btn.getAttribute('data-pack-path') || '')
  if (act === 'refresh-catalog') void refreshCatalog()
  if (act === 'goto-mine') {
    const nav = document.querySelector('[data-settings-tab="resources"]')
    window.location.hash = '#/settings?tab=resources&panel=mine'
    if (nav instanceof HTMLElement) nav.click()
  }
}

/**
 * @param {HTMLElement} container
 * @param {{ embedded?: boolean }} [opts]
 */
export async function mountResourceMarketInto(container, opts = {}) {
  cleanup()
  _root = container
  _packPath = ''
  _isZip = false
  container.innerHTML = shellHtml(!!opts.embedded)
  container.addEventListener('click', onClick)
  await refreshCatalog()
}

export function cleanup() {
  if (_root) {
    _root.removeEventListener('click', onClick)
    _root = null
  }
  _packPath = ''
  _isZip = false
}

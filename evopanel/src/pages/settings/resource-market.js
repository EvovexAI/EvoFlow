/**
 * 设置 → 资源市场
 * 本地导入文件夹 / zip；GitHub catalog 浏览（需配置 EVOFLOW_RESOURCE_MARKET_CATALOG_URL）
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

function shellHtml(embedded) {
  const header = embedded
    ? ''
    : `
      <header class="sr-header">
        <div>
          <h2 class="sr-title">资源市场</h2>
          <p class="sr-desc">安装别人分享的资源包（员工 + 工作流 + 技能编排）。市场索引来自 GitHub catalog；也可直接导入本地包。</p>
          <p class="sr-muted" style="margin:8px 0 0;font-size:12px;line-height:1.5">第三方资源包由其作者提供，许可证与内容以包内声明为准；安装即表示你接受其条款。EvoFlow 不背书第三方内容。</p>
        </div>
        <div class="sr-header-actions">
          <button type="button" class="sr-btn" data-rm-act="goto-mine">我的资源</button>
          <button type="button" class="sr-btn" data-rm-act="refresh-catalog">刷新市场</button>
        </div>
      </header>`
  const catalogHead = embedded
    ? `<div class="sr-section-head">
        <h3>市场目录</h3>
        <div class="sr-inline-actions">
          <span class="sr-muted" data-rm-catalog-meta></span>
          <button type="button" class="sr-btn" data-rm-act="refresh-catalog">刷新</button>
        </div>
      </div>`
    : `<div class="sr-section-head">
        <h3>市场目录</h3>
        <span class="sr-muted" data-rm-catalog-meta></span>
      </div>`
  return `
    <div class="sr-root${embedded ? ' sr-root--embedded' : ''}">
      ${header}

      <section class="sr-section">
        <div class="sr-section-head"><h3>导入本地包</h3></div>
        <div class="sr-import">
          <div class="sr-import-row">
            <input class="sr-input" type="text" data-rm-path placeholder="资源包目录或 .zip 路径" readonly />
            <button type="button" class="sr-btn" data-rm-act="pick-folder">选文件夹</button>
            <button type="button" class="sr-btn" data-rm-act="pick-zip">选 zip</button>
          </div>
          <div class="sr-import-row">
            <input class="sr-input" type="text" data-rm-workspace placeholder="工作区路径（可选，安装时绑定）" />
            <button type="button" class="sr-btn" data-rm-act="pick-workspace">选工作区</button>
          </div>
          <div class="sr-import-actions">
            <button type="button" class="sr-btn" data-rm-act="preflight">预检</button>
            <button type="button" class="sr-btn sr-btn--primary" data-rm-act="install">安装</button>
          </div>
          <pre class="sr-log" data-rm-log hidden></pre>
        </div>
      </section>

      <section class="sr-section">
        ${catalogHead}
        <p class="sr-muted" style="margin:0 0 10px;font-size:12px;line-height:1.5">远程 catalog 中的包为第三方内容，遵循各自许可证；一键安装不等于官方背书。</p>
        <div class="sr-list" data-rm-catalog>
          <div class="sr-empty">加载中…</div>
        </div>
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

function syncPathInput() {
  const input = _root?.querySelector('[data-rm-path]')
  if (input instanceof HTMLInputElement) input.value = _packPath
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
  const p = await pickPath({ directory: true, title: '选择资源包目录（含 evoflow.organization.json）' })
  if (!p) return
  _packPath = p
  _isZip = false
  syncPathInput()
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
  syncPathInput()
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
    if (res?.ok) toast.success('预检通过')
    else toast.error(res?.error || '预检未通过，见下方详情')
  } catch (e) {
    toast.error(String(e?.message || e))
    setLog(String(e?.message || e))
  }
}

async function onInstall() {
  try {
    const source = sourcePayload()
    const ok = window.confirm('确认安装该资源包？冲突策略为 fail（已存在同名 Agent/员工将中止）。')
    if (!ok) return
    toast('安装中…')
    const res = await api.orgInstall({
      source,
      workspace_path: workspaceValue() || null,
      options: { conflict_policy: 'fail' },
    })
    setLog(res)
    toast.success(`已安装 ${res?.pack_id || ''}（${res?.org_instance_id || ''}）`)
    try {
      const { switchResourcesPanel } = await import('./resources.js')
      switchResourcesPanel('installed')
    } catch {
      /* standalone */
    }
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
  if (meta) {
    if (!data?.configured) meta.textContent = '未配置 catalog URL'
    else meta.textContent = `${packs.length} 个包${data?.marketId ? ` · ${data.marketId}` : ''}`
  }
  if (!data?.configured) {
    list.innerHTML = `
      <div class="sr-empty">
        市场索引已关闭。默认使用公开仓库
        <code>EvovexAI/evoflow-resource-market</code>；
        也可设置 <code>EVOFLOW_RESOURCE_MARKET_CATALOG_URL</code> 指向其它 GitHub raw
        <code>catalog.json</code>，设为空字符串则关闭远程市场。
        <br/><br/>当前可先用上方「导入本地包」。
      </div>`
    return
  }
  if (!packs.length) {
    list.innerHTML = `<div class="sr-empty">catalog 为空，或仓库里还没有 packs。</div>`
    return
  }
  list.innerHTML = packs
    .map((p) => {
      const path = esc(p.path || '')
      return `
      <article class="sr-card" data-pack-path="${path}">
        <div class="sr-card-main">
          <div class="sr-card-title">
            <span>${esc(p.name || p.id)}</span>
            <span class="sr-badge">${esc(kindLabel(p.kind))}</span>
            <span class="sr-badge sr-badge--muted">v${esc(p.version)}</span>
          </div>
          <div class="sr-card-meta">${esc(p.description || '')}</div>
          <div class="sr-card-meta">${esc((p.tags || []).join(' · '))}${
            p.author ? ` · ${esc(p.author)}` : ''
          } · <code>${path}</code></div>
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
      list.innerHTML = `<div class="sr-empty sr-empty--error">加载失败：${esc(e?.message || e)}</div>`
    }
  }
}

async function onInstallMarket(packPath) {
  const path = String(packPath || '').trim()
  if (!path) return
  const ok = window.confirm(`从市场安装「${path}」？\n将下载 GitHub 仓库中该目录并安装。`)
  if (!ok) return
  try {
    toast('正在从市场下载并安装…')
    const res = await api.orgInstall({
      source: { type: 'market_path', path },
      workspace_path: workspaceValue() || null,
      options: { conflict_policy: 'fail' },
    })
    setLog(res)
    toast.success(`已安装 ${res?.pack_id || path}`)
    try {
      const { switchResourcesPanel } = await import('./resources.js')
      switchResourcesPanel('installed')
    } catch {
      /* standalone market panel */
    }
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

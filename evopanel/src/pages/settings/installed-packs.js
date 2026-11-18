/**
 * 设置 → 资源中心 → 已装资源
 * 已装资源包实例:列表 / 详情 / 卸载;导出请到「打包分享」勾选打包
 */
import '../../style/settings-resources.css'
import { api } from '../../lib/tauri-api.js'
import { toast } from '../../components/toast.js'
import { showConfirm } from '../../components/modal.js'

/** @type {HTMLElement | null} */
let _root = null
/** @type {Array<Record<string, any>>} */
let _items = []
/** @type {string} */
let _detailId = ''
/** @type {Map<string, Record<string, any>>} pack_id → update info */
let _updatesByPackId = new Map()

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function reportCount(n) {
  _root?.dispatchEvent(new CustomEvent('sr-count', { detail: { panel: 'installed', count: n }, bubbles: true }))
}

const ICONS = {
  team: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  pipeline: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h7a1 1 0 0 1 1 1V14M14 17.5H7a1 1 0 0 1-1-1V10"/></svg>',
  full: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
}

function kindIcon(kind) {
  return ICONS[String(kind || '').toLowerCase()] || ICONS.full
}

function kindLabel(kind) {
  const k = String(kind || '').toLowerCase()
  if (k === 'team') return '团队'
  if (k === 'pipeline') return '流水线'
  if (k === 'full') return '完整'
  return kind || '—'
}

function fmtTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(iso)
  }
}

const ARTIFACT_LABELS = [
  ['employees', 'BOT'],
  ['agents', '智能体'],
  ['apps', '工作流'],
  ['skills', '技能'],
  ['extensions', '扩展'],
  ['knowledge', '知识库'],
  ['mcp', 'MCP'],
]

function artifactSummary(arts) {
  const a = arts && typeof arts === 'object' ? arts : {}
  const parts = []
  for (const [key, label] of ARTIFACT_LABELS) {
    const n = Array.isArray(a[key]) ? a[key].length : 0
    if (n) parts.push(`${label} ${n}`)
  }
  return parts.length ? parts.join(' · ') : '无产物记录'
}

function packTitle(it) {
  return String(it?.pack_name || it?.name || it?.pack_id || '').trim() || '未命名资源包'
}

function shortPath(p) {
  const s = String(p || '').trim()
  if (s.length <= 64) return s
  return `…${s.slice(-56)}`
}

async function revealPath(absPath) {
  const p = String(absPath || '').trim()
  if (!p) {
    toast.error('没有可打开的路径')
    return
  }
  try {
    await api.revealPathInFileManager(p)
  } catch (e) {
    toast.error(String(e?.message || e))
  }
}

function shellHtml(embedded) {
  const header = embedded
    ? ''
    : `
      <header class="sr-header">
        <div>
          <h2 class="sr-title">已装资源</h2>
          <p class="sr-desc">从市场或本地安装的资源包实例。点击卡片查看装了哪些产物。</p>
        </div>
        <div class="sr-header-actions">
          <button type="button" class="sr-btn" data-ip-act="refresh">刷新</button>
        </div>
      </header>`
  const listHead = `
    <div class="sr-section-head">
      <h3>已装资源包</h3>
      <div class="sr-inline-actions">
        <span class="sr-muted" data-ip-count></span>
        ${embedded ? `<button type="button" class="sr-btn" data-ip-act="refresh">刷新</button>
        <button type="button" class="sr-btn" data-ip-act="goto-mine">去打包分享</button>` : ''}
      </div>
    </div>`
  return `
    <div class="sr-root sr-root--fill${embedded ? ' sr-root--embedded' : ''}">
      ${header}
      <section class="sr-section sr-section--grow" data-ip-list-pane>
        ${listHead}
        <div class="sr-list" data-ip-list>
          <div class="sr-empty">加载中…</div>
        </div>
      </section>
      <section class="sr-section sr-section--grow" data-ip-detail-pane hidden>
        <div class="sr-section-head">
          <div class="sr-inline-actions" style="gap:10px">
            <button type="button" class="sr-btn" data-ip-act="back-list">← 返回列表</button>
            <h3 data-ip-detail-title style="margin:0">资源包详情</h3>
          </div>
          <div class="sr-inline-actions">
            <button type="button" class="sr-btn sr-btn--primary" data-ip-act="upgrade-detail" hidden data-ip-upgrade-btn>升级</button>
            <button type="button" class="sr-btn sr-btn--danger" data-ip-act="uninstall-detail">卸载</button>
          </div>
        </div>
        <div class="sr-detail" data-ip-detail>
          <div class="sr-empty">加载中…</div>
        </div>
      </section>
    </div>
  `
}

function showList() {
  _detailId = ''
  const listPane = _root?.querySelector('[data-ip-list-pane]')
  const detailPane = _root?.querySelector('[data-ip-detail-pane]')
  if (listPane) listPane.hidden = false
  if (detailPane) detailPane.hidden = true
}

function showDetailPane() {
  const listPane = _root?.querySelector('[data-ip-list-pane]')
  const detailPane = _root?.querySelector('[data-ip-detail-pane]')
  if (listPane) listPane.hidden = true
  if (detailPane) detailPane.hidden = false
}

function artifactRows(arts, details, key) {
  const detailed = details && Array.isArray(details[key]) ? details[key] : null
  if (detailed && detailed.length) {
    return detailed
      .map((row) => {
        const id = String(row?.id || '').trim()
        const name = String(row?.name || '').trim()
        if (!id && !name) return null
        return { id, name: name || id }
      })
      .filter(Boolean)
  }
  const ids = arts && Array.isArray(arts[key]) ? arts[key] : []
  return ids.map((id) => ({ id: String(id), name: String(id) }))
}

function chipList(items, empty = '无') {
  const arr = Array.isArray(items) ? items.filter((x) => String(x || '').trim()) : []
  if (!arr.length) return `<span class="sr-muted">${esc(empty)}</span>`
  return `<div class="sr-chip-row">${arr
    .map((x) => `<span class="sr-chip">${esc(String(x))}</span>`)
    .join('')}</div>`
}

function truncateText(s, n = 480) {
  const t = String(s || '').trim()
  if (!t) return ''
  if (t.length <= n) return t
  return `${t.slice(0, n).trim()}…`
}

function renderPortabilityHints(it) {
  const bits = []
  const portable = it?.portable
  if (portable === false) {
    bits.push('本包含 folder-link / 本机路径，换机安装可能失效；分享请导出为 zip 或改为包内 copy。')
  } else if (portable === true) {
    bits.push('便携安装：扩展/技能已复制到本机数据目录，适合分享给同事。')
  }
  const extInstalls = Array.isArray(it?.extension_installs) ? it.extension_installs : []
  const linkish = extInstalls.some((row) => {
    const src = String(row?.source || '')
    return src.includes('folder-link') || src.includes('link')
  })
  if (linkish) {
    bits.push('含本机链接扩展：路径只在你这台机器有效，别人装你的「本机路径」看不到。')
  }
  if (!bits.length) return ''
  return `<div class="sr-detail-block">
    <h4>分享说明</h4>
    ${bits.map((b) => `<p class="sr-warn" style="margin:0 0 8px">${esc(b)}</p>`).join('')}
  </div>`
}

function renderBotBindingCards(bindings) {
  const rows = Array.isArray(bindings) ? bindings : []
  if (!rows.length) return ''
  return `
    <div class="sr-detail-block">
      <h4>BOT / 智能体绑定 <span class="sr-muted">(${rows.length})</span></h4>
      <p class="sr-muted" style="margin:0 0 10px">BOT 与智能体是同一配置：系统提示词、工具、MCP、技能、知识库都在这里。</p>
      ${rows
        .map((b) => {
          const title = esc(b.name || b.code)
          const code = esc(b.code || '')
          const soul = truncateText(b.soul || b.system_prompt || '', 600)
          const err = b.error ? `<p class="sr-warn">${esc(b.error)}</p>` : ''
          return `
        <details class="sr-bot-card" open>
          <summary>
            <span class="sr-bot-card__title">${title}</span>
            ${code && code !== title ? `<code>${code}</code>` : ''}
            ${b.missing ? '<span class="sr-badge sr-badge--warn">未找到运行态</span>' : ''}
          </summary>
          <div class="sr-bot-card__body">
            ${err}
            <dl class="sr-kv">
              <div><dt>工具</dt><dd>${chipList(b.tools, '未绑定工具')}</dd></div>
              <div><dt>MCP</dt><dd>${chipList(b.mcp_servers, '未绑定 MCP')}</dd></div>
              <div><dt>技能</dt><dd>${chipList(b.skills, '未绑定技能')}</dd></div>
              <div><dt>知识库</dt><dd>${chipList(b.knowledge_labels || b.knowledge_vault_ids, '未绑定知识库')}</dd></div>
            </dl>
            <div class="sr-bot-soul">
              <div class="sr-bot-soul__label">系统提示词 / SOUL</div>
              <pre class="sr-bot-soul__text">${soul ? esc(soul) : '<span class="sr-muted">（空）</span>'}</pre>
            </div>
          </div>
        </details>`
        })
        .join('')}
    </div>`
}

function renderArtifactBlocks(arts, details) {
  const blocks = ARTIFACT_LABELS.map(([key, label]) => {
    const rows = artifactRows(arts, details, key)
    if (!rows.length) return ''
    const chips = rows
      .map((row) => {
        const showCode = row.id && row.name && row.id !== row.name
        return `<span class="sr-chip sr-chip--named" title="${esc(row.id)}">
          <b>${esc(row.name)}</b>
          ${showCode ? `<code>${esc(row.id)}</code>` : ''}
        </span>`
      })
      .join('')
    return `
      <div class="sr-detail-block">
        <h4>${esc(label)} <span class="sr-muted">(${rows.length})</span></h4>
        <div class="sr-chip-row">${chips}</div>
      </div>`
  }).filter(Boolean)
  if (!blocks.length) {
    return `<div class="sr-detail-block"><p class="sr-muted">暂无产物记录</p></div>`
  }
  return blocks.join('')
}

/**
 * 拉取 BOT/Agent 运行态绑定，便于核对「装完后 MCP/工具是否还在」。
 * @param {Record<string, any>} it
 */
async function loadBotBindings(it) {
  const arts = it?.artifacts && typeof it.artifacts === 'object' ? it.artifacts : {}
  const details = it?.artifact_details && typeof it.artifact_details === 'object' ? it.artifact_details : {}
  const codes = new Set()
  for (const key of ['employees', 'agents']) {
    for (const row of artifactRows(arts, details, key)) {
      if (row.id) codes.add(row.id)
    }
  }
  /** @type {Array<Record<string, any>>} */
  const out = []
  for (const code of codes) {
    try {
      const agent = await api.getAgent(code)
      let knowledgeLabels = []
      try {
        const role = await api.proactiveGetRole(code)
        const cfg = role?.config || role || {}
        const ids = Array.isArray(cfg.knowledge_vault_ids)
          ? cfg.knowledge_vault_ids
          : Array.isArray(agent?.knowledge_vault_ids)
            ? agent.knowledge_vault_ids
            : []
        knowledgeLabels = ids.map((id) => String(id))
      } catch {
        knowledgeLabels = Array.isArray(agent?.knowledge_vault_ids)
          ? agent.knowledge_vault_ids.map((id) => String(id))
          : []
      }
      out.push({
        code,
        name: agent?.agent_name || agent?.role_name || code,
        tools: agent?.tools || [],
        mcp_servers: agent?.mcp_servers || [],
        skills: agent?.skills || [],
        knowledge_vault_ids: agent?.knowledge_vault_ids || [],
        knowledge_labels: knowledgeLabels,
        soul: agent?.soul || agent?.system_prompt || '',
        system_prompt: agent?.system_prompt || '',
      })
    } catch (e) {
      out.push({
        code,
        name: code,
        missing: true,
        error: String(e?.message || e),
        tools: [],
        mcp_servers: [],
        skills: [],
      })
    }
  }
  return out
}

function renderList(items) {
  const list = _root?.querySelector('[data-ip-list]')
  const countEl = _root?.querySelector('[data-ip-count]')
  if (!list) return
  _items = Array.isArray(items) ? items : []
  reportCount(_items.length)
  if (countEl) countEl.textContent = _items.length ? `${_items.length} 个` : ''
  if (!_items.length) {
    list.innerHTML = `
      <div class="sr-empty">
        <b>还没有安装资源包</b>
        <p>资源包会一次性装好员工、工作流与技能编排。去市场逛逛,或导入本地包。</p>
        <div class="sr-empty-actions">
          <button type="button" class="sr-btn sr-btn--primary" data-ip-act="goto-market">去获取资源</button>
          <button type="button" class="sr-btn" data-ip-act="goto-mine">打包分享本机资源</button>
        </div>
      </div>`
    return
  }
  list.innerHTML = _items
    .map((it) => {
      const id = esc(it.org_instance_id)
      const title = packTitle(it)
      const desc = String(it.description || '').trim()
      const showId = it.pack_id && it.pack_id !== title
      const upd = _updatesByPackId.get(String(it.pack_id || ''))
      const canUpdate = !!upd
      const availVer = upd ? String(upd.available_version || '') : ''
      return `
      <article class="sr-card sr-card--clickable" data-org-id="${id}" data-ip-act="open-detail" tabindex="0" role="button" aria-label="查看 ${esc(title)} 详情">
        <span class="sr-type-icon" title="${esc(kindLabel(it.kind))}">${kindIcon(it.kind)}</span>
        <div class="sr-card-main">
          <div class="sr-card-title">
            <span>${esc(title)}</span>
            <span class="sr-badge">${esc(kindLabel(it.kind))}</span>
            <span class="sr-badge sr-badge--muted">v${esc(it.pack_version)}</span>
            ${canUpdate ? `<span class="sr-badge sr-badge--update">可更新 → v${esc(availVer)}</span>` : ''}
          </div>
          ${desc ? `<div class="sr-card-meta">${esc(desc)}</div>` : ''}
          <div class="sr-card-meta">${esc(artifactSummary(it.artifacts))}${
            showId ? ` · <code>${esc(it.pack_id)}</code>` : ''
          }</div>
          <div class="sr-card-meta">安装于 ${esc(fmtTime(it.installed_at))}${
            it.workspace_path ? ` · 工作区 ${esc(it.workspace_path)}` : ''
          }</div>
          ${
            it.pack_root || (Array.isArray(it.artifacts?.pack_root) && it.artifacts.pack_root[0])
              ? `<div class="sr-card-meta">包目录 <code title="${esc(it.pack_root || it.artifacts.pack_root[0])}">${esc(shortPath(it.pack_root || it.artifacts.pack_root[0]))}</code></div>`
              : ''
          }
        </div>
        <div class="sr-card-actions">
          ${canUpdate ? `<button type="button" class="sr-btn sr-btn--primary" data-ip-act="upgrade" data-pack-id="${esc(it.pack_id)}">升级</button>` : ''}
          <button type="button" class="sr-btn" data-ip-act="open-detail" data-org-id="${id}">详情</button>
          <button type="button" class="sr-btn sr-btn--danger" data-ip-act="uninstall" data-org-id="${id}">卸载</button>
        </div>
      </article>`
    })
    .join('')
}

function renderDetail(it) {
  const host = _root?.querySelector('[data-ip-detail]')
  const titleEl = _root?.querySelector('[data-ip-detail-title]')
  const upgradeBtn = _root?.querySelector('[data-ip-upgrade-btn]')
  if (!host) return
  const title = packTitle(it)
  if (titleEl) titleEl.textContent = title
  const upd = _updatesByPackId.get(String(it.pack_id || ''))
  if (upgradeBtn instanceof HTMLElement) {
    upgradeBtn.hidden = !upd
    upgradeBtn.setAttribute('data-pack-id', String(it.pack_id || ''))
    upgradeBtn.textContent = upd ? `升级到 v${upd.available_version || ''}` : '升级'
  }
  const ws = String(it.workspace_path || '').trim()
  const packRoot = String(
    it.pack_root || (Array.isArray(it.artifacts?.pack_root) && it.artifacts.pack_root[0]) || '',
  ).trim()
  const extInstalls = Array.isArray(it.extension_installs) ? it.extension_installs : []
  const wsWarn = ws.includes('${')
    ? `<p class="sr-warn">工作区路径仍含占位符,可能是安装时未展开。重新安装或在安装时选择工作区可修复。</p>`
    : ''
  const updateBanner = upd
    ? `<p class="sr-warn">市场有新版本：v${esc(it.pack_version)} → v${esc(upd.available_version)}。点右上角「升级」一键覆盖安装。</p>`
    : ''
  const extBlock = extInstalls.length
    ? `<div class="sr-detail-block">
        <h4>Agent 应用安装目录</h4>
        <p class="sr-muted" style="margin:0 0 10px">市场安装会复制到本机；首次打开时会自动准备 npm/pip 环境。</p>
        ${extInstalls
          .map((row) => {
            const ip = String(row.install_path || '').trim()
            return `<div class="sr-chip-row" style="margin-bottom:8px;align-items:center;gap:8px;flex-wrap:wrap">
              <span class="sr-chip sr-chip--named"><b>${esc(row.name || row.id)}</b><code>${esc(row.id)}</code></span>
              ${ip ? `<code title="${esc(ip)}" style="font-size:12px">${esc(shortPath(ip))}</code>
              <button type="button" class="sr-btn" data-ip-act="reveal-path" data-path="${esc(ip)}">打开目录</button>` : '<span class="sr-muted">路径未知</span>'}
            </div>`
          })
          .join('')}
      </div>`
    : ''
  const botBlock = renderBotBindingCards(it._botBindings)
  host.innerHTML = `
    <div class="sr-detail-hero">
      <div>
        <div class="sr-card-title" style="margin:0 0 8px">
          <span>${esc(title)}</span>
          <span class="sr-badge">${esc(kindLabel(it.kind))}</span>
          <span class="sr-badge sr-badge--muted">v${esc(it.pack_version)}</span>
          ${upd ? `<span class="sr-badge sr-badge--update">可更新 → v${esc(upd.available_version)}</span>` : ''}
          <span class="sr-badge sr-badge--muted">${esc(it.status || 'active')}</span>
          ${it.portable === true ? '<span class="sr-badge sr-badge--portable">便携</span>' : ''}
          ${it.portable === false ? '<span class="sr-badge sr-badge--local">本机链接</span>' : ''}
        </div>
        <p class="sr-card-meta" style="margin:0">${esc(it.description || '无描述')}</p>
        ${updateBanner}
      </div>
    </div>
    <div class="sr-detail-block">
      <h4>实例信息</h4>
      <dl class="sr-kv">
        <div><dt>显示名</dt><dd>${esc(title)}</dd></div>
        <div><dt>包 id</dt><dd><code>${esc(it.pack_id || '—')}</code></dd></div>
        <div><dt>实例 id</dt><dd><code>${esc(it.org_instance_id || '—')}</code></dd></div>
        <div><dt>安装时间</dt><dd>${esc(fmtTime(it.installed_at))}</dd></div>
        <div><dt>工作区</dt><dd>${ws ? `<code>${esc(ws)}</code>` : '—'}</dd></div>
        <div><dt>包目录</dt><dd>${
          packRoot
            ? `<code>${esc(packRoot)}</code>
               <button type="button" class="sr-btn" style="margin-left:8px" data-ip-act="reveal-path" data-path="${esc(packRoot)}">打开目录</button>`
            : '—'
        }</dd></div>
      </dl>
      ${wsWarn}
    </div>
    ${renderPortabilityHints(it)}
    ${extBlock}
    ${botBlock}
    <div class="sr-detail-block">
      <h4>已装产物</h4>
      <p class="sr-muted" style="margin:0 0 10px">安装时写入系统的员工 / 智能体 / 技能 / MCP / 扩展等；主文案为中文显示名，编码可悬停查看。</p>
      ${renderArtifactBlocks(it.artifacts, it.artifact_details)}
    </div>
  `
}

async function openDetail(orgId) {
  const id = String(orgId || '').trim()
  if (!id) return
  _detailId = id
  showDetailPane()
  const host = _root?.querySelector('[data-ip-detail]')
  if (host) host.innerHTML = `<div class="sr-empty">加载详情…</div>`
  try {
    let it = _items.find((x) => x.org_instance_id === id)
    const remote = await api.orgGet(id)
    if (remote && typeof remote === 'object') it = { ...(it || {}), ...remote }
    if (!it) throw new Error(`未找到实例：${id}`)
    renderDetail(it)
    // 绑定详情异步补齐，避免挡住基础信息
    const bindings = await loadBotBindings(it)
    if (_detailId === id) {
      it._botBindings = bindings
      renderDetail(it)
    }
  } catch (e) {
    if (host) {
      host.innerHTML = `<div class="sr-empty sr-empty--error">加载失败：${esc(e?.message || e)}</div>`
    }
    toast.error(String(e?.message || e))
  }
}

async function refreshUpdates() {
  try {
    const res = await api.orgMarketUpdates()
    const map = new Map()
    for (const row of res?.items || []) {
      const pid = String(row?.pack_id || '').trim()
      if (pid) map.set(pid, row)
    }
    _updatesByPackId = map
  } catch {
    _updatesByPackId = new Map()
  }
}

async function refresh() {
  const list = _root?.querySelector('[data-ip-list]')
  if (list && !_detailId) list.innerHTML = `<div class="sr-empty">加载中…</div>`
  try {
    // 已装列表先渲染；市场更新检查走后台，GitHub 不通时不堵列表
    const res = await api.orgList('active')
    renderList(res?.items || [])
    void refreshUpdates().then(() => {
      if (_root && !_detailId) renderList(_items)
      else if (_detailId) {
        const still = _items.some((x) => x.org_instance_id === _detailId)
        if (still) void openDetail(_detailId)
      }
    })
    if (_detailId) {
      const still = _items.some((x) => x.org_instance_id === _detailId)
      if (still) await openDetail(_detailId)
      else showList()
    }
  } catch (e) {
    if (list) {
      list.innerHTML = `<div class="sr-empty sr-empty--error">加载失败：${esc(e?.message || e)}</div>`
    }
    toast.error(String(e?.message || e))
  }
}

async function upgradePack(packId) {
  const pid = String(packId || '').trim()
  if (!pid) return
  const upd = _updatesByPackId.get(pid)
  const cached = _items.find((x) => String(x.pack_id || '') === pid)
  const label = cached ? packTitle(cached) : pid
  const from = upd?.installed_version || cached?.pack_version || '?'
  const to = upd?.available_version || '?'
  const ok = await showConfirm(
    `升级「${label}」？\n${from} → ${to}\n将用新包覆盖同名 Agent / 员工 / 扩展（保留工作区与知识库数据）。`,
  )
  if (!ok) return
  try {
    toast('正在升级…')
    const res = await api.orgUpgrade({ pack_id: pid })
    toast.success(`已升级到 v${res?.pack_version || to}`)
    _detailId = ''
    showList()
    await refresh()
  } catch (e) {
    const detail = e?.detail
    const msg =
      (detail && typeof detail === 'object' && (detail.error || detail.detail)) ||
      e?.message ||
      e
    toast.error(String(msg))
  }
}

async function uninstall(orgId) {
  if (!orgId) return
  const cached = _items.find((x) => x.org_instance_id === orgId)
  const label = cached ? packTitle(cached) : orgId
  const ok = await showConfirm(
    `卸载资源包「${label}」？\n将移除其员工与工作流；默认保留工作区文件。`,
  )
  if (!ok) return
  try {
    toast('正在卸载…')
    await api.orgUninstall({
      org_instance_id: orgId,
      options: { keep_primitives: false, keep_workspace: true, keep_vault_data: true },
    })
    toast.success('已卸载')
    _detailId = ''
    showList()
    await refresh()
  } catch (e) {
    toast.error(String(e?.detail?.error || e?.message || e))
  }
}

function onClick(e) {
  const t = e.target
  if (!(t instanceof Element)) return
  const actBtn = t.closest('[data-ip-act]')
  if (!actBtn) return
  const act = actBtn.getAttribute('data-ip-act')
  if (act === 'refresh') void refresh()
  if (act === 'goto-market') {
    import('./resources.js').then((m) => m.switchResourcesPanel('market'))
  }
  if (act === 'goto-mine') {
    import('./resources.js').then((m) => m.switchResourcesPanel('mine'))
  }
  if (act === 'back-list') showList()
  if (act === 'open-detail') {
    void openDetail(actBtn.getAttribute('data-org-id') || '')
  }
  if (act === 'uninstall') void uninstall(actBtn.getAttribute('data-org-id') || '')
  if (act === 'uninstall-detail') void uninstall(_detailId)
  if (act === 'upgrade') void upgradePack(actBtn.getAttribute('data-pack-id') || '')
  if (act === 'upgrade-detail') void upgradePack(actBtn.getAttribute('data-pack-id') || '')
  if (act === 'reveal-path') void revealPath(actBtn.getAttribute('data-path') || '')
}

function onKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const t = e.target
  if (!(t instanceof Element)) return
  const card = t.closest('article.sr-card--clickable[data-ip-act="open-detail"]')
  if (!card || t.closest('button')) return
  e.preventDefault()
  void openDetail(card.getAttribute('data-org-id') || '')
}

/**
 * @param {HTMLElement} container
 * @param {{ embedded?: boolean }} [opts]
 */
export async function mountInstalledPacksInto(container, opts = {}) {
  cleanup()
  _root = container
  _detailId = ''
  container.innerHTML = shellHtml(!!opts.embedded)
  container.addEventListener('click', onClick)
  container.addEventListener('keydown', onKeydown)
  await refresh()
}

export function cleanup() {
  if (_root) {
    _root.removeEventListener('click', onClick)
    _root.removeEventListener('keydown', onKeydown)
    _root = null
  }
  _items = []
  _detailId = ''
  _updatesByPackId = new Map()
}

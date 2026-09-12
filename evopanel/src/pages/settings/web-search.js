/**
 * 设置 → 联网搜索
 * 配置 web_search 引擎密钥、首选后端，并一键测通。
 */
import { toast } from '../../components/toast.js'
import {
  fetchWebSearchSettings,
  patchWebSearchSettings,
  testWebSearch,
  isFieldConfigured,
  maskedSecretHint,
  sourceLabel,
  activeBackendLabel,
} from '../../lib/web-search-settings.js'

/** @type {HTMLElement | null} */
let _root = null
/** @type {any | null} */
let _snap = null
/** @type {any | null} */
let _lastTest = null

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;')
}

function availabilityMap() {
  const map = new Map()
  for (const p of _snap?.providers || []) {
    map.set(p.id, !!p.available)
  }
  return map
}

function planWebSearchBannerHtml() {
  const plan = _snap?.agent_plan_web_search
  if (!plan) return ''
  const tier = String(plan.tier_id || '').trim()
  const tierText = tier ? ` · 档位 ${tier.toUpperCase()}` : ''
  const needsKey = !!plan.needs_search_key
  const statusLine = needsKey
    ? '<p class="ws-plan-status ws-plan-status--warn">状态：套餐权益已识别，还差「联网搜索 API Key」。</p>'
    : '<p class="ws-plan-status ws-plan-status--ok">状态：已填豆包联网 Key，web_search 优先走豆包。</p>'
  return `<div class="ws-plan-banner" role="status">
    <strong>${escHtml(plan.title || plan.label || 'Agent Plan')}</strong>${escHtml(tierText)}
    ${statusLine}
  </div>`
}

function statusBadge(available, { planSourced = false, planNeedsKey = false } = {}) {
  if (planSourced && planNeedsKey) {
    return '<span class="ws-badge ws-badge--warn">套餐权益 · 待填 Key</span>'
  }
  if (planSourced && available) {
    return '<span class="ws-badge ws-badge--ok">套餐路径 · 可用</span>'
  }
  if (available) {
    return '<span class="ws-badge ws-badge--ok">可用</span>'
  }
  return '<span class="ws-badge ws-badge--off">未配置</span>'
}

function resultForProvider(id) {
  const rows = _lastTest?.results
  if (!Array.isArray(rows)) return null
  return rows.find((r) => r.name === id) || null
}

function inlineTestResultHtml(id) {
  const r = resultForProvider(id)
  if (!r) return ''

  if (r.skipped) {
    return `<div class="ws-inline-result ws-inline-result--skip" data-ws-inline-result>
      <div class="ws-inline-status">跳过 · ${escHtml(r.error || '未配置')}</div>
    </div>`
  }
  if (!r.ok) {
    return `<div class="ws-inline-result ws-inline-result--fail" data-ws-inline-result>
      <div class="ws-inline-status">失败 · ${Number(r.latency_ms || 0).toFixed(0)} ms</div>
      <div class="ws-inline-error">${escHtml(r.error || '未知错误')}</div>
    </div>`
  }

  const titles = (r.sample_titles || []).filter(Boolean)
  const list =
    titles.length > 0
      ? `<ol class="ws-inline-hits">${titles
          .map((t) => `<li title="${escAttr(t)}">${escHtml(t)}</li>`)
          .join('')}</ol>`
      : '<p class="form-hint" style="margin:4px 0 0">通过，但未返回标题样例</p>'

  return `<div class="ws-inline-result ws-inline-result--ok" data-ws-inline-result>
    <div class="ws-inline-status">通过 · ${Number(r.latency_ms || 0).toFixed(0)} ms · ${escHtml(String(r.result_count ?? 0))} 条</div>
    ${list}
  </div>`
}

function allTestSummaryHtml() {
  const data = _lastTest
  if (!data || !Array.isArray(data.results) || data.results.length <= 1) return ''
  const okCount = data.results.filter((r) => r.ok).length
  const rec = data.recommended
    ? `<span>推荐首选：<strong>${escHtml(data.recommended)}</strong>
         <button type="button" class="cron-btn sm primary" id="ws-apply-recommended" style="margin-left:8px">采用推荐</button>
       </span>`
    : '<span>没有可用引擎</span>'
  return `<div class="ws-all-summary" id="ws-all-summary">
    <span>测通全部：${okCount}/${data.results.length} 通过</span>
    ${rec}
  </div>`
}

function providerCardsHtml() {
  const settings = _snap?.settings || {}
  const avail = availabilityMap()
  const uiList = _snap?.provider_ui?.length
    ? _snap.provider_ui
    : [
        {
          id: 'doubao',
          label: '豆包搜索',
          secretField: 'doubaoApiKey',
          urlField: 'doubaoBaseUrl',
          defaultBaseUrl: 'https://open.feedcoopapi.com/search_api/web_search',
          docsUrl: 'https://docs.volcengine.com/docs/87772/2272951?lang=zh',
          signupUrl: 'https://console.volcengine.com/search-infinity/web-search-exp',
          hint: '',
        },
        {
          id: 'bocha',
          label: '博查搜索',
          secretField: 'bochaApiKey',
          urlField: 'bochaBaseUrl',
          defaultBaseUrl: 'https://api.bochaai.com/v1/web-search',
          docsUrl: 'https://open.bochaai.com/',
          signupUrl: 'https://open.bochaai.com/',
          hint: '',
        },
        {
          id: 'tavily',
          label: 'Tavily',
          secretField: 'tavilyApiKey',
          urlField: 'tavilyBaseUrl',
          defaultBaseUrl: 'https://api.tavily.com',
          docsUrl: 'https://docs.tavily.com/documentation/api-credits',
          signupUrl: 'https://app.tavily.com/home',
          hint: '',
        },
        {
          id: 'brave-free',
          label: 'Brave Search',
          secretField: 'braveApiKey',
          urlField: '',
          defaultBaseUrl: '',
          docsUrl: 'https://brave.com/search/api/',
          signupUrl: 'https://api-dashboard.search.brave.com/app/keys',
          hint: '',
        },
        {
          id: 'searxng',
          label: 'SearXNG',
          secretField: '',
          urlField: 'searxngUrl',
          defaultBaseUrl: '',
          docsUrl: 'https://docs.searxng.org/',
          signupUrl: 'https://docs.searxng.org/admin/installation.html',
          hint: '',
        },
        {
          id: 'firecrawl',
          label: 'Firecrawl',
          secretField: 'firecrawlApiKey',
          urlField: 'firecrawlApiUrl',
          defaultBaseUrl: 'https://api.firecrawl.dev',
          docsUrl: 'https://docs.firecrawl.dev/',
          signupUrl: 'https://www.firecrawl.dev/app/api-keys',
          hint: '',
        },
        {
          id: 'infoquest',
          label: 'InfoQuest',
          secretField: 'infoquestApiKey',
          urlField: '',
          defaultBaseUrl: '',
          docsUrl: 'https://docs.byteplus.com/en/docs/InfoQuest/What_is_Info_Quest',
          signupUrl: 'https://console.byteplus.com/infoquest',
          hint: '',
        },
        {
          id: 'ddgs',
          label: 'DDGS',
          secretField: '',
          urlField: '',
          defaultBaseUrl: '',
          docsUrl: 'https://pypi.org/project/ddgs/',
          signupUrl: 'https://pypi.org/project/ddgs/',
          hint: '免费兜底',
        },
      ]

  return uiList
    .map((p) => {
      const id = p.id
      const providerRow = (_snap?.providers || []).find((row) => row.id === id)
      const plan = _snap?.agent_plan_web_search
      const planSourced = id === 'doubao' && !!providerRow?.plan_sourced
      const planNeedsKey = planSourced && !!(providerRow?.plan_needs_key ?? plan?.needs_search_key)
      const available = avail.has(id) ? avail.get(id) : false
      const secretField = p.secretField || ''
      const urlField = p.urlField || ''
      const hint = maskedSecretHint(settings, secretField)
      const secretPh = hint
        ? `已保存 ${hint}`
        : planSourced
          ? '粘贴控制台领取的联网搜索 Key'
          : '粘贴 API Key'
      const urlVal = urlField && !String(settings[urlField] || '').includes('*')
        ? String(settings[urlField] || '')
        : String(settings[urlField] || '')

      const cardTitle = planSourced ? `${p.label || id}（Agent Plan 赠送）` : p.label || id
      let cardHint = p.hint || ''
      if (planSourced) {
        cardHint = '套餐赠送额度，别填 ark- 对话 Key。'
      }

      const secretRow = secretField
        ? `<label class="ws-field">
            <span>${planSourced ? '联网搜索 Key' : 'API Key'}</span>
            <input class="cron-input" type="password" autocomplete="off" spellcheck="false"
              data-ws-secret="${escAttr(secretField)}"
              placeholder="${escAttr(secretPh)}" />
            ${isFieldConfigured(settings, secretField) ? '<span class="form-hint">留空保存表示不修改已有密钥</span>' : ''}
          </label>`
        : ''

      const urlDefault = String(p.defaultBaseUrl || '').trim()
      const urlPh = id === 'searxng'
        ? 'https://searx.example.com'
        : urlDefault
          ? `默认：${urlDefault}（可留空）`
          : 'https://...'
      const urlRow = urlField
        ? `<label class="ws-field">
            <span>${id === 'searxng' ? '实例 URL' : 'Base URL（可选）'}</span>
            <input class="cron-input" type="url" autocomplete="off" spellcheck="false"
              data-ws-url="${escAttr(urlField)}"
              value="${escAttr(urlVal)}"
              placeholder="${escAttr(urlPh)}" />
            ${urlDefault && !urlVal ? `<span class="form-hint">留空则使用默认：${escHtml(urlDefault)}</span>` : ''}
          </label>`
        : ''

      const docs = !planSourced && p.docsUrl
        ? `<a class="ws-docs" href="${escAttr(p.docsUrl)}" target="_blank" rel="noopener noreferrer">文档</a>`
        : ''
      let signup = p.signupUrl || p.docsUrl || ''
      let signupLabel = '开通地址'
      if (planSourced && plan?.harness_console_url) {
        signup = plan.harness_console_url
        signupLabel = '领取 Key'
      }
      const signupBlock = signup
        ? `<div class="ws-signup">
            <span class="ws-signup-label">${escHtml(signupLabel)}</span>
            <a class="ws-signup-link" href="${escAttr(signup)}" target="_blank" rel="noopener noreferrer" title="${escAttr(signup)}">${escHtml(signup)}</a>
          </div>`
        : ''
      const altSignup =
        planSourced && plan?.standalone_console_url
          ? `<div class="ws-signup">
              <span class="ws-signup-label">或独立开通</span>
              <a class="ws-signup-link" href="${escAttr(plan.standalone_console_url)}" target="_blank" rel="noopener noreferrer" title="${escAttr(plan.standalone_console_url)}">${escHtml(plan.standalone_console_url)}</a>
            </div>`
          : ''

      return `
        <div class="ws-card${planSourced ? ' ws-card--plan' : ''}" data-ws-provider="${escAttr(id)}">
          <div class="ws-card-head">
            <div>
              <strong>${escHtml(cardTitle)}</strong>
              ${statusBadge(available, { planSourced, planNeedsKey })}
            </div>
            <div class="ws-card-actions">
              ${docs}
              <button type="button" class="cron-btn sm" data-ws-test-one="${escAttr(id)}">测试</button>
            </div>
          </div>
          ${signupBlock}
          ${altSignup}
          ${cardHint ? `<p class="form-hint" style="margin:6px 0 0">${escHtml(cardHint)}</p>` : ''}
          <div class="ws-card-body">
            ${secretRow}
            ${urlRow}
            ${!secretField && !urlField ? '<p class="form-hint" style="margin:0">无需密钥，依赖本机已安装的 ddgs 包。</p>' : ''}
          </div>
          <div class="ws-card-test" data-ws-test-slot="${escAttr(id)}">${inlineTestResultHtml(id)}</div>
        </div>`
    })
    .join('')
}

function preferredOptionsHtml() {
  const current = String(_snap?.settings?.preferredBackend || '')
  const plan = _snap?.agent_plan_web_search
  const doubaoLabel = plan ? '豆包搜索（Agent Plan 默认）' : '豆包搜索'
  const opts = [
    { id: '', label: '自动探测' },
    { id: 'doubao', label: doubaoLabel },
    { id: 'bocha', label: '博查搜索' },
    { id: 'tavily', label: 'Tavily' },
    { id: 'brave-free', label: 'Brave Search' },
    { id: 'searxng', label: 'SearXNG' },
    { id: 'firecrawl', label: 'Firecrawl' },
    { id: 'infoquest', label: 'InfoQuest' },
    { id: 'ddgs', label: 'DDGS（兜底）' },
  ]
  return opts
    .map(
      (o) =>
        `<option value="${escAttr(o.id)}" ${current === o.id ? 'selected' : ''}>${escHtml(o.label)}</option>`,
    )
    .join('')
}

function panelHtml() {
  const active = activeBackendLabel(_snap?.active_backend, _snap)
  const source = sourceLabel(_snap?.active_source || 'none')
  const queryVal = '今天 AI 新闻'
  const plan = _snap?.agent_plan_web_search
  const intro = plan
    ? ''
    : `Agent 的 <code>web_search</code> 工具使用这里配置的引擎（与「模型」页里厂商原生联网不是同一条路）。建议配置豆包搜索或 Tavily，并用测通选定首选；DDGS 仅作兜底。`
  return `
  <div class="config-section" id="ws-overview">
    <div class="config-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
      联网搜索
    </div>
    ${planWebSearchBannerHtml()}
    ${intro ? `<p class="form-hint">${intro}</p>` : ''}
    <div class="ws-active-row">
      <div>当前生效：<strong id="ws-active-backend">${escHtml(active)}</strong>
        <span class="form-hint" style="display:inline;margin-left:6px">来源：${escHtml(source)}</span>
      </div>
    </div>
    <div class="ws-pref-row">
      <label class="ws-field" style="flex:1;min-width:160px">
        <span>首选引擎（选完即保存）</span>
        <select class="cron-input" id="ws-preferred">${preferredOptionsHtml()}</select>
      </label>
      <label class="ws-field" style="flex:1.4;min-width:200px">
        <span>测试关键词</span>
        <input class="cron-input" id="ws-test-query" value="${escAttr(queryVal)}" />
      </label>
    </div>
  </div>

  <div class="config-section" id="ws-providers">
    <div class="config-section-title">引擎与密钥</div>
    <div class="ws-cards">${providerCardsHtml()}</div>
    <div class="sec-save-row" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button type="button" class="cron-btn sm primary" id="ws-test-all">测通全部</button>
      <span class="form-hint" style="margin:0">测通走后端 platform（settings.test_web_search），由 Gateway 进程探测各引擎；密钥失焦即保存</span>
    </div>
    <div id="ws-all-summary-host">${allTestSummaryHtml()}</div>
  </div>

  <style>
    .ws-active-row { margin: 10px 0 14px; font-size: 13px; }
    .ws-plan-banner {
      margin: 0 0 12px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--accent, #6366f1) 35%, transparent);
      background: color-mix(in srgb, var(--accent, #6366f1) 8%, transparent);
      font-size: 13px;
    }
    .ws-plan-status { margin: 6px 0 0; font-size: 12px; font-weight: 600; }
    .ws-plan-status--ok { color: #16a34a; }
    .ws-plan-status--warn { color: #ca8a04; }
    .ws-pref-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
    .ws-cards { display: grid; gap: 12px; }
    .ws-card { border: 1px solid var(--border-color, #333); border-radius: 8px; padding: 12px 14px; }
    .ws-card--plan {
      border-color: color-mix(in srgb, var(--accent, #6366f1) 40%, var(--border-color, #333));
      background: color-mix(in srgb, var(--accent, #6366f1) 5%, transparent);
    }
    .ws-card-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap; }
    .ws-card-actions { display: flex; gap: 8px; align-items: center; }
    .ws-card-body { display: grid; gap: 8px; margin-top: 10px; }
    .ws-card-test { margin-top: 10px; }
    .ws-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted, #888); }
    .ws-field .cron-input { width: 100%; }
    .ws-badge { font-size: 11px; margin-left: 8px; padding: 1px 6px; border-radius: 999px; }
    .ws-badge--ok { background: color-mix(in srgb, #22c55e 20%, transparent); color: #16a34a; }
    .ws-badge--warn { background: color-mix(in srgb, #eab308 22%, transparent); color: #a16207; }
    .ws-badge--off { background: color-mix(in srgb, #94a3b8 20%, transparent); color: #64748b; }
    .ws-docs { font-size: 12px; color: var(--accent, #3b82f6); text-decoration: none; }
    .ws-signup { margin-top: 8px; font-size: 12px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .ws-signup-label { color: var(--text-muted, #888); flex-shrink: 0; }
    .ws-signup-link {
      color: var(--accent, #3b82f6);
      text-decoration: none;
      word-break: break-all;
      max-width: 100%;
    }
    .ws-signup-link:hover { text-decoration: underline; }
    .ws-inline-result {
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 12px;
      border: 1px solid var(--border-color, #333);
      background: color-mix(in srgb, var(--border-color, #333) 18%, transparent);
    }
    .ws-inline-result--ok { border-color: color-mix(in srgb, #22c55e 45%, transparent); }
    .ws-inline-result--fail { border-color: color-mix(in srgb, #dc2626 45%, transparent); }
    .ws-inline-result--skip { opacity: 0.85; }
    .ws-inline-status { font-weight: 600; margin-bottom: 4px; }
    .ws-inline-result--ok .ws-inline-status { color: #16a34a; }
    .ws-inline-result--fail .ws-inline-status { color: #dc2626; }
    .ws-inline-error { color: var(--text-muted, #888); word-break: break-word; }
    .ws-inline-hits { margin: 6px 0 0; padding-left: 18px; }
    .ws-inline-hits li { margin: 2px 0; word-break: break-word; }
    .ws-all-summary {
      margin-top: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px 16px;
      align-items: center;
      font-size: 13px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px dashed var(--border-color, #333);
    }
  </style>`
}

function collectKeyPatch() {
  if (!_root) return {}
  /** @type {Record<string, string>} */
  const patch = {}
  _root.querySelectorAll('[data-ws-secret]').forEach((el) => {
    const field = el.getAttribute('data-ws-secret')
    if (!field) return
    const val = String(/** @type {HTMLInputElement} */ (el).value || '')
    if (val.trim()) patch[field] = val.trim()
  })
  _root.querySelectorAll('[data-ws-url]').forEach((el) => {
    const field = el.getAttribute('data-ws-url')
    if (!field) return
    patch[field] = String(/** @type {HTMLInputElement} */ (el).value || '').trim()
  })
  return patch
}

function readPreferredFromDom() {
  const sel = _root?.querySelector('#ws-preferred')
  return String(/** @type {HTMLSelectElement} */ (sel)?.value || '')
}

function snapshotDraftInputs() {
  /** @type {{ secrets: Record<string, string>, urls: Record<string, string>, query: string }} */
  const out = { secrets: {}, urls: {}, query: '' }
  if (!_root) return out
  _root.querySelectorAll('[data-ws-secret]').forEach((el) => {
    const field = el.getAttribute('data-ws-secret')
    if (!field) return
    const val = String(/** @type {HTMLInputElement} */ (el).value || '')
    if (val) out.secrets[field] = val
  })
  _root.querySelectorAll('[data-ws-url]').forEach((el) => {
    const field = el.getAttribute('data-ws-url')
    if (!field) return
    out.urls[field] = String(/** @type {HTMLInputElement} */ (el).value || '')
  })
  const qEl = _root.querySelector('#ws-test-query')
  out.query = String(/** @type {HTMLInputElement} */ (qEl)?.value || '')
  return out
}

function restoreDraftInputs(draft) {
  if (!_root || !draft) return
  Object.entries(draft.secrets || {}).forEach(([field, val]) => {
    const el = _root.querySelector(`[data-ws-secret="${CSS.escape(field)}"]`)
    if (el) /** @type {HTMLInputElement} */ (el).value = val
  })
  Object.entries(draft.urls || {}).forEach(([field, val]) => {
    const el = _root.querySelector(`[data-ws-url="${CSS.escape(field)}"]`)
    if (el) /** @type {HTMLInputElement} */ (el).value = val
  })
  if (draft.query) {
    const qEl = _root.querySelector('#ws-test-query')
    if (qEl) /** @type {HTMLInputElement} */ (qEl).value = draft.query
  }
}

function syncStatusFromSnap() {
  if (!_root || !_snap) return
  const activeEl = _root.querySelector('#ws-active-backend')
  if (activeEl) activeEl.textContent = activeBackendLabel(_snap.active_backend, _snap)
  const plan = _snap.agent_plan_web_search
  _root.querySelectorAll('[data-ws-provider]').forEach((card) => {
    const id = card.getAttribute('data-ws-provider')
    const head = card.querySelector('.ws-card-head strong')
    if (!head || !id) return
    const providerRow = (_snap.providers || []).find((row) => row.id === id)
    const planSourced = id === 'doubao' && !!providerRow?.plan_sourced
    const planNeedsKey = planSourced && !!(providerRow?.plan_needs_key ?? plan?.needs_search_key)
    const available = !!providerRow?.available
    const badge = card.querySelector('.ws-badge')
    const html = statusBadge(available, { planSourced, planNeedsKey })
    if (badge) badge.outerHTML = html
    else head.insertAdjacentHTML('afterend', html)
  })
}

function paintInlineTestResults({ focusId = null, pendingIds = null } = {}) {
  if (!_root) return
  _root.querySelectorAll('[data-ws-test-slot]').forEach((slot) => {
    const id = slot.getAttribute('data-ws-test-slot')
    if (!id) return
    if (pendingIds && pendingIds.includes(id)) {
      slot.innerHTML = `<div class="ws-inline-result" data-ws-inline-result>
        <div class="ws-inline-status">测通中…</div>
      </div>`
      return
    }
    // Single-engine test: clear other cards' old results only when focusing one
    if (focusId && id !== focusId && !resultForProvider(id)) {
      slot.innerHTML = ''
      return
    }
    slot.innerHTML = inlineTestResultHtml(id)
  })
  const summaryHost = _root.querySelector('#ws-all-summary-host')
  if (summaryHost) summaryHost.innerHTML = allTestSummaryHtml()
}

function render({ preserveDraft = false } = {}) {
  if (!_root) return
  const draft = preserveDraft ? snapshotDraftInputs() : null
  const preferred = preserveDraft ? readPreferredFromDom() : null
  _root.innerHTML = panelHtml()
  if (preferred != null) {
    const sel = _root.querySelector('#ws-preferred')
    if (sel) /** @type {HTMLSelectElement} */ (sel).value = preferred
  }
  if (draft) restoreDraftInputs(draft)
  paintInlineTestResults()
}

async function reload() {
  _snap = await fetchWebSearchSettings()
  render()
}

/**
 * 把表单里的密钥 / URL / 首选落盘。测试、失焦、「完成」都会走这里。
 * @param {{ quiet?: boolean, reRender?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
async function ensureSaved({ quiet = false, reRender = true } = {}) {
  if (!_root) return true
  const patch = collectKeyPatch()
  const preferredBackend = readPreferredFromDom()
  const prefChanged = preferredBackend !== String(_snap?.settings?.preferredBackend || '')
  const hasKeyChanges = Object.keys(patch).length > 0
  if (!hasKeyChanges && !prefChanged) return true

  /** @type {Record<string, string>} */
  const body = { ...patch }
  if (prefChanged || preferredBackend !== undefined) body.preferredBackend = preferredBackend

  try {
    _snap = await patchWebSearchSettings(body)
    if (!quiet) {
      if (hasKeyChanges && prefChanged) toast('密钥与首选已保存', 'success')
      else if (hasKeyChanges) toast('搜索密钥已保存', 'success')
      else toast(preferredBackend ? `已设首选：${preferredBackend}` : '已改为自动探测', 'success')
    }
    if (reRender) {
      render({ preserveDraft: true })
    } else {
      syncStatusFromSnap()
    }
    return true
  } catch (e) {
    toast(String(e?.message || e), 'error')
    return false
  }
}

async function runTest(engines) {
  const focusId = Array.isArray(engines) && engines.length === 1 ? engines[0] : null
  const pendingIds = focusId
    ? [focusId]
    : Array.from(_root?.querySelectorAll('[data-ws-test-slot]') || [])
        .map((el) => el.getAttribute('data-ws-test-slot'))
        .filter(Boolean)

  paintInlineTestResults({ pendingIds })
  const saved = await ensureSaved({ quiet: true, reRender: false })
  if (!saved) {
    if (focusId) {
      const slot = _root?.querySelector(`[data-ws-test-slot="${CSS.escape(focusId)}"]`)
      if (slot) {
        slot.innerHTML = `<div class="ws-inline-result ws-inline-result--fail" data-ws-inline-result>
          <div class="ws-inline-status">保存失败，已取消测通</div>
        </div>`
      }
    }
    return
  }

  const qEl = _root?.querySelector('#ws-test-query')
  const query = String(/** @type {HTMLInputElement} */ (qEl)?.value || '').trim() || '今天 AI 新闻'
  try {
    _lastTest = await testWebSearch({ query, engines: engines || null, max_results: 5 })
    paintInlineTestResults({ focusId })
    // Scroll the tested card into view so user sees results in place
    if (focusId) {
      _root?.querySelector(`[data-ws-provider="${CSS.escape(focusId)}"]`)?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      })
    }
    const okCount = (_lastTest.results || []).filter((r) => r.ok).length
    toast(okCount ? `测通完成：${okCount} 个引擎可用` : '测通完成：暂无可用引擎', okCount ? 'success' : 'warn')
  } catch (e) {
    if (focusId) {
      const slot = _root?.querySelector(`[data-ws-test-slot="${CSS.escape(focusId)}"]`)
      if (slot) {
        slot.innerHTML = `<div class="ws-inline-result ws-inline-result--fail" data-ws-inline-result>
          <div class="ws-inline-status">测通失败</div>
          <div class="ws-inline-error">${escHtml(e?.message || e)}</div>
        </div>`
      }
    }
    toast(String(e?.message || e), 'error')
  }
}

async function onApplyRecommended() {
  const rec = _lastTest?.recommended
  if (!rec) return
  try {
    const sel = _root?.querySelector('#ws-preferred')
    if (sel) /** @type {HTMLSelectElement} */ (sel).value = rec
    _snap = await patchWebSearchSettings({ preferredBackend: rec })
    toast(`已采用推荐首选：${rec}`, 'success')
    render({ preserveDraft: true })
  } catch (e) {
    toast(String(e?.message || e), 'error')
  }
}

function onClick(ev) {
  const t = /** @type {HTMLElement} */ (ev.target)
  if (t.closest('#ws-test-all')) {
    runTest(null)
    return
  }
  if (t.closest('#ws-apply-recommended')) {
    onApplyRecommended()
    return
  }
  const one = t.closest('[data-ws-test-one]')
  if (one) {
    const id = one.getAttribute('data-ws-test-one')
    if (id) runTest([id])
  }
}

function onChange(ev) {
  const t = /** @type {HTMLElement} */ (ev.target)
  if (t?.id === 'ws-preferred') {
    // 选完即保存，并提示当前生效引擎
    ensureSaved({ quiet: false, reRender: true })
  }
}

function onFocusOut(ev) {
  const t = /** @type {HTMLElement} */ (ev.target)
  if (!t?.matches?.('[data-ws-secret], [data-ws-url]')) return
  // 失焦自动保存；空密钥字段不会覆盖已有值
  const related = /** @type {HTMLElement | null} */ (ev.relatedTarget)
  if (related && _root?.contains(related) && related.matches?.('[data-ws-secret], [data-ws-url], #ws-preferred')) {
    return
  }
  ensureSaved({ quiet: true, reRender: false })
}

/** 设置弹窗点「完成」时落盘当前联网搜索配置 */
export async function flushWebSearchSettingsOnDone() {
  if (!_root) return true
  return ensureSaved({ quiet: true, reRender: false })
}

/**
 * @param {HTMLElement} container
 */
export async function mountWebSearchInto(container) {
  cleanup()
  _root = container
  container.addEventListener('click', onClick)
  container.addEventListener('change', onChange)
  container.addEventListener('focusout', onFocusOut)
  try {
    await reload()
  } catch (e) {
    container.innerHTML = `<div class="settings-subview-error" style="color:var(--error)">加载失败：${escHtml(e?.message || e)}</div>`
    toast(`加载联网搜索设置失败：${e?.message || e}`, 'error')
  }
}

export function cleanup() {
  if (_root) {
    _root.removeEventListener('click', onClick)
    _root.removeEventListener('change', onChange)
    _root.removeEventListener('focusout', onFocusOut)
  }
  _root = null
}

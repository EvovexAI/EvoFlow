/**
 * 模型配置 → 套餐 Tab（方舟 Agent Plan）
 */
import { showConfirm } from '../../components/modal.js'
import { toast } from '../../components/toast.js'
import { openPlanBundleWizard } from '../../lib/plan-bundle.js'
import { api } from '../../lib/tauri-api.js'

const CATALOG_ID = 'volcengine.agent_plan'
const PLAN_CHAT_BASE = 'https://ark.cn-beijing.volces.com/api/plan/v3'
const TIER_ORDER = ['small', 'medium', 'large', 'max']
const TIER_LABEL = { small: 'Small', medium: 'Medium', large: 'Large', max: 'Max' }

/** @type {HTMLElement | null} */
let _root = null
/** @type {(tab?: string) => void} */
let _onGotoChat = () => {}
/** @type {string} */
let _expandedCap = ''
/** @type {false | 'all' | string} */
let _verifyBusy = false
/**
 * @type {Record<string, { ok: boolean | null, message: string, skipped?: boolean, checks?: any[] }>}
 */
let _verifyByCap = {}

/** @type {{ catalog: any | null, binding: any | null, chatModelCount: number, embeddingModelCount: number, connectionBaseUrl: string, primaryModel: string }} */
let _state = {
  catalog: null,
  binding: null,
  chatModelCount: 0,
  embeddingModelCount: 0,
  connectionBaseUrl: '',
  primaryModel: '',
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function normalizeBase(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase()
}

function isPlanChatUrl(url) {
  return normalizeBase(url) === normalizeBase(PLAN_CHAT_BASE)
}

function capsOf(binding) {
  const caps = binding?.bound_capabilities || binding?.boundCapabilities || []
  return Array.isArray(caps) ? caps.map(String) : []
}

function currentTierId() {
  return String(_state.binding?.tier_id || _state.binding?.tierId || '').trim().toLowerCase()
}

function tierRank(id) {
  const i = TIER_ORDER.indexOf(String(id || '').toLowerCase())
  return i < 0 ? -1 : i
}

function capItems(cap, catalog) {
  if (cap?.item_source === 'chat_models') {
    return Array.isArray(catalog?.chat_models) ? catalog.chat_models : []
  }
  return Array.isArray(cap?.items) ? cap.items : []
}

function itemInTier(item, tierId) {
  const need = tierRank(item?.min_tier || 'small')
  const have = tierRank(tierId)
  if (have < 0) return need <= 0
  return have >= need
}

function capStatus(cap, binding, catalog) {
  const tierId = currentTierId()
  const items = capItems(cap, catalog)
  const inThis = items.filter((it) => itemInTier(it, tierId))
  const familyEnts = new Set((catalog?.entitlements || []).map(String))
  const tier = (catalog?.tiers || []).find((t) => String(t.id).toLowerCase() === tierId)
  const tierEnts = new Set((tier?.entitlements || (tierId ? [] : catalog?.entitlements) || []).map(String))
  const entitlements = tierEnts.size ? tierEnts : familyEnts
  const bound = new Set(capsOf(binding))
  const inTier = entitlements.has(cap.id) || inThis.length > 0

  if (!tierId && !binding) {
    return { kind: 'catalog', label: '点开看模型', inThis: items.length, total: items.length }
  }
  if (!inTier || inThis.length === 0) {
    const hint = cap.excluded_hint?.[tierId] || cap.excluded_hint?.small
    return {
      kind: 'na',
      label: '本档不含',
      reason: hint || `官方 ${TIER_LABEL[tierId] || tierId || '当前档'} 不含此能力`,
      inThis: 0,
      total: items.length,
    }
  }
  if (binding?.status === 'active' && bound.has(cap.id)) {
    return { kind: 'on', label: '已接通', inThis: inThis.length, total: items.length }
  }
  return { kind: 'off', label: '未启用', inThis: inThis.length, total: items.length }
}

function verifyResultFor(capId) {
  return _verifyByCap[capId] || null
}

function pickEntitledMediaModel(capId, catalog) {
  const cap = (catalog?.capabilities || []).find((c) => String(c.id) === capId)
  if (!cap) return ''
  const tierId = currentTierId()
  let bestRank = -1
  let bestId = ''
  for (const it of capItems(cap, catalog)) {
    if (!itemInTier(it, tierId)) continue
    const r = tierRank(it?.min_tier || 'small')
    if (r > bestRank) {
      bestRank = r
      bestId = String(it.id || '')
    }
  }
  return bestId
}

function verifyPillHtml(capId, status) {
  if (_verifyBusy === 'all' || _verifyBusy === capId) {
    return `<span class="plans-verify-pill plans-verify-pill--busy">探测中…</span>`
  }
  const vr = verifyResultFor(capId)
  if (!vr) {
    if (status.kind === 'on') {
      return `<span class="plans-verify-pill plans-verify-pill--idle">未测</span>`
    }
    return `<span class="plans-verify-pill plans-verify-pill--idle">—</span>`
  }
  if (vr.skipped || vr.ok === null) {
    return `<span class="plans-verify-pill plans-verify-pill--skip" title="${esc(vr.message || '')}">跳过</span>`
  }
  if (vr.ok) {
    return `<span class="plans-verify-pill plans-verify-pill--ok" title="${esc(vr.message || '')}">可用</span>`
  }
  return `<span class="plans-verify-pill plans-verify-pill--bad" title="${esc(vr.message || '')}">不可用</span>`
}

function shortErr(msg, max = 72) {
  const s = String(msg || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function verifyCellHtml(capId, status, canVerify, verifyBtn) {
  const pill = verifyPillHtml(capId, status)
  const vr = verifyResultFor(capId)
  let hint = ''
  if (vr && !vr.skipped && vr.ok === false && vr.message) {
    hint = `<div class="plans-verify-cell-err" title="${esc(vr.message)}">${esc(shortErr(vr.message))}</div>`
  } else if (vr && vr.ok && vr.message) {
    hint = `<div class="plans-verify-cell-ok" title="${esc(vr.message)}">${esc(shortErr(vr.message, 48))}</div>`
  }
  return `<div class="plans-cap-probe-inner">${pill}${verifyBtn ? ` ${verifyBtn}` : ''}${hint}</div>`
}

function tierDotsHtml(item) {
  const need = tierRank(item?.min_tier || 'small')
  return TIER_ORDER.map((tid) => {
    const ok = tierRank(tid) >= need
    return `<span class="plans-tier-dot ${ok ? 'plans-tier-dot--on' : 'plans-tier-dot--off'}" title="${esc(TIER_LABEL[tid])}${ok ? ' 含' : ' 不含'}">${esc(TIER_LABEL[tid][0])}</span>`
  }).join('')
}

function checkResultHtml(capId) {
  const vr = verifyResultFor(capId)
  if (!vr) return ''
  const checks = Array.isArray(vr.checks) ? vr.checks : []
  const tone = vr.skipped || vr.ok === null ? 'skip' : vr.ok ? 'ok' : 'bad'
  const head = `<p class="plans-verify-summary plans-verify-summary--${tone}">
    <strong>${tone === 'ok' ? '探测通过' : tone === 'bad' ? '探测失败' : '已跳过'}：</strong>${esc(vr.message || '')}
  </p>`
  if (!checks.length) return head
  const rows = checks
    .map((c) => {
      const kind = c.ok ? 'ok' : 'bad'
      return `<li class="plans-verify-check plans-verify-check--${kind}">
        <span class="plans-verify-check-label">${esc(c.label || c.id)} · ${c.ok ? '通过' : '失败'}</span>
        <span class="plans-verify-check-msg">${esc(c.message || '')}</span>
      </li>`
    })
    .join('')
  return `${head}<ul class="plans-verify-checks">${rows}</ul>`
}

function capabilityDetailHtml(cap, catalog, status) {
  const items = capItems(cap, catalog)
  const docs = catalog?.docs_url || 'https://www.volcengine.com/docs/82379/2366394'
  const reason = status.kind === 'na' && status.reason
    ? `<p class="plans-cap-reason">${esc(status.reason)}</p>`
    : ''
  const bound = status.kind === 'on'
  const canProbeItem = bound && (cap.id === 'chat' || cap.id === 'embedding' || cap.id === 'image' || cap.id === 'video')
  const skillHint =
    cap.id === 'image'
      ? '<p class="plans-cap-skill-hint"><strong>配套技能：</strong><code>byted-ark-seedream-skill</code>（terminal 跑 <code>scripts/generate.js</code>）。绑套餐后 Key / 模型自动注入环境变量。</p>'
      : cap.id === 'video'
        ? '<p class="plans-cap-skill-hint"><strong>配套技能：</strong><code>media-production</code>（<code>image_generate.py</code> → <code>video_generate.py</code> → <code>task_wait.py</code>）。</p>'
        : ''
  const mat = _state.binding?.materialized || {}
  const imageModel = mat.image_model || pickEntitledMediaModel('image', catalog)
  const videoModel = mat.video_model || pickEntitledMediaModel('video', catalog)
  const activeModel =
    cap.id === 'image' && imageModel
      ? `<p class="plans-cap-active-model">当前接通模型：<code>${esc(imageModel)}</code></p>`
      : cap.id === 'video' && videoModel
        ? `<p class="plans-cap-active-model">当前接通模型：<code>${esc(videoModel)}</code></p>`
        : cap.id === 'video' && bound && !videoModel
          ? '<p class="plans-cap-active-model form-hint">本档不含生视频。</p>'
          : ''
  const rows = items.length
    ? items
        .map((it) => {
          const inThis = itemInTier(it, currentTierId())
          const probeCell = canProbeItem && inThis
            ? `<button type="button" class="btn btn-sm btn-secondary plans-item-probe" data-plans-action="verify-cap" data-cap-id="${esc(cap.id)}" data-model-id="${esc(it.id)}" ${_verifyBusy ? 'disabled' : ''}>测此项</button>`
            : '—'
          return `<tr class="${inThis ? '' : 'plans-item-row--locked'}">
            <td>${esc(it.label || it.id)}</td>
            <td><code>${esc(it.id)}</code></td>
            <td class="plans-item-tiers">${tierDotsHtml(it)}</td>
            <td>${esc(it.notes || (inThis ? '本档可用' : `需 ${TIER_LABEL[it.min_tier] || it.min_tier}+`))}</td>
            <td>${probeCell}</td>
          </tr>`
        })
        .join('')
    : `<tr><td colspan="5" class="form-hint">暂无明细，见官方文档。</td></tr>`

  return `<div class="plans-cap-detail-inner">
    <p class="plans-cap-summary">${esc(cap.summary || '')}</p>
    ${skillHint}
    ${activeModel}
    ${reason}
    ${checkResultHtml(cap.id)}
    <p class="form-hint" style="margin:0 0 8px">S/M/L/X 表示 Small / Medium / Large / Max 是否含该模型。来源：<a href="${esc(docs)}" target="_blank" rel="noopener noreferrer">套餐概览</a></p>
    <table class="plans-item-table">
      <thead>
        <tr><th>内容</th><th>模型 ID</th><th>档位</th><th>说明</th><th>探测</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`
}

function capabilityTableHtml(binding, catalog) {
  const caps = Array.isArray(catalog?.capabilities) && catalog.capabilities.length
    ? catalog.capabilities
    : [
        { id: 'chat', label: '对话模型' },
        { id: 'embedding', label: '向量' },
        { id: 'tts', label: '语音合成' },
        { id: 'asr', label: '语音识别' },
        { id: 'image', label: '生图' },
        { id: 'video', label: '生视频' },
        { id: 'web_search', label: '联网搜索' },
      ]
  const boundActive = !!(binding && binding.status === 'active')

  const body = caps
    .map((cap) => {
      const status = capStatus(cap, binding, catalog)
      const items = capItems(cap, catalog)
      const open = _expandedCap === cap.id
      const countText = items.length
        ? `${status.inThis}/${items.length}`
        : '—'
      const canVerify = boundActive && status.kind === 'on'
      const verifyBtn = canVerify
        ? `<button type="button" class="btn btn-sm btn-secondary" data-plans-action="verify-cap" data-cap-id="${esc(cap.id)}" ${_verifyBusy ? 'disabled' : ''}>验证</button>`
        : ''
      return `<tr class="plans-cap-row plans-cap-row--${status.kind}${open ? ' is-open' : ''}" data-cap-id="${esc(cap.id)}">
          <td>
            <button type="button" class="plans-cap-toggle" data-plans-action="toggle-cap" data-cap-id="${esc(cap.id)}" aria-expanded="${open ? 'true' : 'false'}">
              <span class="plans-cap-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span>
              ${esc(cap.label || cap.id)}
            </button>
          </td>
          <td>${esc(countText)}</td>
          <td><span class="plans-cap-pill plans-cap-pill--${status.kind}">${esc(status.label)}</span></td>
          <td class="plans-cap-probe">${verifyCellHtml(cap.id, status, canVerify, verifyBtn)}</td>
          <td class="plans-cap-gate">${esc(TIER_LABEL[cap.min_tier] || cap.min_tier || 'Small')} 起</td>
        </tr>
        <tr class="plans-cap-detail-row" data-cap-detail="${esc(cap.id)}" ${open ? '' : 'hidden'}>
          <td colspan="5">${open ? capabilityDetailHtml(cap, catalog, status) : ''}</td>
        </tr>`
    })
    .join('')

  return `<div class="plans-table-wrap">
    <table class="plans-cap-table">
      <thead>
        <tr>
          <th>能力</th>
          <th>本档模型</th>
          <th>状态</th>
          <th>可用性</th>
          <th>门禁</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </div>`
}

function verifyOverviewHtml() {
  const keys = Object.keys(_verifyByCap)
  if (!keys.length) return ''
  const catalog = _state.catalog
  const labelOf = (id) => {
    const row = (catalog?.capabilities || []).find((c) => String(c.id) === id)
    return String(row?.label || id)
  }
  const actionable = keys
    .map((k) => ({ id: k, ..._verifyByCap[k] }))
    .filter((r) => r && r.ok !== null && !r.skipped)
  const okN = actionable.filter((r) => r.ok).length
  const badN = actionable.length - okN
  const skipN = keys.length - actionable.length
  const tone = badN > 0 ? 'bad' : okN > 0 ? 'ok' : 'skip'

  const rows = keys
    .map((id) => {
      const vr = _verifyByCap[id]
      if (!vr) return ''
      const kind = vr.skipped || vr.ok === null ? 'skip' : vr.ok ? 'ok' : 'bad'
      const badge = kind === 'ok' ? '可用' : kind === 'bad' ? '不可用' : '跳过'
      const checks = Array.isArray(vr.checks) ? vr.checks : []
      const failed = checks.filter((c) => !c.ok)
      const detailBits = []
      if (vr.message) detailBits.push(esc(vr.message))
      for (const c of failed.slice(0, 3)) {
        detailBits.push(`${esc(c.label || c.id)}：${esc(c.message || '')}`)
      }
      return `<div class="plans-verify-result plans-verify-result--${kind}">
        <div class="plans-verify-result-head">
          <span class="plans-verify-pill plans-verify-pill--${kind === 'ok' ? 'ok' : kind === 'bad' ? 'bad' : 'skip'}">${badge}</span>
          <strong>${esc(labelOf(id))}</strong>
          <button type="button" class="btn btn-sm btn-secondary" data-plans-action="toggle-cap" data-cap-id="${esc(id)}">看明细</button>
        </div>
        <div class="plans-verify-result-body">${detailBits.join('<br>') || '—'}</div>
      </div>`
    })
    .join('')

  return `<div class="plans-verify-banner plans-verify-banner--${tone}" role="status">
    <div class="plans-verify-banner-title">
      探测结果：可用 <strong>${okN}</strong>
      · 不可用 <strong>${badN}</strong>
      ${skipN ? `· 跳过 ${skipN}` : ''}
      <span class="form-hint">失败原因见下方红色条目；也可点「看明细」展开对应能力。</span>
    </div>
    <div class="plans-verify-result-list">${rows}</div>
  </div>`
}

function unboundHtml(catalog) {
  const subscribeUrl = catalog?.subscribe_url || 'https://www.volcengine.com/product/ark'
  const invite = String(catalog?.invite_code || '').trim()
  const hint = Array.isArray(catalog?.models_hint) ? catalog.models_hint.join('、') : ''
  const inviteHint = invite
    ? ` · 邀请码 <code>${esc(invite)}</code>`
    : ''
  return `
    <section class="plans-hero plans-hero--empty">
      <div class="plans-hero-badge">推荐</div>
      <h3 class="plans-hero-title">接入方舟 Agent Plan</h3>
      <p class="plans-hero-desc">
        一次绑定接通对话 / 语音 / 生图视频 / 向量。聊天请用
        <code>${esc(PLAN_CHAT_BASE)}</code>，勿用按量 <code>/api/v3</code>。
        ${hint ? `<br>模型含 ${esc(hint)} 等。` : ''}
      </p>
      <p class="form-hint" style="margin:0 0 14px">
        <a href="${esc(subscribeUrl)}" target="_blank" rel="noopener noreferrer">去订阅</a>${inviteHint}
      </p>
      <div class="plans-hero-actions">
        <button type="button" class="btn btn-primary" data-plans-action="bind">已有 Key，立即绑定</button>
      </div>
    </section>
    <section class="plans-section">
      <h4 class="plans-section-title">套餐里有什么</h4>
      <p class="form-hint" style="margin:0 0 10px">点开每一行看具体模型；生视频按官方档位门禁，不是漏配。</p>
      ${capabilityTableHtml(null, catalog)}
    </section>`
}

function boundHtml(catalog, binding) {
  const tier = binding.tier_id || binding.tierId || '未标注'
  const keyHint = binding.api_key || binding.apiKey || '已配置'
  const drifted = !isPlanChatUrl(_state.connectionBaseUrl)
  const n = _state.chatModelCount
  const primary = _state.primaryModel || '—'
  const source = binding.materialized?.chat_models_source
  const matN = Number(binding.materialized?.chat_model_count || 0)
  const verifyingAll = _verifyBusy === 'all'

  return `
    <section class="plans-hero plans-hero--bound">
      <div class="plans-hero-badge plans-hero-badge--ok">已接通</div>
      <h3 class="plans-hero-title">${esc(catalog?.name || '火山方舟 Agent Plan')}</h3>
      <p class="plans-hero-desc">
        档位 <strong>${esc(tier)}</strong>
        · Key <code>${esc(keyHint)}</code>
        · 对话模型 <strong>${esc(String(n))}</strong> 个
        · 向量模型 <strong>${esc(String(Number(binding.materialized?.embedding_model_count ?? _state.embeddingModelCount ?? 0)))}</strong> 个
        ${source ? `（对话来源 ${esc(source)}${matN ? ` · 上次写入 ${matN}` : ''}）` : ''}
      </p>
      <p class="form-hint" style="margin:0 0 12px">
        主模型 <code>${esc(primary)}</code>
        · 连接地址 <code>${esc(_state.connectionBaseUrl || '未写入')}</code>
      </p>
      ${
        drifted
          ? `<div class="plans-warn" role="status">
              当前火山连接不是 Agent Plan 专属地址（应为 <code>${esc(PLAN_CHAT_BASE)}</code>）。
              <button type="button" class="btn btn-sm btn-primary" data-plans-action="rematerialize" style="margin-left:8px">恢复 Plan 地址并补齐模型</button>
            </div>`
          : ''
      }
      <div class="plans-hero-actions">
        <button type="button" class="btn btn-primary btn-sm" data-plans-action="verify-all" ${_verifyBusy ? 'disabled' : ''}>
          ${verifyingAll ? '验证中…' : '一键验证可用性'}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-plans-action="bind">更换 / 升级</button>
        <button type="button" class="btn btn-secondary btn-sm" data-plans-action="rematerialize">按套餐目录补齐</button>
        <button type="button" class="btn btn-secondary btn-sm" data-plans-action="goto-models">查看对话模型</button>
        <button type="button" class="btn btn-danger btn-sm" data-plans-action="unbind">解绑</button>
      </div>
    </section>

    <section class="plans-section">
      <h4 class="plans-section-title">能力明细</h4>
      <p class="form-hint" style="margin:0 0 10px">点开一行看模型与档位；可单独验证对话 / 识图 / 向量 / 语音 / 生图等。生视频「本档不含」来自官方概览，不是漏配。</p>
      ${verifyOverviewHtml()}
      ${capabilityTableHtml(binding, catalog)}
    </section>`
}

function render() {
  if (!_root) return
  const { catalog, binding } = _state
  const bound = !!(binding && binding.status === 'active')
  _root.innerHTML = `
    <div class="plans-page">
      ${bound ? boundHtml(catalog, binding) : unboundHtml(catalog)}
    </div>`
  bindActions()
}

function applyVerifyResults(results) {
  const list = Array.isArray(results) ? results : []
  for (const r of list) {
    const id = String(r?.capability || '').trim()
    if (!id) continue
    _verifyByCap[id] = {
      ok: r.ok === null || r.ok === undefined ? null : !!r.ok,
      message: String(r.message || ''),
      skipped: !!r.skipped || r.ok === null,
      checks: Array.isArray(r.checks) ? r.checks : [],
    }
  }
}

/**
 * @param {{ capabilities?: string[], modelIds?: string[], busyKey?: false | 'all' | string }} opts
 */
async function runVerify(opts = {}) {
  const id = _state.binding?.id
  if (!id || _verifyBusy) return
  const capabilities = Array.isArray(opts.capabilities) ? opts.capabilities : undefined
  const modelIds = Array.isArray(opts.modelIds) ? opts.modelIds : undefined
  const busyKey = opts.busyKey || (capabilities?.length === 1 ? capabilities[0] : 'all')
  _verifyBusy = busyKey
  render()
  try {
    const body = {}
    if (capabilities?.length) body.capabilities = capabilities
    if (modelIds?.length) body.model_ids = modelIds
    const res = await api.verifyPlanBinding(id, body)
    applyVerifyResults(res?.results)
    const actionable = (res?.results || []).filter((r) => r && r.ok !== null && !r.skipped)
    const okN = actionable.filter((r) => r.ok).length
    const badN = actionable.length - okN
    // Auto-expand first failure so the error is visible without hunting
    const firstBad = (res?.results || []).find((r) => r && r.ok === false)
    if (firstBad?.capability) {
      _expandedCap = String(firstBad.capability)
    }
    if (badN === 0 && okN > 0) {
      toast(`验证通过：${okN} 项可用`, 'success')
    } else if (okN > 0 && badN > 0) {
      const tip = firstBad?.message ? shortErr(firstBad.message, 80) : ''
      toast(`验证完成：${okN} 可用 / ${badN} 不可用${tip ? ` — ${tip}` : ''}`, 'info')
    } else if (badN > 0) {
      toast(`验证失败：${shortErr(firstBad?.message || '请查看下方探测结果', 100)}`, 'error')
    } else {
      toast('没有可探测的能力（本档不含或未启用）', 'info')
    }
  } catch (e) {
    toast(`验证失败：${e?.message || e}`, 'error')
  } finally {
    _verifyBusy = false
    render()
  }
}

async function loadState() {
  const [catRes, bindRes, modelsRes, connRes, primaryRes] = await Promise.all([
    api.listPlanCatalog().catch(() => ({ items: [] })),
    api.listPlanBindings(false).catch(() => ({ items: [] })),
    api.listModels().catch(() => ({ models: [] })),
    api.listModelConnections().catch(() => ({ connections: [] })),
    api.getPrimaryModel().catch(() => ({})),
  ])

  const items = Array.isArray(catRes?.items) ? catRes.items : []
  _state.catalog = items.find((x) => x.id === CATALOG_ID) || items[0] || null

  const bindings = Array.isArray(bindRes?.items) ? bindRes.items : []
  _state.binding =
    bindings.find((b) => b.catalog_id === CATALOG_ID && b.status === 'active') ||
    bindings.find((b) => b.vendor === 'volcengine' && b.plan_family === 'agent_plan' && b.status === 'active') ||
    null

  const models = Array.isArray(modelsRes?.models) ? modelsRes.models : []
  _state.chatModelCount = models.filter((m) => {
    const v = String(m?.vendor || '').toLowerCase()
    const name = String(m?.name || '').toLowerCase()
    const model = String(m?.model || '').toLowerCase()
    if (v.includes('embedding') || name.includes('embedding') || model.includes('embedding')) return false
    return v === 'volcengine' || isPlanChatUrl(m?.base_url)
  }).length

  const planEmbCount = models.filter((m) => {
    const v = String(m?.vendor || '').toLowerCase()
    const name = String(m?.name || '').toLowerCase()
    const model = String(m?.model || '').toLowerCase()
    const isEmb = v.includes('embedding') || name.includes('embedding') || model.includes('embedding')
    if (!isEmb) return false
    return v === 'volcengine' || isPlanChatUrl(m?.base_url)
  }).length
  _state.embeddingModelCount = planEmbCount

  // 已绑定全家桶但向量模型列表为空：自动补齐一次（兼容旧绑定）
  if (_state.binding?.id && capsOf(_state.binding).includes('embedding') && planEmbCount === 0) {
    try {
      const updated = await api.patchPlanBinding(_state.binding.id, { rematerialize: true })
      _state.binding = updated || _state.binding
      const embN = Number(updated?.materialized?.embedding_model_count || 0)
      if (embN > 0) {
        _state.embeddingModelCount = embN
        window.dispatchEvent(new CustomEvent('evopanel:models-changed'))
        toast(`已自动补齐 ${embN} 个套餐向量模型到「向量模型」页`, 'success')
      }
    } catch {
      /* 补齐失败不挡套餐页 */
    }
  }

  const conns = Array.isArray(connRes?.connections) ? connRes.connections : []
  const volc = conns.find((c) => c.key === 'volcengine')
  _state.connectionBaseUrl = String(volc?.base_url || '')
  _state.primaryModel = String(primaryRes?.primary_model || '')
}

function bindActions() {
  if (!_root) return
  _root.querySelector('[data-plans-action="bind"]')?.addEventListener('click', () => {
    openPlanBundleWizard({
      catalogId: CATALOG_ID,
      existingBinding: _state.binding,
      onDone: async (binding) => {
        const n = Number(binding?.materialized?.chat_model_count || 0)
        const emb = Number(binding?.materialized?.embedding_model_count || 0)
        const bits = []
        if (n > 0) bits.push(`${n} 个对话模型`)
        if (emb > 0) bits.push(`${emb} 个向量模型`)
        toast(bits.length ? `套餐已绑定：已配置 ${bits.join('、')}` : '套餐已绑定：对话 / 媒体 / 语音已接通', 'success')
        window.dispatchEvent(new CustomEvent('evopanel:models-changed'))
        _verifyByCap = {}
        await reload()
      },
    })
  })

  _root.querySelector('[data-plans-action="rematerialize"]')?.addEventListener('click', async () => {
    const id = _state.binding?.id
    if (!id) return
    try {
      const updated = await api.patchPlanBinding(id, { rematerialize: true })
      const n = Number(updated?.materialized?.chat_model_count || 0)
      const emb = Number(updated?.materialized?.embedding_model_count || 0)
      const bits = []
      if (n > 0) bits.push(`${n} 个对话模型`)
      if (emb > 0) bits.push(`${emb} 个向量模型`)
      toast(bits.length ? `已按套餐目录补齐：${bits.join('、')}` : '已重新接通套餐能力', 'success')
      window.dispatchEvent(new CustomEvent('evopanel:models-changed'))
      await reload()
    } catch (e) {
      toast(`补齐失败：${e?.message || e}`, 'error')
    }
  })

  _root.querySelector('[data-plans-action="unbind"]')?.addEventListener('click', async () => {
    const id = _state.binding?.id
    if (!id) return
    const yes = await showConfirm('确定解绑 Agent Plan？对话模型与媒体 Key 不会自动删除，可稍后手动清理。')
    if (!yes) return
    try {
      await api.deletePlanBinding(id)
      toast('已解绑套餐', 'info')
      _verifyByCap = {}
      await reload()
    } catch (e) {
      toast(`解绑失败：${e?.message || e}`, 'error')
    }
  })

  _root.querySelector('[data-plans-action="goto-models"]')?.addEventListener('click', () => {
    _onGotoChat()
  })

  _root.querySelector('[data-plans-action="verify-all"]')?.addEventListener('click', () => {
    runVerify({ busyKey: 'all' })
  })

  _root.querySelectorAll('[data-plans-action="verify-cap"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const capId = btn.getAttribute('data-cap-id') || ''
      if (!capId) return
      const modelId = btn.getAttribute('data-model-id') || ''
      if (modelId) {
        runVerify({
          capabilities: [capId],
          modelIds: [modelId],
          busyKey: capId,
        })
      } else {
        runVerify({ capabilities: [capId], busyKey: capId })
      }
    })
  })

  _root.querySelectorAll('[data-plans-action="toggle-cap"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      const id = btn.getAttribute('data-cap-id') || ''
      _expandedCap = _expandedCap === id ? '' : id
      render()
    })
  })
}

async function reload() {
  try {
    await loadState()
    render()
  } catch (e) {
    if (_root) {
      _root.innerHTML = `<div class="settings-subview-error" style="color:var(--error)">加载失败：${esc(e?.message || e)}</div>`
    }
  }
}

/**
 * @param {HTMLElement} container
 * @param {{ onGotoChat?: () => void }} [opts]
 */
export async function refreshPlans() {
  if (_root) await reload()
}

export async function mountPlansInto(container, opts = {}) {
  cleanup()
  _root = container
  _onGotoChat = typeof opts.onGotoChat === 'function' ? opts.onGotoChat : () => {}
  container.classList.add('settings-plans-root')
  container.innerHTML = `<div class="plans-page"><p class="form-hint">加载套餐状态…</p></div>`
  await reload()
}

export function cleanup() {
  _root = null
  _onGotoChat = () => {}
  _expandedCap = ''
  _verifyBusy = false
  _verifyByCap = {}
  _state = {
    catalog: null,
    binding: null,
    chatModelCount: 0,
    embeddingModelCount: 0,
    connectionBaseUrl: '',
    primaryModel: '',
  }
}

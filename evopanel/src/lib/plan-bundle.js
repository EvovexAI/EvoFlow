/**
 * Plan Bundle（厂商 Agent/Token Plan 全家桶）向导与 API 封装
 */
import { api } from '../lib/tauri-api.js'

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const CATALOG_COPY = {
  'volcengine.agent_plan': {
    boundTitle: '火山 Agent Plan 全家桶',
    unboundTitle: '一键接入方舟 Agent Plan',
    unboundDesc:
      '最新 DeepSeek-V4.1-Flash、Kimi-K3.1-Pro、Doubao-Seed-2.1、GLM-5.3 等；全模态 + Harness。粘贴 <code>ark-</code> Key 接通对话 / 生图视频 / 语音 ——',
    wizardTitle: '接入方舟 Agent Plan',
    wizardReplaceTitle: '更换方舟 Agent Plan Key',
    chatHintPrefix: '绑定后自动写入套餐对话模型。聊天地址使用 Agent Plan 专属',
    defaultSubscribe: 'https://www.volcengine.com/product/ark',
    defaultModels: 'DeepSeek-V4.1-Flash、Kimi-K3.1-Pro、Doubao-Seed-2.1、GLM-5.3',
  },
  'aliyun.token_plan': {
    boundTitle: '百炼 Token Plan 全家桶',
    unboundTitle: '一键接入百炼 Token Plan',
    unboundDesc:
      '千问 / DeepSeek / GLM / 万相 / HappyHorse；Credits 统一计量。粘贴 <code>sk-sp-</code> Key 接通对话 / 生图视频 / 语音。Essential 约 <strong>¥79</strong>/月 ——',
    wizardTitle: '接入百炼 Token Plan',
    wizardReplaceTitle: '更换百炼 Token Plan Key',
    chatHintPrefix: '绑定后自动写入套餐对话模型。聊天地址使用 Token Plan 专属',
    defaultSubscribe: 'https://bailian.console.aliyun.com/',
    defaultModels: 'auto、qwen3.8-max、qwen3.8-flash、deepseek-v4.1-flash、glm-5.3',
  },
}

function catalogCopy(catalogId) {
  return CATALOG_COPY[catalogId] || CATALOG_COPY['volcengine.agent_plan']
}

/**
 * 醒目的全家桶入口卡片（火山 / 百炼等）
 * @param {{ binding?: object | null, catalogId?: string }} [opts]
 */
export function planBundlePromoHtml(opts = {}) {
  const catalogId = opts.catalogId || 'volcengine.agent_plan'
  const copy = catalogCopy(catalogId)
  const binding = opts.binding || null
  const bound = !!(binding && binding.status === 'active')
  const caps = Array.isArray(binding?.bound_capabilities)
    ? binding.bound_capabilities
    : Array.isArray(binding?.boundCapabilities)
      ? binding.boundCapabilities
      : []
  const capsText = caps.length ? caps.join(' · ') : '对话 · 生图 · 语音'
  const subscribeUrl = opts.subscribeUrl || copy.defaultSubscribe

  if (bound) {
    return `
      <section class="models-plan-promo models-plan-promo--bound" aria-label="Plan 全家桶已绑定">
        <div class="models-plan-promo-badge">已接通</div>
        <div class="models-plan-promo-body">
          <h4 class="models-plan-promo-title">${esc(copy.boundTitle)}</h4>
          <p class="models-plan-promo-desc">
            能力 ${esc(capsText)}
            · 完整管理请到设置「套餐」
          </p>
        </div>
        <div class="models-plan-promo-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="open-plans-settings" data-catalog="${esc(catalogId)}">在套餐中管理</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="open-plan-bundle" data-catalog="${esc(catalogId)}">更换 Key</button>
        </div>
      </section>`
  }

  return `
    <section class="models-plan-promo" aria-label="接入 Plan 全家桶">
      <div class="models-plan-promo-badge">推荐</div>
      <div class="models-plan-promo-body">
        <h4 class="models-plan-promo-title">${esc(copy.unboundTitle)}</h4>
        <p class="models-plan-promo-desc">
          ${copy.unboundDesc}
          <a href="${esc(subscribeUrl)}" target="_blank" rel="noopener noreferrer">立即订阅</a>
        </p>
      </div>
      <div class="models-plan-promo-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-action="open-plans-settings" data-catalog="${esc(catalogId)}">去套餐页</button>
        <a class="btn btn-secondary btn-sm" href="${esc(subscribeUrl)}" target="_blank" rel="noopener noreferrer">去订阅</a>
        <button type="button" class="btn btn-primary" data-action="open-plan-bundle" data-catalog="${esc(catalogId)}">已有 Key，立即接入</button>
      </div>
    </section>`
}

/**
 * @param {{ catalogId?: string, onDone?: (binding: any) => void, existingBinding?: object | null }} [opts]
 */
export async function openPlanBundleWizard(opts = {}) {
  const catalogId = opts.catalogId || 'volcengine.agent_plan'
  const copy = catalogCopy(catalogId)
  let catalog
  let existingBinding = opts.existingBinding || null
  try {
    const res = await api.listPlanCatalog()
    const items = res?.items || []
    catalog = items.find((x) => x.id === catalogId) || items[0]
  } catch (e) {
    window.alert(`加载套餐目录失败：${e?.message || e}`)
    return
  }
  if (!catalog) {
    window.alert('暂无可用套餐目录')
    return
  }
  if (!existingBinding) {
    try {
      const bindRes = await api.listPlanBindings(false)
      const items = Array.isArray(bindRes?.items) ? bindRes.items : []
      existingBinding =
        items.find((b) => b.catalog_id === catalogId && b.status === 'active') ||
        items.find(
          (b) =>
            b.vendor === catalog.vendor &&
            b.plan_family === catalog.plan_family &&
            b.status === 'active',
        ) ||
        null
    } catch {
      existingBinding = null
    }
  }

  const tiers = Array.isArray(catalog.tiers) ? catalog.tiers : []
  // 不再让用户选手动档位：按目录最高档 materialize 全量模型；真实额度/视频门禁以厂商控制台为准。
  const tierId =
    existingBinding?.tier_id ||
    existingBinding?.tierId ||
    tiers[tiers.length - 1]?.id ||
    tiers[0]?.id ||
    ''
  const subscribeUrl = catalog.subscribe_url || copy.defaultSubscribe
  const inviteCode = String(catalog.invite_code || '').trim()
  const subscribe = inviteCode
    ? `<a href="${esc(subscribeUrl)}" target="_blank" rel="noopener noreferrer">立即订阅</a>（邀请码 <code>${esc(inviteCode)}</code>）`
    : `<a href="${esc(subscribeUrl)}" target="_blank" rel="noopener noreferrer">立即订阅</a>`
  const modelsHint = Array.isArray(catalog.models_hint) && catalog.models_hint.length
    ? catalog.models_hint.join('、')
    : copy.defaultModels
  const promo = catalog.promo_hint
    ? `<p style="margin:0 0 12px;font-size:.85rem;line-height:1.45;color:var(--accent,#2563eb)">${esc(catalog.promo_hint)}</p>`
    : ''
  const chatBase =
    catalog?.endpoints?.chat?.base_url ||
    (catalogId === 'aliyun.token_plan'
      ? 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
      : 'https://ark.cn-beijing.volces.com/api/plan/v3')
  const showLocalEmb = catalogId !== 'aliyun.token_plan'
  const ents = catalog.entitlements || tiers[tiers.length - 1]?.entitlements || []
  const hideTier = !!(catalog?.ui?.hide_tiers || catalog?.ui?.hideTiers)
  const capsHint = ents.length
    ? `<p style="margin:0 0 12px;opacity:.75;font-size:.82rem;line-height:1.45">将接通：${esc(ents.join('、'))}。${
        hideTier ? 'Credits 额度以控制台为准，无需选手动档位。' : '额度以控制台订阅为准，此处无需再选档位。'
      }</p>`
    : ''

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay plan-bundle-overlay'
  // Must sit above settings modal (.react-chat-modal-overlay = 1000001)
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000010;display:flex;align-items:center;justify-content:center;padding:16px'
  overlay.innerHTML = `
    <div class="modal-card plan-bundle-dialog" role="dialog" aria-labelledby="plan-bundle-title"
      style="background:var(--bg-elevated,#fff);color:var(--text,#111);border-radius:12px;max-width:520px;width:100%;padding:20px 22px;box-shadow:0 12px 40px rgba(0,0,0,.2)">
      <h3 id="plan-bundle-title" style="margin:0 0 8px;font-size:1.1rem">${existingBinding ? esc(copy.wizardReplaceTitle) : esc(copy.wizardTitle)}</h3>
      <p style="margin:0 0 8px;opacity:.85;font-size:.9rem;line-height:1.5">
        ${esc(catalog.name)}：${esc(catalog.description || '')}
        最新支持 ${esc(modelsHint)} 等。
        ${subscribe}
      </p>
      <p style="margin:0 0 12px;opacity:.75;font-size:.82rem;line-height:1.45">
        ${esc(copy.chatHintPrefix)}
        <code>${esc(chatBase)}</code>。
      </p>
      ${promo}
      ${capsHint}
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">订阅 API Key</label>
        <input id="plan-bundle-key" class="form-input" type="password" autocomplete="off"
          placeholder="${esc(catalog.key_rules?.prefix || 'ark-')}…" style="width:100%">
        <div class="form-hint" style="margin-top:6px;font-size:.8rem;opacity:.75">${esc(
          catalog.key_rules?.description || '',
        )}</div>
      </div>
      ${
        showLocalEmb
          ? `<div class="form-group" style="margin-bottom:16px">
        <label style="display:flex;gap:8px;align-items:flex-start;font-size:.85rem;cursor:pointer">
          <input id="plan-bundle-local-emb" type="checkbox" checked style="margin-top:3px">
          <span>向量优先用本地模型（节省套餐积分）</span>
        </label>
      </div>`
          : '<div style="margin-bottom:16px"></div>'
      }
      <div id="plan-bundle-error" style="display:none;color:#c0392b;font-size:.85rem;margin-bottom:10px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn btn-secondary" data-plan-action="cancel">取消</button>
        <button type="button" class="btn btn-primary" data-plan-action="submit">${existingBinding ? '保存并同步模型' : '一键绑定'}</button>
      </div>
    </div>
  `

  const errEl = overlay.querySelector('#plan-bundle-error')

  const close = () => overlay.remove()
  overlay.querySelector('[data-plan-action="cancel"]').onclick = close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  overlay.querySelector('[data-plan-action="submit"]').onclick = async () => {
    const key = overlay.querySelector('#plan-bundle-key').value.trim()
    const preferLocal = showLocalEmb
      ? !!overlay.querySelector('#plan-bundle-local-emb')?.checked
      : false
    errEl.style.display = 'none'
    if (!key) {
      errEl.textContent = '请填写订阅 API Key'
      errEl.style.display = 'block'
      return
    }
    const btn = overlay.querySelector('[data-plan-action="submit"]')
    btn.disabled = true
    btn.textContent = existingBinding ? '同步中…' : '绑定中…'
    try {
      const binding = existingBinding?.id
        ? await api.patchPlanBinding(existingBinding.id, {
            api_key: key,
            tier_id: tierId || undefined,
            rematerialize: true,
            overrides: { prefer_local_embedding: preferLocal },
          })
        : await api.createPlanBinding({
            catalog_id: catalog.id,
            api_key: key,
            tier_id: tierId || undefined,
            overrides: { prefer_local_embedding: preferLocal },
          })
      close()
      if (typeof opts.onDone === 'function') opts.onDone(binding)
      else {
        const n = Number(binding?.materialized?.chat_model_count || 0)
        const emb = Number(binding?.materialized?.embedding_model_count || 0)
        const bits = []
        if (n > 0) bits.push(`${n} 个对话模型`)
        if (emb > 0) bits.push(`${emb} 个向量模型`)
        window.alert(
          bits.length
            ? `Plan 全家桶已绑定：已配置 ${bits.join('、')}`
            : 'Plan 全家桶已绑定：对话 / 媒体 / 语音已接通',
        )
      }
    } catch (e) {
      const detail = e?.detail || e?.message || String(e)
      const msg =
        typeof detail === 'object' && detail?.message
          ? detail.message
          : typeof detail === 'string'
            ? detail
            : JSON.stringify(detail)
      errEl.textContent = msg
      errEl.style.display = 'block'
      btn.disabled = false
      btn.textContent = existingBinding ? '保存并同步模型' : '一键绑定'
    }
  }

  document.body.appendChild(overlay)
  overlay.querySelector('#plan-bundle-key')?.focus()
}

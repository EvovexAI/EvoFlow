/**
 * 模型配置页面
 * 服务商管理 + 模型增删改查 + 主模型选择
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showModal, showConfirm } from '../components/modal.js'
import { icon, statusIcon } from '../lib/icons.js'
import { PROVIDER_PRESETS, VENDOR_PRESETS, MODEL_PRESETS, PROVIDER_URL_MODE_KEYS } from '../lib/model-presets.js'
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  buildContextWindowFieldHtml,
  bindContextWindowPresets,
} from '../lib/model-context-field.js'
import { isEmbeddingModel } from '../lib/model-classification.js'
import { openPlanBundleWizard, planBundlePromoHtml } from '../lib/plan-bundle.js'
import { applyModalTauriDragChrome } from '../lib/modal-chrome.js'

/** 从网关模型行读取上下文窗口（仅 model 表 context_length） */
function resolvePanelContextWindow(m) {
  const cl = Number(m?.context_length)
  if (Number.isFinite(cl) && cl > 0) return cl
  return DEFAULT_MODEL_CONTEXT_WINDOW
}

function modelSupportsVision(m) {
  if (!m || typeof m === 'string') return false
  const input = m.input
  return Array.isArray(input) ? input.includes('image') : false
}

function setModelVision(m, enabled) {
  if (!m || typeof m === 'string') return
  m.input = enabled ? ['text', 'image'] : ['text']
}
import {
  attachMediaToModelsPage,
  cleanup as cleanupMediaSettings,
  clearMediaSelection,
} from './settings/media.js'

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const PLAN_TIER_SHORT = { small: 'S', medium: 'M', large: 'L', max: 'X' }

function isPlanChatUrl(url) {
  return String(url || '')
    .replace(/\/+$/, '')
    .toLowerCase()
    .includes('/api/plan/v3')
}

function planModelBadgeHtml(m) {
  const planType = m?.planType || m?.plan_type || ''
  const planCfg = m?.planConfig || m?.plan_config || {}
  const isPlan =
    planType === 'volcengine_agent' ||
    isPlanChatUrl(m?.baseUrl) ||
    isPlanChatUrl(m?.base_url)
  if (!isPlan) return ''
  const tier = planCfg?.tier_id || ''
  const minTier = planCfg?.min_tier || ''
  const short = PLAN_TIER_SHORT[String(tier).toLowerCase()] || tier
  const need = minTier ? ` · 模型需 ${PLAN_TIER_SHORT[String(minTier).toLowerCase()] || minTier}+` : ''
  const title = `火山 Agent Plan${short ? ` · 绑定档 ${short}` : ''}${need}`
  return `<span class="tag tag--plan" title="${escAttr(title)}">Plan${short ? ` ${escHtml(short)}` : ''}</span>`
}

/** 创建并挂载 models 弹窗 overlay，避免遗漏 overlay 节点。 */
function mountModelsModalOverlay(innerHtml) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = innerHtml
  document.body.appendChild(overlay)
  applyModalTauriDragChrome(overlay)
  return overlay
}

/** 网关 models[].name：唯一配置名，可与 provider model id 不同 */
function modelConfigName(m) {
  if (typeof m === 'string') return m.trim()
  return String(m?.configName || m?.name || m?.id || '').trim()
}

/** 实际调用服务商 API 时使用的 model id */
function modelProviderId(m) {
  if (typeof m === 'string') return m.trim()
  return String(m?.id || '').trim()
}

function isValidConfigName(name) {
  const s = String(name || '').trim()
  return s.length > 0 && !s.includes('/')
}

/** 生成唯一 config name：优先显示名，冲突时追加后缀 */
function deriveConfigName(displayName, providerKey, modelId, usedNames) {
  const used = usedNames instanceof Set ? usedNames : new Set(usedNames || [])
  const disp = String(displayName || '').trim()
  const candidates = []
  if (disp && isValidConfigName(disp)) candidates.push(disp)
  const fallback = `${providerKey}-${String(modelId || '').trim()}`.replace(/\//g, '-')
  if (isValidConfigName(fallback)) candidates.push(fallback)
  const base = candidates[0] || `model-${Date.now()}`
  let name = base
  let i = 2
  while (used.has(name)) {
    name = `${base}-${i++}`
  }
  used.add(name)
  return name
}

/** 添加/编辑模型弹窗内联提示（避免 toast 被 modal-overlay 遮挡） */
function showModelsEditModalError(overlay, message, type = 'warning') {
  if (!overlay) {
    toast(message, type)
    return
  }
  let banner = overlay.querySelector('[data-models-edit-error]')
  if (!banner) {
    banner = document.createElement('div')
    banner.className = 'models-edit-modal-error'
    banner.setAttribute('data-models-edit-error', '')
    banner.setAttribute('role', 'alert')
    const header = overlay.querySelector('.models-edit-modal-header')
    if (header) header.insertAdjacentElement('afterend', banner)
    else overlay.querySelector('.models-edit-modal')?.prepend(banner)
  }
  banner.textContent = message
  banner.hidden = false
  banner.className = `models-edit-modal-error models-edit-modal-error--${type}`
}

function clearModelsEditModalError(overlay) {
  const banner = overlay?.querySelector('[data-models-edit-error]')
  if (banner) banner.hidden = true
}

function resolveModelDisplayName(name, modelId) {
  const id = String(modelId || '').trim()
  return String(name || '').trim() || id
}

/** 编辑弹窗：仅当用户自定义过名称时回填，与 ID 相同时留空表示使用默认 */
function modelNameInputValue(name, modelId) {
  const id = String(modelId || '').trim()
  const custom = String(name || '').trim()
  return custom && custom !== id ? custom : ''
}

function collectUsedConfigNames(config) {
  const used = new Set()
  for (const pv of Object.values(config?.models?.providers || {})) {
    for (const m of pv.models || []) {
      const cn = modelConfigName(m)
      if (cn) used.add(cn)
    }
  }
  return used
}

/** 根据主模型 config name 找到所属服务商（兼容旧版 provider/modelId） */
function primaryProviderKeyFromPrimary(config, primaryRef) {
  const ref = String(primaryRef || '').trim()
  if (!ref) return null
  const providers = config?.models?.providers || {}
  for (const [pk, pv] of Object.entries(providers)) {
    for (const m of pv.models || []) {
      if (modelConfigName(m) === ref) return pk
    }
  }
  const i = ref.indexOf('/')
  if (i > 0) return ref.slice(0, i)
  return null
}

function resolveModelDisplayLabel(config, configName) {
  for (const pv of Object.values(config?.models?.providers || {})) {
    for (const m of pv.models || []) {
      if (modelConfigName(m) !== configName) continue
      const display = resolveModelDisplayName(typeof m === 'object' ? m.name : m, modelProviderId(m))
      const pid = modelProviderId(m)
      if (display && pid && display !== pid) return `${display} · ${pid}`
      return display || configName
    }
  }
  return configName
}

/** 旧版 primary 为 provider/modelId 时，解析为 config name */
function resolvePrimaryConfigName(config, primaryRef) {
  const ref = String(primaryRef || '').trim()
  if (!ref) return ''
  const providers = config?.models?.providers || {}
  for (const pv of Object.values(providers)) {
    for (const m of pv.models || []) {
      if (modelConfigName(m) === ref) return ref
    }
  }
  if (!ref.includes('/')) return ref
  const slash = ref.indexOf('/')
  const pk = ref.slice(0, slash)
  const legacyId = ref.slice(slash + 1)
  const prov = providers[pk]
  if (!prov) return ref
  const found = (prov.models || []).find((m) => modelProviderId(m) === legacyId)
  return found ? modelConfigName(found) : ref
}

function normalizeBaseUrlCompare(u) {
  return String(u || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase()
}

function isMaskedGatewayApiKey(key) {
  const s = String(key ?? '').trim()
  return !!s && /^\*+/.test(s)
}

/** Gateway list/get 返回脱敏密钥时不在 Panel 状态里保留假值，避免 sync 覆盖真实 key */
function apiKeyFromGatewayRow(raw) {
  if (isMaskedGatewayApiKey(raw)) return ''
  return String(raw ?? '').trim()
}

/** 连接是否具备可用密钥（本地明文或 DB 已保存但脱敏不可见） */
function providerHasApiKey(provider) {
  if (!provider) return false
  if (provider.apiKeyConfigured) return true
  return !!(provider.apiKey && String(provider.apiKey).trim())
}

/** Ollama / 本机无鉴权服务：可不填 API Key */
function providerApiKeyOptional(providerKey, provider) {
  const root = vendorRootForProviderKey(providerKey)
  const preset = PROVIDER_PRESETS.find((p) => p.key === root)
  if (preset?.apiKeyOptional) return true
  const base = String(provider?.baseUrl || '').toLowerCase()
  if (!base) return root === 'ollama'
  return (
    root === 'ollama' ||
    base.includes('11434') ||
    /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base)
  )
}

/** 连接选择器 / 弹窗中的密钥摘要文案 */
function providerKeySummaryText(provider, providerKey = '') {
  if (providerApiKeyOptional(providerKey, provider) && !providerHasApiKey(provider)) {
    return '无需密钥'
  }
  const local = String(provider?.apiKey ?? '').trim()
  if (local) {
    return local.length >= 4 ? `***${local.slice(-4)}` : '已配置'
  }
  if (provider?.apiKeyConfigured) return '已配置（服务端）'
  return '无密钥'
}

function apiKeyFieldGroupHtml({
  id,
  value = '',
  hint = '',
  optional = false,
  placeholder = 'sk-...',
  fieldAttr = 'data-name="apiKey"',
  label = '密钥 (API Key)',
} = {}) {
  if (optional) {
    return `
      <div class="form-group models-apikey-optional">
        <div class="form-hint" style="margin:0">本机服务默认无需 API Key，已跳过密钥填写。</div>
      </div>`
  }
  const inputId = id ? ` id="${escAttr(id)}"` : ''
  const hintHtml = hint ? `<div class="form-hint">${escHtml(hint)}</div>` : ''
  return `
    <div class="form-group">
      <label class="form-label"${id ? ` for="${escAttr(id)}"` : ''}>${escHtml(label)}</label>
      <input${inputId} class="form-input" ${fieldAttr} type="password" autocomplete="off" value="${escAttr(value)}" placeholder="${escAttr(placeholder)}">
      ${hintHtml}
    </div>`
}

/** 编辑连接时写入 Panel 状态；留空且 apiKeyConfigured 表示不修改 DB 中已存密钥 */
function applyProviderApiKeyEdit(provider, apiKeyInput) {
  const input = String(apiKeyInput ?? '').trim()
  if (input) {
    provider.apiKey = input
    provider.apiKeyConfigured = true
    return
  }
  provider.apiKey = ''
  if (!provider.apiKeyConfigured) {
    provider.apiKeyConfigured = false
  }
}

function buildProviderEntry({ baseUrl, apiKey, api, models = [], apiKeyConfigured = false, displayName } = {}) {
  const key = String(apiKey ?? '').trim()
  const entry = {
    baseUrl: baseUrl || '',
    apiKey: key,
    apiKeyConfigured: apiKeyConfigured || !!key,
    api: api || 'openai-completions',
    models,
  }
  if (displayName) entry.displayName = displayName
  return entry
}

function gatewayUseToApiType(use) {
  const u = String(use || '').toLowerCase()
  if (u.includes('langchain_anthropic')) return 'anthropic-messages'
  if (u.includes('langchain_google_genai')) return 'google-generative-ai'
  return 'openai-completions'
}

/** DB 行级连接指纹：同 vendor 不同 base_url 须分桶（兼容历史脏数据） */
function connectionFingerprint(vendor, baseUrl, apiType) {
  return `${String(vendor || 'default').trim().toLowerCase()}|${normalizeBaseUrlCompare(baseUrl)}|${String(apiType || 'openai-completions').toLowerCase()}`
}

/** 按 endpoint 匹配连接（忽略 vendor 键重命名，如 aliyun → aliyun-2） */
function connectionScopeFingerprint(baseUrl, apiType) {
  return `${normalizeBaseUrlCompare(baseUrl)}|${String(apiType || 'openai-completions').toLowerCase()}`
}

function gatewayModelScopeFingerprint(row) {
  return connectionScopeFingerprint(row?.base_url, gatewayUseToApiType(row?.use))
}

function vendorRootForProviderKey(vendor) {
  const v = String(vendor || 'default').trim()
  const m = v.match(/^(.+)-(\d+)$/)
  if (m && Number(m[2]) >= 2) return m[1]
  return v
}

/**
 * evoflow_models.vendor 即 Panel 连接键（aliyun / aliyun-2 …）。
 * 正常情况每行 vendor 与连接 1:1，直接用作 providerKey；
 * 仅当多条记录共用同一 vendor 但 base_url 不同（历史脏数据）时才追加 -2/-3 后缀。
 * @param {Map<string, { vendor: string, baseUrl: string, apiType: string }>} bucketsByFingerprint
 */
function resolveProviderKeysFromDbBuckets(bucketsByFingerprint) {
  const result = new Map()
  const usedKeys = new Set()
  const byVendor = new Map()

  for (const [fp, bucket] of bucketsByFingerprint) {
    const v = String(bucket.vendor || 'default').trim() || 'default'
    if (!byVendor.has(v)) byVendor.set(v, [])
    byVendor.get(v).push({ fp, bucket })
  }

  for (const [vendor, entries] of byVendor) {
    if (entries.length === 1) {
      result.set(entries[0].fp, vendor)
      usedKeys.add(vendor)
      continue
    }

    entries.sort((a, b) => a.fp.localeCompare(b.fp))
    const root = vendorRootForProviderKey(vendor)
    let nextSuffix = 2
    for (const { fp } of entries) {
      let key
      if (!usedKeys.has(root) && nextSuffix === 2) {
        key = root
        nextSuffix = 3
      } else {
        while (usedKeys.has(`${root}-${nextSuffix}`)) nextSuffix++
        key = `${root}-${nextSuffix}`
        nextSuffix++
      }
      result.set(fp, key)
      usedKeys.add(key)
    }
  }

  return result
}

function panelModelFromGatewayRow(m) {
  const fullName = String(m?.name || '').trim()
  if (!fullName) return null

  const parts = fullName.split('/')
  const legacyProviderFromName = parts.length >= 2 ? parts[0].trim() : null
  const modelId = String(m?.model || (parts.length >= 2 ? parts.slice(1).join('/') : fullName)).trim()
  if (!modelId) return null

  // evoflow_models.vendor = Panel 连接键；name 前缀仅作旧数据兜底
  const vendor = String(m?.vendor || legacyProviderFromName || 'default').trim() || 'default'
  const displayName = resolveModelDisplayName(m?.display_name, modelId)
  // 配置名不可含 /（REST 路径与 Panel 主键）；旧数据带斜杠时迁移为安全名
  let configName = fullName
  if (!isValidConfigName(configName)) {
    configName = deriveConfigName(displayName, vendor, modelId, new Set())
  }
  if (!configName) return null
  const baseUrl = String(m?.base_url || '').trim()
  const apiType = gatewayUseToApiType(m?.use)
  const customName = String(m?.display_name || '').trim()
  const storedName = customName && customName !== modelId ? customName : ''

  return {
    configName,
    modelId,
    vendor,
    baseUrl,
    apiType,
    apiKey: apiKeyFromGatewayRow(m?.api_key),
    apiKeyConfiguredOnServer: isMaskedGatewayApiKey(m?.api_key),
    entry: {
      configName,
      id: modelId,
      name: storedName,
      description: m?.description || null,
      contextWindow: resolvePanelContextWindow(m),
      inputContextLength: Number.isFinite(Number(m?.input_context_length)) ? Number(m.input_context_length) : null,
      outputContextLength: Number.isFinite(Number(m?.output_context_length)) ? Number(m.output_context_length) : null,
      reasoning: Boolean(m?.supports_thinking),
      input: m?.supports_vision ? ['text', 'image'] : ['text'],
      enableWebSearch: Boolean(m?.enable_web_search),
      webSearchOptions: m?.web_search_options || null,
      thinking: m?.thinking || null,
      temperature: m?.temperature != null && Number.isFinite(Number(m.temperature)) ? Number(m.temperature) : null,
      requestTimeout: Number.isFinite(Number(m?.request_timeout)) ? Number(m.request_timeout) : null,
      maxRetries: Number.isFinite(Number(m?.max_retries)) ? Number(m.max_retries) : null,
      maxTokens: Number.isFinite(Number(m?.max_tokens)) ? Number(m.max_tokens) : null,
      availabilityStatus: String(m?.availability_status || 'available').trim().toLowerCase() === 'unavailable'
        ? 'unavailable'
        : 'available',
      unavailableReason: String(m?.unavailable_reason || '').trim() || '',
      unavailableCode: String(m?.unavailable_code || '').trim() || '',
      unavailableAt: String(m?.unavailable_at || '').trim() || '',
      planType: String(m?.plan_type || '').trim() || null,
      planConfig:
        m?.plan_config && typeof m.plan_config === 'object' ? { ...m.plan_config } : null,
      baseUrl,
    },
  }
}

/** 从 Gateway（SQLite evoflow_models）扁平列表重建 Panel providers */
function providersFromGatewayModels(models, primaryModelRaw = '') {
  const buckets = new Map()
  let primaryFull = ''

  for (const m of models) {
    const parsed = panelModelFromGatewayRow(m)
    if (!parsed) continue

    const fp = connectionFingerprint(parsed.vendor, parsed.baseUrl, parsed.apiType)
    if (!buckets.has(fp)) {
      buckets.set(fp, {
        vendor: parsed.vendor,
        baseUrl: parsed.baseUrl,
        apiType: parsed.apiType,
        apiKey: '',
        apiKeyConfigured: false,
        models: [],
      })
    }

    const bucket = buckets.get(fp)
    bucket.models.push(parsed.entry)
    if (parsed.apiKeyConfiguredOnServer) bucket.apiKeyConfigured = true
    if (!bucket.apiKey && parsed.apiKey) bucket.apiKey = parsed.apiKey

    if (String(m?.name) === primaryModelRaw) {
      primaryFull = parsed.configName
    }
  }

  const keyByFingerprint = resolveProviderKeysFromDbBuckets(buckets)
  const providers = {}

  for (const [fp, bucket] of buckets) {
    const providerKey = keyByFingerprint.get(fp) || bucket.vendor || 'default'
    providers[providerKey] = {
      baseUrl: bucket.baseUrl,
      apiKey: bucket.apiKey,
      apiKeyConfigured: !!bucket.apiKeyConfigured,
      api: bucket.apiType,
      models: bucket.models,
    }
  }

  if (!primaryFull && primaryModelRaw) {
    primaryFull = String(primaryModelRaw)
  }
  primaryFull = resolvePrimaryConfigName({ models: { providers } }, primaryFull)

  return { providers, primaryFull }
}

/** 将独立连接表中的配置合并进 providers（补全「仅有连接、尚无模型」的项） */
function mergeProvidersWithStoredConnections(providersFromModels, connectionsList) {
  const providers = { ...(providersFromModels || {}) }
  const coveredScopes = new Set()
  for (const p of Object.values(providers)) {
    coveredScopes.add(connectionScopeFingerprint(p?.baseUrl, p?.api))
  }

  for (const conn of connectionsList || []) {
    const key = String(conn?.key || '').trim()
    if (!key) continue

    const apiKey = apiKeyFromGatewayRow(conn.api_key)
    const apiKeyConfigured = isMaskedGatewayApiKey(conn.api_key) || !!apiKey
    const displayName = String(conn.display_name || '').trim()
    const baseUrl = String(conn.base_url || '').trim()
    const apiType = conn.api_type || 'openai-completions'
    const scopeFp = connectionScopeFingerprint(baseUrl, apiType)

    if (providers[key]) {
      const p = providers[key]
      if (baseUrl) p.baseUrl = baseUrl
      if (apiType) p.api = apiType
      if (apiKey) {
        p.apiKey = apiKey
        p.apiKeyConfigured = true
      } else if (apiKeyConfigured) {
        p.apiKey = ''
        p.apiKeyConfigured = true
      }
      if (displayName) p.displayName = displayName
      coveredScopes.add(scopeFp)
      continue
    }

    // 跳过已被其它连接键接管的过期链接（历史 vendor 重命名遗留）
    if (coveredScopes.has(scopeFp)) continue

    providers[key] = buildProviderEntry({
      baseUrl,
      apiKey,
      api: apiType,
      apiKeyConfigured,
      displayName: displayName || undefined,
      models: [],
    })
    coveredScopes.add(scopeFp)
  }
  return providers
}

function connectionPayloadFromProvider(key, provider) {
  const payload = {
    key,
    base_url: provider.baseUrl || '',
    api_type: provider.api || 'openai-completions',
  }
  const displayName = String(provider.displayName || '').trim()
  if (displayName) payload.display_name = displayName
  const keyPlain = String(provider.apiKey || '').trim()
  if (keyPlain) {
    payload.api_key = keyPlain
  } else if (!provider.apiKeyConfigured) {
    payload.api_key = ''
  }
  return payload
}

async function syncConnectionsToGateway(state) {
  const providers = state?.config?.models?.providers || {}
  const connections = Object.entries(providers).map(([key, p]) => connectionPayloadFromProvider(key, p))
  await api.syncModelConnections({ connections })
}

/**
 * @param {{ key: string, baseUrl?: string, codingBaseUrl?: string, agentPlanBaseUrl?: string }} preset
 * @param {string} [baseUrl]
 * @returns {'generic' | 'coding' | 'agent_plan'}
 */
function inferProviderBaseUrlMode(preset, baseUrl) {
  if (!preset || !PROVIDER_URL_MODE_KEYS.includes(preset.key)) return 'generic'
  const g = normalizeBaseUrlCompare(preset.baseUrl)
  const c = normalizeBaseUrlCompare(preset.codingBaseUrl || preset.baseUrl)
  const a = normalizeBaseUrlCompare(preset.agentPlanBaseUrl || '')
  const cur = normalizeBaseUrlCompare(baseUrl)
  if (cur && a && cur === a) return 'agent_plan'
  if (cur && g && cur === g) return 'generic'
  if (cur && c && cur === c) return 'coding'
  return 'generic'
}

/**
 * @param {{ key: string, baseUrl?: string, codingBaseUrl?: string, agentPlanBaseUrl?: string }} preset
 * @param {string} radioName
 * @param {'generic' | 'coding' | 'agent_plan'} selectedMode
 */
function urlModeRadioBlockHtml(preset, radioName, selectedMode) {
  const gUrl = escHtml(preset.baseUrl || '')
  const cUrl = escHtml(preset.codingBaseUrl || preset.baseUrl || '')
  const aUrl = escHtml(preset.agentPlanBaseUrl || '')
  const nm = escAttr(radioName)
  const initMode = selectedMode === 'coding' || selectedMode === 'agent_plan' || selectedMode === 'generic'
    ? selectedMode
    : 'generic'
  const agentRadio = aUrl
    ? `<label class="models-url-mode-option">
          <input type="radio" name="${nm}" value="agent_plan"${initMode === 'agent_plan' ? ' checked' : ''}>
          <span class="models-url-mode-option-title">Agent Plan 专属</span>
          <code class="models-url-mode-hint">${aUrl}</code>
        </label>`
    : ''
  return `
    <div class="form-group models-url-mode-group" data-url-mode-group>
      <label class="form-label">接口地址</label>
      <div class="models-url-mode-radios" role="radiogroup" aria-label="接口地址类型">
        ${agentRadio}
        <label class="models-url-mode-option">
          <input type="radio" name="${nm}" value="generic"${initMode === 'generic' ? ' checked' : ''}>
          <span class="models-url-mode-option-title">通用兼容地址（按量）</span>
          <code class="models-url-mode-hint">${gUrl}</code>
        </label>
        <label class="models-url-mode-option">
          <input type="radio" name="${nm}" value="coding"${initMode === 'coding' ? ' checked' : ''}>
          <span class="models-url-mode-option-title">Coding Plan 专属</span>
          <code class="models-url-mode-hint">${cUrl}</code>
        </label>
      </div>
    </div>`
}

/**
 * @param {HTMLElement} container
 * @param {{ baseUrl: string, codingBaseUrl?: string }} preset
 * @param {HTMLInputElement | null} baseInput
 * @param {string} radioName
 * 注意：选择官版/Coding Plan 只是提示预设值，用户仍可自由编辑 Base URL
 */
function bindUrlModeRadiosToInput(container, preset, baseInput, radioName) {
  if (!baseInput || !PROVIDER_URL_MODE_KEYS.includes(preset.key)) return
  baseInput.readOnly = false
  baseInput.style.opacity = ''
  const genericUrl = (preset.baseUrl || '').trim()
  const codingUrl = (preset.codingBaseUrl || preset.baseUrl || '').trim()
  const agentUrl = (preset.agentPlanBaseUrl || '').trim()
  const presetUrls = new Set([genericUrl, codingUrl, agentUrl].filter(Boolean))
  container.querySelectorAll(`input[type="radio"][name="${CSS.escape(radioName)}"]`).forEach((r) => {
    r.onchange = () => {
      const cur = baseInput.value.trim()
      const shouldFill = !cur || presetUrls.has(cur)
      if (!shouldFill) return
      if (r.value === 'generic') baseInput.value = genericUrl
      else if (r.value === 'coding') baseInput.value = codingUrl
      else if (r.value === 'agent_plan') baseInput.value = agentUrl || genericUrl
    }
  })
}

function bindVendorUrlModeRadios(root, preset) {
  if (!preset || !PROVIDER_URL_MODE_KEYS.includes(preset.key)) return
  const wrap = root.querySelector(`[data-inline-preset="${escAttr(preset.key)}"]`)
  if (!wrap) return
  const baseInput = wrap.querySelector('[data-inline-field="baseUrl"]')
  bindUrlModeRadiosToInput(wrap, preset, baseInput, 'models-inline-url-mode')
}

/**
 * 保存时根据单选项解析最终 baseUrl（仅三家厂商）
 * @param {HTMLElement} root
 * @param {{ key: string, baseUrl?: string, codingBaseUrl?: string } | undefined} preset
 * @param {string} radioName
 * @param {string} fallbackFromInput
 */
function resolveBaseUrlFromUrlMode(root, preset, radioName, fallbackFromInput) {
  if (!preset || !PROVIDER_URL_MODE_KEYS.includes(preset.key)) return fallbackFromInput
  // 直接返回用户输入，不再覆盖预设值
  return fallbackFromInput
}

/** 左侧厂商列表用：品牌图标（public/icons 下的厂商 SVG） */
function vendorBrandIcon(key) {
  // 厂商 key -> public/icons 文件名映射
  const iconMap = {
    openai: 'openai',
    anthropic: 'anthropic',
    deepseek: 'deepseek',
    google: 'google',
    nvidia: 'nvidia',
    ollama: 'ollama',
    zhipu: 'zhipu',
    minimax: 'minimax',
    moonshot: 'moonshot',
    volcengine: 'volcengine',
    aliyun: 'alibabacloud',
    siliconflow: 'siliconcloud',
  }
  const name = iconMap[key]
  if (name) {
    return `<img src="/icons/${name}.svg" alt="" width="22" height="22" aria-hidden="true" style="width:22px;height:22px;object-fit:contain"/>`
  }
  // 无官方图标的 fallback：生数云等
  const svg = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${body}</svg>`
  const fallbacks = {
    shengsuanyun: svg(`<path d="M6 16a4 4 0 01-.8-7.9A5.5 5.5 0 0118 8h-2a3.5 3.5 0 100 7H6z" fill="#ea580c"/>`),
  }
  return fallbacks[key] || svg(`<rect x="3" y="3" width="18" height="18" rx="5" fill="#64748b"/><text x="12" y="17" text-anchor="middle" font-size="12" font-weight="bold" fill="#fff">?</text>`)
}

function normalizeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

function hostMatchesPresetHost(providerHost, presetHost) {
  if (!providerHost || !presetHost) return false
  if (providerHost === presetHost) return true
  if (providerHost.endsWith('.' + presetHost)) return true
  if (presetHost.endsWith('.' + providerHost) && providerHost.split('.').length >= 2) return true
  return false
}

function findProviderKeyForPreset(providers, preset) {
  const keys = findProviderKeysForPreset(providers, preset)
  return keys.length ? keys[0] : null
}

/** provider key 是否属于某厂商预设（含 aliyun-2 等同厂商后缀变体） */
function providerKeyBelongsToPreset(providerKey, presetKey) {
  if (providerKey === presetKey) return true
  return providerKey.startsWith(presetKey + '-') || providerKey.startsWith(presetKey + '_')
}

/** 找出某厂商下的全部 provider key（主 key + 后缀变体；无直接匹配时回退 URL/host 匹配） */
function findProviderKeysForPreset(providers, preset) {
  const direct = Object.keys(providers).filter((k) => providerKeyBelongsToPreset(k, preset.key))
  if (direct.length) {
    return direct.sort((a, b) => {
      if (a === preset.key) return -1
      if (b === preset.key) return 1
      return a.localeCompare(b, undefined, { numeric: true })
    })
  }
  // 百炼 / 火山 / 智谱：通用与 Coding 常为同 host 不同 path，先按完整 Base URL 匹配以免串项
  if (PROVIDER_URL_MODE_KEYS.includes(preset.key)) {
    const g = normalizeBaseUrlCompare(preset.baseUrl)
    const c = normalizeBaseUrlCompare(preset.codingBaseUrl || preset.baseUrl)
    for (const [k, p] of Object.entries(providers)) {
      const u = normalizeBaseUrlCompare(p.baseUrl || '')
      if (u && (u === g || u === c)) return [k]
    }
  }
  const target = normalizeHost(preset.baseUrl)
  if (!target) return []
  for (const [k, p] of Object.entries(providers)) {
    const h = normalizeHost(p.baseUrl || '')
    if (h && hostMatchesPresetHost(h, target)) return [k]
  }
  return []
}

// 已移除 getUnmatchedProviderKeys — 厂商预设列表全覆盖

function pickDefaultVendorSelection(state, providers) {
  for (const pr of VENDOR_PRESETS) {
    const pk = findProviderKeyForPreset(providers, pr)
    if (pk) {
      state.selectedVendorPreset = pr.key
      state.selectedProviderKey = pk
      return
    }
  }
  state.selectedVendorPreset = VENDOR_PRESETS[0]?.key || null
  state.selectedProviderKey = null
}

/** 保持选中项与配置一致（外部写入 config、删除服务商等） */
function reconcileModelPageSelection(state, providers) {
  if (!state.selectedVendorPreset) {
    pickDefaultVendorSelection(state, providers)
    return
  }
  const pr = VENDOR_PRESETS.find((p) => p.key === state.selectedVendorPreset)
  if (!pr) {
    pickDefaultVendorSelection(state, providers)
    return
  }
  const pks = findProviderKeysForPreset(providers, pr)
  if (!pks.length) {
    state.selectedProviderKey = null
    return
  }
  if (!state.selectedProviderKey || !pks.includes(state.selectedProviderKey)) {
    state.selectedProviderKey = pks[0]
  }
}

function displayTitleForProvider(providerKey, providers) {
  const custom = String(providers?.[providerKey]?.displayName || '').trim()
  if (custom) return custom
  // 精确匹配预设厂商
  if (VENDOR_PRESETS.some((p) => p.key === providerKey)) {
    const pr = VENDOR_PRESETS.find((p) => p.key === providerKey)
    return pr ? pr.label : providerKey
  }
  // 带后缀的同厂商多配置（如 aliyun-2、aliyun-coding）
  for (const pr of VENDOR_PRESETS) {
    if (providerKey === pr.key || providerKey.startsWith(pr.key + '-') || providerKey.startsWith(pr.key + '_')) {
      const suffix = providerKey.slice(pr.key.length + 1)
      return suffix ? `${pr.label} (${suffix})` : pr.label
    }
  }
  // 通过 findProviderKeyForPreset 匹配
  for (const pr of VENDOR_PRESETS) {
    if (findProviderKeyForPreset(providers, pr) === providerKey) return pr.label
  }
  return providerKey
}

/** 同厂商多套连接时的默认标签（默认连接 / 连接 2 / 自定义后缀） */
function defaultConnectionLabel(providerKey, presetKey) {
  if (providerKey === presetKey) return '默认连接'
  const sep = providerKey[presetKey.length]
  if ((sep === '-' || sep === '_') && providerKey.startsWith(presetKey + sep)) {
    const suffix = providerKey.slice(presetKey.length + 1)
    if (/^\d+$/.test(suffix)) return `连接 ${suffix}`
    return suffix
  }
  return providerKey
}

function findVendorPresetForProviderKey(providerKey) {
  return VENDOR_PRESETS.find((p) => providerKeyBelongsToPreset(providerKey, p.key)) || null
}

const PROVIDER_DISPLAY_NAMES_KEY = 'evoflow-provider-display-names-v1'

function loadProviderDisplayNames() {
  try {
    const raw = localStorage.getItem(PROVIDER_DISPLAY_NAMES_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveProviderDisplayNames(map) {
  try {
    localStorage.setItem(PROVIDER_DISPLAY_NAMES_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

function applyStoredProviderDisplayNames(providers) {
  const map = loadProviderDisplayNames()
  for (const [pk, p] of Object.entries(providers || {})) {
    const stored = map[pk]
    if (typeof stored === 'string' && stored.trim()) p.displayName = stored.trim()
  }
}

function persistProviderDisplayNames(providers) {
  const map = loadProviderDisplayNames()
  for (const [pk, p] of Object.entries(providers || {})) {
    const name = String(p?.displayName || '').trim()
    if (name) map[pk] = name
    else delete map[pk]
  }
  for (const pk of Object.keys(map)) {
    if (!providers?.[pk]) delete map[pk]
  }
  saveProviderDisplayNames(map)
}

function setProviderDisplayName(state, providerKey, name) {
  const p = state.config?.models?.providers?.[providerKey]
  if (!p) return false
  const preset = findVendorPresetForProviderKey(providerKey)
  const effectiveDefault = defaultConnectionLabel(providerKey, preset?.key || providerKey)
  let trimmed = String(name || '').trim()
  if (trimmed === effectiveDefault) trimmed = ''
  if (trimmed) p.displayName = trimmed
  else delete p.displayName
  persistProviderDisplayNames(state.config.models.providers)
  return true
}

/** 连接展示名：优先自定义 displayName，否则用默认规则 */
function resolveConnectionLabel(providerKey, providers, presetKey = null) {
  const p = providers?.[providerKey]
  const custom = String(p?.displayName || '').trim()
  if (custom) return custom
  const pk = presetKey || findVendorPresetForProviderKey(providerKey)?.key
  if (pk) return defaultConnectionLabel(providerKey, pk)
  return displayTitleForProvider(providerKey, providers)
}

function shortConnectionUrl(baseUrl) {
  const s = String(baseUrl || '').trim()
  if (!s) return '未填写接口'
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`)
    const path = u.pathname.replace(/\/+$/, '')
    if (!path || path === '/v1' || path === '/api/v1') return u.host
    return u.host + path
  } catch {
    return s.length > 36 ? `${s.slice(0, 33)}…` : s
  }
}

function buildConnectionPickerHTML(pks, selectedKey, presetKey, providers, primaryPk) {
  const items = pks.map((pk) => {
    const p = providers[pk]
    const active = pk === selectedKey
    const label = resolveConnectionLabel(pk, providers, presetKey)
    const defaultLabel = defaultConnectionLabel(pk, presetKey)
    const url = shortConnectionUrl(p?.baseUrl)
    const modelCount = (p?.models || []).length
    const keyOk = providerHasApiKey(p)
    const keyOptional = providerApiKeyOptional(pk, p)
    const keyMeta = keyOk ? '已配置密钥' : (keyOptional ? '无需密钥' : '无密钥')
    const hostsPrimary = !!(primaryPk && pk === primaryPk)
    const renameTitle = p?.displayName ? `自定义名称（默认：${defaultLabel}）` : `默认：${defaultLabel}，可在下方修改`
    return `<div class="models-connection-picker-item${active ? ' active' : ''}" data-provider="${escAttr(pk)}" role="tab" aria-selected="${active ? 'true' : 'false'}">
      <button type="button" class="models-connection-picker-main" data-select-connection="${escAttr(pk)}" title="${escAttr(renameTitle)}">
        <span class="models-connection-picker-top">
          <span class="models-connection-picker-label">${escHtml(label)}</span>
          ${hostsPrimary ? '<span class="models-vendor-primary-badge">主模型</span>' : ''}
        </span>
        <code class="models-connection-picker-url" title="${escAttr(p?.baseUrl || '')}">${escHtml(url)}</code>
        <span class="models-connection-picker-meta">${modelCount} 个模型 · ${keyMeta}</span>
      </button>
      <div class="models-connection-picker-actions">
        <button type="button" class="btn btn-xs btn-secondary" data-action="edit-provider">编辑</button>
        <button type="button" class="btn btn-xs btn-danger" data-action="delete-provider">删除</button>
      </div>
    </div>`
  }).join('')

  return `<div class="models-connection-picker" role="tablist" aria-label="选择连接">
    ${items}
  </div>`
}

/** 连接卡片 + 模型列表（单套/多套统一布局） */
function buildProviderConnectionDetailHTML(title, presetKey, pks, state, primary, options = {}) {
  const { showAddConnection = true } = options
  const providers = state.config?.models?.providers || {}
  if (!pks.length) return ''

  const selectedKey =
    state.selectedProviderKey && pks.includes(state.selectedProviderKey) ? state.selectedProviderKey : pks[0]
  state.selectedProviderKey = selectedKey

  const primaryPk = primaryProviderKeyFromPrimary(state.config, primary)
  const picker = buildConnectionPickerHTML(pks, selectedKey, presetKey, providers, primaryPk)
  const section = buildSingleProviderSectionHTML(selectedKey, state, primary)
  const connHint =
    pks.length > 1
      ? `<p class="form-hint models-vendor-detail-sub">共 ${pks.length} 套连接，点击卡片切换</p>`
      : ''
  const addBtn = showAddConnection
    ? `<button type="button" class="btn btn-sm btn-secondary models-vendor-add-conn" data-action="add-connection" data-provider="${escAttr(selectedKey)}">+ 添加连接</button>`
    : ''
  const planPromo =
    presetKey === 'volcengine'
      ? planBundlePromoHtml({
          catalogId: 'volcengine.agent_plan',
          binding: state.planBindings?.['volcengine.agent_plan'] || null,
        })
      : ''
  const planManaged =
    presetKey === 'volcengine' &&
    state.planBindings?.['volcengine.agent_plan']?.status === 'active'
      ? `<div class="models-plan-managed-bar" role="status">
          本页火山对话模型由 <strong>套餐</strong> 写入；改 Key / 补齐模型请到「套餐」Tab。
          <button type="button" class="btn btn-sm btn-secondary" data-action="open-plans-settings">打开套餐</button>
        </div>`
      : ''

  return `<div class="models-vendor-detail">
    ${planPromo}
    ${planManaged}
    <header class="models-vendor-detail-head models-vendor-detail-head--row">
      <div class="models-vendor-detail-head-main">
        <h3 class="models-vendor-detail-title">${escHtml(title)}</h3>
        ${connHint}
      </div>
      <div class="models-vendor-detail-head-actions" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
        ${addBtn}
      </div>
    </header>
    ${picker}
    <div id="providers-list">${section}</div>
  </div>`
}

/** 预设厂商详情 */
function buildVendorDetailHTML(vendorPreset, state, primary) {
  const providers = state.config?.models?.providers || {}
  const pks = findProviderKeysForPreset(providers, vendorPreset)
  if (!pks.length) return ''
  return buildProviderConnectionDetailHTML(vendorPreset.label, vendorPreset.key, pks, state, primary, {
    showAddConnection: true,
  })
}

/** 未配置该厂商时：右侧直接内联填写接口与密钥，不再弹窗或「添加厂商」空状态 */
function renderVendorInlineSetupForm(preset, state = {}) {
  const desc = preset.desc
    ? `<p class="form-hint models-inline-setup-desc">${escHtml(preset.desc)}</p>`
    : ''
  const site =
    preset.site
      ? `<a href="${escAttr(preset.site)}" target="_blank" rel="noopener noreferrer" class="models-inline-setup-site">${icon('external-link', 12)} 官网文档</a>`
      : ''
  const urlModeBlock =
    PROVIDER_URL_MODE_KEYS.includes(preset.key)
      ? urlModeRadioBlockHtml(preset, 'models-inline-url-mode', 'generic')
      : ''
  const baseUrlLabel = PROVIDER_URL_MODE_KEYS.includes(preset.key) ? 'Base URL（自定义时编辑）' : '接口地址'
  const isOpenAICompatPreset = preset.key === 'openai'
  const baseUrlHint = isOpenAICompatPreset
    ? `<div class="form-hint">默认可保留官方地址；也可改为 NewAPI / OneAPI / Azure 兼容端 / 自建网关等。不强制 OpenAI 官方账号，也不是 ChatGPT Plus 订阅。</div>`
    : (!PROVIDER_URL_MODE_KEYS.includes(preset.key) && !preset.apiKeyOptional
      ? `<div class="form-hint">模型服务的 API 地址，通常以 /v1 结尾</div>`
      : '')
  const keyOptional = !!preset.apiKeyOptional
  const apiKeyBlock = keyOptional
    ? `<div class="form-group models-apikey-optional"><div class="form-hint" style="margin:0">本机 Ollama 默认无需 API Key。</div></div>`
    : `<div class="form-group">
          <label class="form-label" for="models-inline-keyf-${escAttr(preset.key)}">API Key</label>
          <input id="models-inline-keyf-${escAttr(preset.key)}" class="form-input" data-inline-field="apiKey" type="password" autocomplete="off" placeholder="${isOpenAICompatPreset ? '官方 sk-…，或兼容端点发放的 Key' : '可留空（无需鉴权的服务）'}">
          ${isOpenAICompatPreset ? '<div class="form-hint">填官方 platform.openai.com 发放的 Key，或你所填兼容端点对应的密钥即可。</div>' : ''}
        </div>`
  const planPromo =
    preset.key === 'volcengine'
      ? planBundlePromoHtml({
          catalogId: 'volcengine.agent_plan',
          binding: state.planBindings?.['volcengine.agent_plan'] || null,
        })
      : ''
  const manualDivider =
    preset.key === 'volcengine'
      ? `<div class="models-plan-manual-divider"><span>或不使用套餐，手动填按量/通用 API</span></div>`
      : ''
  return `
    <div class="models-inline-setup" data-inline-preset="${escAttr(preset.key)}">
      ${planPromo}
      ${manualDivider}
      <header class="models-inline-setup-head">
        <div class="models-inline-setup-title-row">
          <span class="models-inline-setup-ic" aria-hidden="true">${vendorBrandIcon(preset.key)}</span>
          <h3 class="models-inline-setup-title">${escHtml(preset.label)}</h3>
        </div>
        ${site}
      </header>
      ${desc}
      <div class="models-inline-setup-form">
        <input type="hidden" data-inline-field="key" value="${escAttr(preset.key)}">
        ${urlModeBlock}
        <div class="form-group">
          <label class="form-label" for="models-inline-base-${escAttr(preset.key)}">${escHtml(baseUrlLabel)}</label>
          <input id="models-inline-base-${escAttr(preset.key)}" class="form-input" data-inline-field="baseUrl" value="${escAttr(preset.baseUrl)}" autocomplete="off">
          ${baseUrlHint}
        </div>
        ${apiKeyBlock}
        <div class="models-inline-setup-actions">
          <button type="button" class="btn btn-primary" data-action="save-inline-provider">保存配置</button>
        </div>
      </div>
    </div>
  `
}

/**
 * @param {{ settingsModal?: boolean }} [options]
 */
export async function render(options = {}) {
  const settingsModal = !!options.settingsModal
  const page = document.createElement('div')
  page.className = settingsModal
    ? 'settings-modal-pane settings-modal-pane--models'
    : 'page models-page'

  const fullPageTitle = settingsModal ? '' : ''

  const toolbarPad = settingsModal ? 'padding:var(--space-md) var(--space-lg)' : ''
  const hintMb = settingsModal ? 'var(--space-sm)' : 'var(--space-md)'

  page.innerHTML = `
    <div class="models-tab-bar tab-bar" role="tablist">
      <div class="models-tab-bar-tabs">
        <button type="button" class="tab active" data-model-tab="chat" role="tab" aria-selected="true">对话模型</button>
        <button type="button" class="tab" data-model-tab="embedding" role="tab" aria-selected="false">向量模型</button>
        <button type="button" class="tab" data-model-tab="media" role="tab" aria-selected="false">语音</button>
        <button type="button" class="tab" data-model-tab="plan" role="tab" aria-selected="false">套餐</button>
      </div>
    </div>
    <div class="models-split-layout">
      <aside class="models-sidebar" aria-label="模型配置">
        <section class="models-sidebar-section" id="models-sidebar-section" data-sidebar-section="models">
          <button type="button" class="models-sidebar-section-head" data-sidebar-section-toggle="models" aria-expanded="true" style="display:none">
            <span>对话模型</span>
            <svg class="models-sidebar-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div class="models-sidebar-section-body">
            <div id="models-provider-rail" class="models-vendor-list">
          <div class="models-sidebar-loading" style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--text-tertiary);font-size:12px">...</div>
            </div>
          </div>
        </section>
        <section class="models-sidebar-section" id="embedding-sidebar-section" data-sidebar-section="embedding" hidden>
          <div class="models-sidebar-section-body">
            <div id="embedding-model-rail" class="models-vendor-list">
              <div style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--text-tertiary);font-size:12px">...</div>
            </div>
          </div>
        </section>
        <div id="media-vendor-rail-host"></div>
      </aside>
      <main class="models-main">
        ${settingsModal ? '' : fullPageTitle}
        <div id="default-model-bar" class="models-primary-row"></div>
        <div class="models-body" id="models-detail-inner">
          <div class="models-loading-placeholder" style="height:160px;display:flex;align-items:center;justify-content:center;color:var(--text-tertiary)">...</div>
        </div>
      </main>
    </div>
  `

  // 非阻塞：先返回 DOM，后台加载数据
  const state = {
    config: null,
    undoStack: [],
    selectedProviderKey: null,
    selectedVendorPreset: null,
    activeSection: 'models',
    activeTab: 'chat',
    embeddingModels: [],
    selectedEmbeddingIdx: 0,
    embeddingStatus: {},
    embeddingErrors: {},
    embeddingStatusInflight: false,
    kbDefaultEmbedding: '',
  }
  // Tab switching
  page.querySelectorAll('[data-model-tab]').forEach(btn => {
    btn.onclick = async () => switchTab(page, state, btn.dataset.modelTab)
  })

  loadConfig(page, state)
  bindTopActions(page, state)
  const onModelsChanged = () => {
    void loadConfig(page, state)
  }
  window.addEventListener('evopanel:models-changed', onModelsChanged)
  page.addEventListener(
    'evopanel:models-page-dispose',
    () => window.removeEventListener('evopanel:models-changed', onModelsChanged),
    { once: true },
  )
  void attachMediaToModelsPage(page, state, {
    onModelsSectionExpand: () => {
      if (state.config) {
        renderProviders(page, state)
        renderDefaultBar(page, state)
      }
    },
  })

  return page
}

/** 设置弹窗专用：无全页 .page 外壳与重复标题区 */
export async function mountModelsForSettingsModal(container) {
  const el = await render({ settingsModal: true })
  container.replaceChildren(el)
}

// ---------------------------------------------------------------------------
// Tab switching: 对话模型 / 向量模型 / 语音
// ---------------------------------------------------------------------------

/** 从 gateway models 列表中分离出向量模型 */
function collectEmbeddingModels(models) {
  return (models || []).filter(isEmbeddingModel).map(m => ({
    name: m.name || '',
    vendor: m.vendor || '',
    model: m.model || '',
    displayName: m.display_name || m.name || m.model || '',
  }))
}

function embeddingStatusLabel(status) {
  if (status === 'ok') return { text: '可用', cls: 'models-embedding-status--ok' }
  if (status === 'fail') return { text: '不可用', cls: 'models-embedding-status--fail' }
  return { text: '检测中…', cls: 'models-embedding-status--checking' }
}

function embeddingStatusBadgeHtml(name, statusMap) {
  const { text, cls } = embeddingStatusLabel(statusMap?.[name])
  return `<span class="models-embedding-status ${cls}">${escHtml(text)}</span>`
}

function invalidateEmbeddingStatuses(state) {
  state.embeddingStatus = {}
  state.embeddingErrors = {}
  state.embeddingStatusInflight = false
}

async function refreshEmbeddingStatuses(page, state) {
  const models = state.embeddingModels || []
  if (!models.length || state.embeddingStatusInflight) return
  state.embeddingStatusInflight = true
  state.embeddingStatus = state.embeddingStatus || {}
  state.embeddingErrors = state.embeddingErrors || {}
  for (const m of models) {
    if (!state.embeddingStatus[m.name]) state.embeddingStatus[m.name] = 'checking'
    delete state.embeddingErrors[m.name]
  }
  renderEmbeddingView(page, state, { skipProbe: true })
  await Promise.all(models.map(async (m) => {
    if (!m.name) {
      state.embeddingStatus[m.name || ''] = 'fail'
      state.embeddingErrors[m.name || ''] = '模型名称为空'
      return
    }
    try {
      const res = await api.probeEmbeddingModel(m.name)
      if (res?.ok) {
        state.embeddingStatus[m.name] = 'ok'
        delete state.embeddingErrors[m.name]
      } else {
        state.embeddingStatus[m.name] = 'fail'
        state.embeddingErrors[m.name] = String(res?.message || '探测失败').slice(0, 400)
      }
    } catch (e) {
      state.embeddingStatus[m.name] = 'fail'
      state.embeddingErrors[m.name] = String(e?.message || e || '探测失败').slice(0, 400)
    }
  }))
  state.embeddingStatusInflight = false
  renderEmbeddingView(page, state, { skipProbe: true })
}

/** 切换顶部 Tab */
/** @type {{ cleanup: () => void } | null} */
let _plansTabMod = null

async function unmountPlanTab(page) {
  page.querySelector('.models-split-layout')?.classList.remove('models-split-layout--plan')
  if (_plansTabMod) {
    try {
      _plansTabMod.cleanup()
    } catch {
      /* ignore */
    }
    _plansTabMod = null
  }
}

async function mountPlanTab(page, state) {
  const split = page.querySelector('.models-split-layout')
  split?.classList.add('models-split-layout--plan')
  const detailMount = page.querySelector('#models-detail-inner')
  if (!detailMount) return
  const mod = await import('./settings/plans.js')
  _plansTabMod = mod
  await mod.mountPlansInto(detailMount, {
    onGotoChat: () => {
      void switchTab(page, state, 'chat')
    },
  })
}

async function switchTab(page, state, tabKey) {
  if (!tabKey) return
  if (state.activeTab === tabKey) {
    if (tabKey !== 'plan') return
    const hasPlanRoot = page.querySelector('#models-detail-inner .plans-page, #models-detail-inner .settings-plans-root')
    if (hasPlanRoot) return
  }
  const leavingPlan = state.activeTab === 'plan'
  state.activeTab = tabKey

  // 更新 Tab 高亮
  page.querySelectorAll('[data-model-tab]').forEach(btn => {
    const active = btn.dataset.modelTab === tabKey
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-selected', active ? 'true' : 'false')
  })

  const modelsSection = page.querySelector('#models-sidebar-section')
  const embeddingSection = page.querySelector('#embedding-sidebar-section')
  const mediaSection = page.querySelector('#media-sidebar-section')
  const defaultBar = page.querySelector('#default-model-bar')
  const detailMount = page.querySelector('#models-detail-inner')

  // 先全部隐藏
  modelsSection?.setAttribute('hidden', '')
  embeddingSection?.setAttribute('hidden', '')
  mediaSection?.setAttribute('hidden', '')
  defaultBar?.setAttribute('hidden', '')
  if (leavingPlan || tabKey !== 'plan') {
    await unmountPlanTab(page)
  }

  if (tabKey === 'chat') {
    modelsSection?.removeAttribute('hidden')
    defaultBar?.removeAttribute('hidden')
    state.activeSection = 'models'
    clearMediaSelection(page)
    if (state.config) {
      renderProviders(page, state)
      renderDefaultBar(page, state)
    }
  } else if (tabKey === 'embedding') {
    embeddingSection?.removeAttribute('hidden')
    state.activeSection = 'embedding'
    await reloadEmbeddingModels(state)
    await loadKbDefaultEmbedding(state)
    renderEmbeddingView(page, state)
  } else if (tabKey === 'media') {
    mediaSection?.removeAttribute('hidden')
    state.activeSection = 'media'
    if (detailMount) detailMount.innerHTML = ''
    // 触发 media.js 渲染详情区
    try {
      const { renderMediaDetail } = await import('./settings/media.js')
      renderMediaDetail()
    } catch { /* media.js 未加载时忽略 */ }
  } else if (tabKey === 'plan') {
    state.activeSection = 'plan'
    clearMediaSelection(page)
    if (detailMount) detailMount.innerHTML = ''
    await mountPlanTab(page, state)
  }
}

/** 渲染向量模型 Tab 的侧栏 + 详情区 */
function renderEmbeddingView(page, state, opts = {}) {
  const railEl = page.querySelector('#embedding-model-rail')
  const detailMount = page.querySelector('#models-detail-inner')
  if (!railEl || !detailMount) return

  const models = state.embeddingModels || []
  const statusMap = state.embeddingStatus || {}

  if (!models.length) {
    railEl.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text-tertiary);font-size:13px">暂无向量模型</div>`
    detailMount.innerHTML = `
      <div class="models-embedding-empty">
        <p class="form-hint">还没有向量模型。若已绑定 Agent Plan 全家桶，请到「套餐」页点「按套餐目录补齐」；或点下方手动添加。</p>
        <button type="button" class="btn btn-primary btn-sm" data-action="add-embedding-model">+ 添加向量模型</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="goto-plan" style="margin-left:8px">去套餐页补齐</button>
      </div>`
    const addBtn = detailMount.querySelector('[data-action="add-embedding-model"]')
    if (addBtn) addBtn.onclick = () => addEmbeddingModel(page, state)
    const gotoPlan = detailMount.querySelector('[data-action="goto-plan"]')
    if (gotoPlan) gotoPlan.onclick = () => void switchTab(page, state, 'plan')
    return
  }

  // 渲染侧栏列表
  railEl.innerHTML = models.map((m, i) => {
    const active = i === state.selectedEmbeddingIdx
    const icon = String(m.vendor).toLowerCase() === 'local'
      ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><circle cx="7" cy="7" r="1" fill="currentColor"/><circle cx="7" cy="17" r="1" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></svg>'
    return `<button type="button" class="models-vendor-item${active ? ' active' : ''} configured" data-embedding-idx="${i}">
      <span class="models-vendor-icon" aria-hidden="true">${icon}</span>
      <span class="models-vendor-meta">
        <span class="models-vendor-label-row">
          <span class="models-vendor-label">${escHtml(m.displayName)}</span>
          ${embeddingStatusBadgeHtml(m.name, statusMap)}
        </span>
      </span>
    </button>`
  }).join('') + `
    <button type="button" class="models-vendor-item models-vendor-item--add" data-action="add-embedding-model">
      <span class="models-vendor-icon models-vendor-icon--neutral" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
      </span>
      <span class="models-vendor-meta">
        <span class="models-vendor-label">添加向量模型</span>
      </span>
    </button>`

  // 侧栏点击切换
  railEl.querySelectorAll('[data-embedding-idx]').forEach(btn => {
    btn.onclick = () => {
      state.selectedEmbeddingIdx = parseInt(btn.dataset.embeddingIdx, 10) || 0
      renderEmbeddingView(page, state, { skipProbe: true })
    }
  })
  const addRailBtn = railEl.querySelector('[data-action="add-embedding-model"]')
  if (addRailBtn) addRailBtn.onclick = () => addEmbeddingModel(page, state)

  // 渲染详情区
  const m = models[state.selectedEmbeddingIdx]
  if (!m) return
  const status = embeddingStatusLabel(statusMap[m.name])
  const errMsg = (state.embeddingErrors || {})[m.name]
  const errHtml = status.text === '不可用' && errMsg
    ? `<p class="models-embedding-error form-hint">${escHtml(errMsg)}</p>`
    : ''

  detailMount.innerHTML = `
    <div class="models-vendor-detail models-embedding-detail">
      <header class="models-vendor-detail-head models-vendor-detail-head--row">
        <div class="models-vendor-detail-head-main">
          <h3 class="models-vendor-detail-title">${escHtml(m.displayName)}</h3>
        </div>
        <span class="models-embedding-status models-embedding-status--detail ${status.cls}">${escHtml(status.text)}</span>
      </header>
      ${errHtml}
      <p class="form-hint" style="margin-top:8px">知识库、代码索引等从此目录选用向量模型。本地模型首次检测可能需下载约 95MB 权重。</p>
      <div class="models-kb-default-row" style="margin-top:12px;padding:10px 12px;border:1px solid var(--border, #e5e7eb);border-radius:8px;background:var(--bg-secondary, transparent)">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">知识库默认</div>
        <p class="form-hint" style="margin:0 0 8px">新建知识库时预选此模型；单库仍可覆盖。</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <span class="models-embedding-status ${state.kbDefaultEmbedding === m.name ? 'models-embedding-status--ok' : ''}" data-kb-default-badge>
            ${state.kbDefaultEmbedding === m.name ? '当前默认' : '未设为默认'}
          </span>
          <button type="button" class="btn btn-sm ${state.kbDefaultEmbedding === m.name ? 'btn-secondary' : 'btn-primary'}" data-action="set-kb-default-embedding" ${state.kbDefaultEmbedding === m.name ? 'disabled' : ''}>
            ${state.kbDefaultEmbedding === m.name ? '已是默认' : '设为知识库默认'}
          </button>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button type="button" class="btn btn-sm btn-secondary" data-action="recheck-embedding">重新检测</button>
        <button type="button" class="btn btn-sm btn-danger" data-action="delete-embedding">删除</button>
      </div>
    </div>`

  const setDefaultBtn = detailMount.querySelector('[data-action="set-kb-default-embedding"]')
  if (setDefaultBtn) {
    setDefaultBtn.onclick = async () => {
      try {
        const res = await api.setOwnedKnowledgeSettings({ defaultEmbeddingModel: m.name })
        state.kbDefaultEmbedding = String(res?.effectiveEmbeddingModel || res?.defaultEmbeddingModel || m.name || '')
        toast(`已将「${m.displayName}」设为知识库默认向量模型`, 'success')
        renderEmbeddingView(page, state, { skipProbe: true })
      } catch (e) {
        toast('设置失败: ' + (e?.message || e), 'error')
      }
    }
  }

  const recheckBtn = detailMount.querySelector('[data-action="recheck-embedding"]')
  if (recheckBtn) {
    recheckBtn.onclick = () => {
      invalidateEmbeddingStatuses(state)
      void refreshEmbeddingStatuses(page, state)
    }
  }

  const delBtn = detailMount.querySelector('[data-action="delete-embedding"]')
  if (delBtn) {
    delBtn.onclick = async () => {
      const yes = await showConfirm(`确定删除向量模型「${m.displayName}」？`)
      if (!yes) return
      try {
        await api.deleteModel(m.name)
        state.embeddingModels.splice(state.selectedEmbeddingIdx, 1)
        state.selectedEmbeddingIdx = Math.max(0, state.selectedEmbeddingIdx - 1)
        invalidateEmbeddingStatuses(state)
        await reloadEmbeddingModels(state)
        renderEmbeddingView(page, state)
        toast(`已删除 ${m.displayName}`, 'info')
      } catch (e) {
        toast('删除失败: ' + e, 'error')
      }
    }
  }

  if (!opts.skipProbe) {
    void refreshEmbeddingStatuses(page, state)
  }
}

/** 重新从 gateway 加载向量模型列表 */
async function reloadEmbeddingModels(state) {
  try {
    const list = await api.listModels()
    const models = Array.isArray(list?.models) ? list.models : []
    state.embeddingModels = collectEmbeddingModels(models)
    invalidateEmbeddingStatuses(state)
  } catch {
    /* ignore */
  }
}

async function loadKbDefaultEmbedding(state) {
  try {
    const res = await api.getOwnedKnowledgeSettings()
    state.kbDefaultEmbedding = String(
      res?.effectiveEmbeddingModel || res?.defaultEmbeddingModel || '',
    )
  } catch {
    state.kbDefaultEmbedding = state.kbDefaultEmbedding || ''
  }
}

/** 添加向量模型弹窗 */
function addEmbeddingModel(page, state) {
  const overlay = mountModelsModalOverlay(`
    <div class="modal" style="max-width:520px">
      <div class="modal-title">添加向量模型</div>
      <div class="form-group">
        <label class="form-label">模型类型</label>
        <div style="display:flex;gap:12px;margin-bottom:8px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="radio" name="emb-type" value="local" checked>
            <span>本地模型</span>
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="radio" name="emb-type" value="cloud">
            <span>云端 API</span>
          </label>
        </div>
      </div>
      <div id="emb-local-fields">
        <div class="form-group">
          <label class="form-label">模型 ID</label>
          <select class="form-input" data-name="localModel">
            <option value="BAAI/bge-small-zh-v1.5">BAAI/bge-small-zh-v1.5（推荐）</option>
            <option value="BAAI/bge-base-zh-v1.5">BAAI/bge-base-zh-v1.5</option>
            <option value="BAAI/bge-large-zh-v1.5">BAAI/bge-large-zh-v1.5</option>
            <option value="BAAI/bge-m3">BAAI/bge-m3</option>
            <option value="nomic-ai/nomic-embed-text-v1.5">nomic-ai/nomic-embed-text-v1.5</option>
          </select>
        </div>
      </div>
      <div id="emb-cloud-fields" style="display:none">
        <div class="form-group">
          <label class="form-label">模型 ID</label>
          <input class="form-input" data-name="cloudModel" value="text-embedding-3-small" placeholder="如 text-embedding-3-small">
        </div>
        <div class="form-group">
          <label class="form-label">接口地址 (Base URL)</label>
          <input class="form-input" data-name="cloudBaseUrl" value="https://api.openai.com/v1" placeholder="https://api.openai.com/v1">
        </div>
        <div class="form-group">
          <label class="form-label">API Key</label>
          <input class="form-input" data-name="cloudApiKey" type="password" placeholder="sk-...">
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
        <button type="button" class="btn btn-primary btn-sm" data-action="confirm">添加</button>
      </div>
    </div>
  `)

  // 类型切换
  overlay.querySelectorAll('input[name="emb-type"]').forEach(radio => {
    radio.onchange = () => {
      const isLocal = radio.value === 'local'
      overlay.querySelector('#emb-local-fields').style.display = isLocal ? '' : 'none'
      overlay.querySelector('#emb-cloud-fields').style.display = isLocal ? 'none' : ''
    }
  })

  // 表单弹窗不因点击遮罩关闭，避免 API Key 等输入误触丢失
  overlay.querySelector('[data-action="cancel"]').onclick = () => overlay.remove()
  overlay.querySelector('[data-action="confirm"]').onclick = async () => {
    const type = overlay.querySelector('input[name="emb-type"]:checked')?.value
    let req
    if (type === 'local') {
      const modelId = overlay.querySelector('[data-name="localModel"]').value
      req = {
        name: modelId.split('/').pop(),
        vendor: 'local',
        model: modelId,
        display_name: modelId,
      }
    } else {
      const modelId = overlay.querySelector('[data-name="cloudModel"]').value.trim()
      const baseUrl = overlay.querySelector('[data-name="cloudBaseUrl"]').value.trim()
      const apiKey = overlay.querySelector('[data-name="cloudApiKey"]').value.trim()
      if (!modelId) { toast('请填写模型 ID', 'warning'); return }
      req = {
        name: `embedding-${modelId}`,
        vendor: 'openai-embedding',
        model: modelId,
        display_name: modelId,
        base_url: baseUrl,
        use: 'langchain_openai:ChatOpenAI',
      }
      if (apiKey) req.api_key = apiKey
    }

    try {
      await api.createModel(req)
      overlay.remove()
      await reloadEmbeddingModels(state)
      renderEmbeddingView(page, state)
      toast(`已添加向量模型: ${req.display_name}`, 'success')
    } catch (e) {
      toast('添加失败: ' + e, 'error')
    }
  }
}

function showModelsBar(page, state) {
  state.activeSection = 'models'
  clearMediaSelection(page)
  page.querySelector('#default-model-bar')?.removeAttribute('hidden')
}

async function loadConfig(page, state) {
  const detailMount = page.querySelector('#models-detail-inner')
  try {
    try {
      await api.cleanupStaleModels()
    } catch {
      /* best-effort legacy cleanup */
    }

    // 数据源：Gateway SQLite evoflow_models（非 YAML）
    const list = await api.listModels()
    const models = Array.isArray(list?.models) ? list.models : []

    // 收集向量模型（用于"向量模型" Tab）
    state.embeddingModels = collectEmbeddingModels(models)
    invalidateEmbeddingStatuses(state)
    void loadKbDefaultEmbedding(state)

    const primaryInfo = await api.getPrimaryModel()
    const primaryModelRaw = primaryInfo?.primary_model || ''

    const chatModels = models.filter((m) => !isEmbeddingModel(m))
    const { providers, primaryFull } = providersFromGatewayModels(chatModels, primaryModelRaw)

    const connResp = await api.listModelConnections()
    const connList = Array.isArray(connResp?.connections) ? connResp.connections : []
    const mergedProviders = mergeProvidersWithStoredConnections(providers, connList)

    applyStoredProviderDisplayNames(mergedProviders)

    state.config = {
      models: { mode: 'replace', providers: mergedProviders },
      agents: { defaults: { model: { primary: primaryFull } } },
    }
    state.planBindings = {}
    try {
      const planRes = await api.listPlanBindings(false)
      const items = Array.isArray(planRes?.items) ? planRes.items : []
      for (const b of items) {
        if (b?.catalog_id && b.status === 'active') state.planBindings[b.catalog_id] = b
      }
    } catch {
      /* Plan API 未就绪时忽略 */
    }
    if (state.activeTab === 'chat') {
      renderDefaultBar(page, state)
      renderProviders(page, state)
    } else if (state.activeTab === 'embedding') {
      renderEmbeddingView(page, state)
    } else if (state.activeTab === 'plan' && _plansTabMod?.refreshPlans) {
      void _plansTabMod.refreshPlans()
    }
  } catch (e) {
    if (detailMount) {
      detailMount.innerHTML = '<div style="color:var(--error);padding:20px">加载配置失败: ' + e + '</div>'
    }
    toast('加载配置失败: ' + e, 'error')
  }
}

function getCurrentPrimary(config) {
  return config?.agents?.defaults?.model?.primary || ''
}

function collectAllModels(config) {
  const result = []
  const providers = config?.models?.providers || {}
  for (const [pk, pv] of Object.entries(providers)) {
    for (const m of (pv.models || [])) {
      const configName = modelConfigName(m)
      const modelId = modelProviderId(m)
      if (configName) result.push({ provider: pk, modelId, configName, full: configName })
    }
  }
  return result
}

/** 右侧摘要区：不暴露完整密钥 */
function apiKeySummaryHtml(apiKey, apiKeyConfigured = false, { optional = false } = {}) {
  const s = (apiKey && String(apiKey).trim()) || ''
  if (s) {
    return `<span class="models-apikey-saved">已配置</span><span class="models-apikey-meta"> · ${s.length} 字符，点击「编辑连接信息」可查看或修改</span>`
  }
  if (apiKeyConfigured) {
    return '<span class="models-apikey-saved">已配置</span><span class="models-apikey-meta"> · 密钥已保存在服务端（脱敏不可见），留空编辑表示不修改</span>'
  }
  if (optional) {
    return '<span class="models-apikey-saved">无需密钥</span><span class="models-apikey-hint">（本机服务默认不鉴权）</span>'
  }
  return '<span class="models-apikey-empty">未填写</span><span class="models-apikey-hint">（无需鉴权时可留空）</span>'
}

// 渲染当前主模型状态栏（紧凑单行）
function renderDefaultBar(page, state) {
  const bar = page.querySelector('#default-model-bar')
  const primary = getCurrentPrimary(state.config)
  const allModels = collectAllModels(state.config)
  const fallbacks = allModels.filter(m => m.full !== primary).map(m => m.full)

  const primaryLabel = primary ? resolveModelDisplayLabel(state.config, primary) : ''
  bar.innerHTML = `
    <div class="models-primary-inner">
      <span class="models-primary-label">\u4e3b\u6a21\u578b</span>
      <code class="models-primary-id">${escHtml(primaryLabel || primary || '\u672a\u914d\u7f6e')}</code>
      ${fallbacks.length ? `<span class="models-primary-meta">\u5907\u9009 ${fallbacks.length} \u4e2a</span>` : ''}
    </div>
  `
}

/** 右侧详情区：当前连接下的模型列表 */
function buildSingleProviderSectionHTML(key, state, primary) {
  const providers = state.config?.models?.providers || {}
  const p = providers[key]
  if (!p) return ''
  const models = p.models || []
  const batchRow =
    models.length >= 2
      ? `
        <div class="models-list-toolbar">
          <button type="button" class="btn btn-sm btn-secondary" data-action="batch-test">批量测试</button>
          <button type="button" class="btn btn-sm btn-secondary" data-action="select-all">全选</button>
          <button type="button" class="btn btn-sm btn-danger" data-action="batch-delete">批量删除</button>
        </div>`
      : ''

  return `
      <div class="models-provider-config-root config-section models-provider-config-root--models-only" data-provider="${escAttr(key)}">
        <section class="models-list-section" aria-labelledby="models-list-heading-${escAttr(key)}">
          <div class="config-section-title models-detail-title-row models-list-section-head">
            <h4 class="models-list-heading" id="models-list-heading-${escAttr(key)}">模型列表 <span class="models-list-count">共 ${models.length} 个</span></h4>
            <div class="models-list-head-actions">
              <button type="button" class="btn btn-sm btn-secondary" data-action="add-model">+ 添加模型</button>
            </div>
          </div>
          ${batchRow}
          <div class="provider-models">
            ${renderModelCards(key, models, primary)}
          </div>
        </section>
      </div>
    `
}

function bindVendorDetailActions(mount, page, state) {
  if (!mount) return
  mount.querySelectorAll('[data-select-connection]').forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.selectConnection
      if (!key || key === state.selectedProviderKey) return
      state.selectedProviderKey = key
      renderProviders(page, state)
    }
  })
  mount.querySelectorAll('.models-connection-picker [data-action="edit-provider"], .models-connection-picker [data-action="delete-provider"]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation()
      const section = btn.closest('[data-provider]')
      if (!section) return
      const providerKey = section.dataset.provider
      const provider = state.config?.models?.providers?.[providerKey]
      if (!provider) return
      await handleAction(btn.dataset.action, btn, null, section, providerKey, provider, page, state)
    }
  })
  mount.querySelectorAll('[data-action="add-connection"][data-provider]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation()
      const pk = btn.dataset.provider
      if (pk) addProviderConnection(page, state, pk)
    }
  })
}

// 渲染左侧厂商目录 + 右侧该厂商下的具体配置
function renderProviders(page, state) {
  const railEl = page.querySelector('#models-provider-rail')
  const detailMount = page.querySelector('#models-detail-inner')
  if (!railEl || !detailMount) return

  const providers = state.config?.models?.providers || {}
  const primary = getCurrentPrimary(state.config)
  const primaryPk = primaryProviderKeyFromPrimary(state.config, primary)

  reconcileModelPageSelection(state, providers)

  const parts = []
  for (const pr of VENDOR_PRESETS) {
    const pks = findProviderKeysForPreset(providers, pr)
    const active = state.selectedVendorPreset === pr.key
    const configured = pks.length > 0
    const n = configured ? pks.reduce((sum, pk) => sum + (providers[pk].models || []).length, 0) : 0
    const connCount = pks.length
    const subText = configured
      ? (connCount > 1 ? `${connCount} \u5957\u8fde\u63a5 \u00b7 ${n} \u4e2a\u6a21\u578b` : `${n} \u4e2a\u6a21\u578b`)
      : '\u672a\u914d\u7f6e'
    const hostsPrimary = !!(configured && primaryPk && pks.includes(primaryPk))
    parts.push(`<button type="button" class="models-vendor-item${active ? ' active' : ''}${configured ? ' configured' : ''}${hostsPrimary ? ' models-vendor-item--primary-host' : ''}" data-vendor-preset="${escAttr(pr.key)}">
      <span class="models-vendor-icon" aria-hidden="true">${vendorBrandIcon(pr.key)}</span>
      <span class="models-vendor-meta">
        <span class="models-vendor-label-row">
          <span class="models-vendor-label">${escHtml(pr.label)}</span>
          ${hostsPrimary ? '<span class="models-vendor-primary-badge" title="当前主模型使用此连接">主模型</span>' : ''}
        </span>
        <span class="models-vendor-sub">${subText}</span>
      </span>
    </button>`)
  }

  railEl.innerHTML = parts.join('')

  let detailHtml
  if (state.selectedVendorPreset) {
    const pr = VENDOR_PRESETS.find((p) => p.key === state.selectedVendorPreset)
    const pks = pr ? findProviderKeysForPreset(providers, pr) : []
    if (pks.length) {
      detailHtml = buildVendorDetailHTML(pr, state, primary)
    } else if (pr) {
      detailHtml = renderVendorInlineSetupForm(pr, state)
    } else {
      detailHtml =
        '<div class="models-vendor-empty"><p class="form-hint">请选择左侧厂商。</p></div>'
    }
  } else {
    detailHtml =
      '<div class="models-vendor-empty"><p class="form-hint">请点击「+ 添加服务商」或选择左侧厂商。</p></div>'
  }

  detailMount.innerHTML = detailHtml
  const prInline = VENDOR_PRESETS.find((p) => p.key === state.selectedVendorPreset)
  if (prInline && !findProviderKeysForPreset(providers, prInline).length) {
    bindVendorUrlModeRadios(detailMount, prInline)
  }
  bindVendorDetailActions(detailMount, page, state)
  const listEl = detailMount.querySelector('#providers-list')
  if (listEl) bindProviderButtons(listEl, page, state)
  updateModelsToolbarMode(page, state)
}

/** 按右侧内容切换：内联配置时隐藏主模型摘要 */
function updateModelsToolbarMode(page, state) {
  const providers = state.config?.models?.providers || {}
  let mode
  if (state.selectedVendorPreset) {
    const pr = VENDOR_PRESETS.find((p) => p.key === state.selectedVendorPreset)
    if (pr && findProviderKeysForPreset(providers, pr).length) mode = 'detail'
    else if (pr) mode = 'inline-setup'
    else mode = 'idle'
  } else {
    mode = 'idle'
  }

  const primaryBar = page.querySelector('#default-model-bar')
  const titleText = page.querySelector('#models-title-text')
  const addBtn = page.querySelector('#btn-add-provider')

  if (primaryBar) primaryBar.hidden = mode === 'inline-setup'
  if (addBtn) addBtn.hidden = mode === 'inline-setup'

  // 更新标题栏文字
  if (titleText) {
    if (mode === 'inline-setup') {
      const pr = VENDOR_PRESETS.find((p) => p.key === state.selectedVendorPreset)
      titleText.textContent = pr ? pr.label + ' \u914d\u7f6e' : '\u6a21\u578b\u914d\u7f6e'
    } else if (mode === 'detail') {
      const pr = VENDOR_PRESETS.find((p) => p.key === state.selectedVendorPreset)
      if (pr && state.selectedProviderKey) {
        const pks = findProviderKeysForPreset(providers, pr)
        if (pks.length > 1) {
          titleText.textContent = `${pr.label} · ${resolveConnectionLabel(state.selectedProviderKey, providers, pr.key)}`
        } else {
          titleText.textContent = displayTitleForProvider(state.selectedProviderKey, providers)
        }
      } else {
        titleText.textContent = displayTitleForProvider(state.selectedProviderKey, providers)
      }
    } else {
      titleText.textContent = '\u6a21\u578b\u914d\u7f6e'
    }
  }
}

// 渲染模型卡片（批量选择 checkbox）
function renderModelCards(providerKey, models, primary) {
  if (!models.length) {
    return '<div class="models-list-empty">尚未添加模型。请确认上方「连接与鉴权」配置正确，然后点击「+ 添加模型」。</div>'
  }
  return models.map((m) => {
    const configName = modelConfigName(m)
    const modelId = modelProviderId(m)
    const displayName = resolveModelDisplayName(typeof m === 'string' ? m : m?.name, modelId)
    const full = configName
    const isPrimary = full === primary
    const meta = []
    if (modelId && displayName !== modelId) meta.push(`ID: ${modelId}`)
    else if (modelId) meta.push(modelId)
    const minTier = m?.planConfig?.min_tier
    if (minTier) {
      const need = PLAN_TIER_SHORT[String(minTier).toLowerCase()] || minTier
      meta.push(`套餐门禁 ${need}+`)
    }
    if (m.contextWindow) meta.push((m.contextWindow / 1000) + 'K 上下文')
    // 测试状态标签：成功显示耗时，失败显示不可用
    let latencyTag = ''
    const runtimeUnavailable = m.availabilityStatus === 'unavailable'
    if (runtimeUnavailable) {
      const reason = String(m.unavailableReason || '上游不可用').replace(/"/g, '&quot;')
      latencyTag = `<span style="font-size:var(--font-size-xs);padding:1px 6px;border-radius:var(--radius-sm);background:var(--error-muted, #fee2e2);color:var(--error)" title="${reason}">不可用</span>`
    } else if (m.testStatus === 'fail') {
      latencyTag = `<span style="font-size:var(--font-size-xs);padding:1px 6px;border-radius:var(--radius-sm);background:var(--error-muted, #fee2e2);color:var(--error)" title="${(m.testError || '').replace(/"/g, '&quot;')}">不可用</span>`
    } else if (m.latency != null) {
      const color = m.latency < 3000 ? 'success' : m.latency < 8000 ? 'warning' : 'error'
      const bg = color === 'success' ? 'var(--success-muted)' : color === 'warning' ? 'var(--warning-muted, #fef3c7)' : 'var(--error-muted, #fee2e2)'
      const fg = color === 'success' ? 'var(--success)' : color === 'warning' ? 'var(--warning, #d97706)' : 'var(--error)'
      latencyTag = `<span style="font-size:var(--font-size-xs);padding:1px 6px;border-radius:var(--radius-sm);background:${bg};color:${fg}">${(m.latency / 1000).toFixed(1)}s</span>`
    }
    const testTime = m.lastTestAt ? formatTestTime(m.lastTestAt) : ''
    if (testTime) meta.push(testTime)
    if (runtimeUnavailable && m.unavailableReason) {
      meta.push(`原因：${m.unavailableReason}`)
    }
    return `
      <div class="model-card${isPrimary ? ' model-card--primary' : ''}${runtimeUnavailable ? ' model-card--unavailable' : ''}" data-model-id="${escAttr(configName)}" data-full="${escAttr(full)}">
        <span class="drag-handle" title="\u62d6\u62fd\u6392\u5e8f">⋮⋮</span>
        <input type="checkbox" class="model-checkbox" data-model-id="${escAttr(configName)}">
        <div class="model-info">
          <div class="model-info-top">
            <code class="model-id-text">${escHtml(displayName)}</code>
            ${isPrimary ? '<span class="tag tag--primary">\u4e3b\u6a21\u578b</span>' : ''}
            ${planModelBadgeHtml(m)}
            ${m.reasoning ? '<span class="tag tag--reasoning">\u63a8\u7406</span>' : ''}
            ${latencyTag}
          </div>
          ${meta.length ? `<div class="model-meta">${meta.map((x) => escHtml(String(x))).join(' · ')}</div>` : ''}
        </div>
        <div class="model-actions">
          <button type="button" class="btn btn-xs btn-secondary" data-action="test-model">\uD83D\uDCE1</button>
          ${runtimeUnavailable ? '<button type="button" class="btn btn-xs btn-outline" data-action="clear-unavailable" title="清除不可用标记">恢复</button>' : ''}
          ${!isPrimary ? '<button type="button" class="btn btn-xs btn-outline" data-action="set-primary">\u4e3b\u6a21</button>' : ''}
          <button type="button" class="btn btn-xs btn-ghost" data-action="edit-model">\u270E</button>
          <button type="button" class="btn btn-xs btn-danger" data-action="delete-model">\u2715</button>
        </div>
      </div>
    `
  }).join('')
}

// 格式化测试时间为相对时间
function formatTestTime(ts) {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚测试'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前测试`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前测试`
  return `${Math.floor(diff / 86400000)} 天前测试`
}

// 根据 model-id 找到原始 index
function findModelIdx(provider, configName) {
  return (provider.models || []).findIndex((m) => modelConfigName(m) === configName)
}

// ===== 自动保存 + 撤销机制 =====

// 保存快照到撤销栈（变更前调用）
function pushUndo(state) {
  state.undoStack.push(JSON.parse(JSON.stringify(state.config)))
  if (state.undoStack.length > 20) state.undoStack.shift()
}

// 撤销上一步
async function undo(page, state) {
  if (!state.undoStack.length) return
  state.config = state.undoStack.pop()
  renderProviders(page, state)
  renderDefaultBar(page, state)
  updateUndoBtn(page, state)
  await doAutoSave(state)
  toast('已撤销', 'info')
}

// 自动保存（防抖 300ms）
let _saveTimer = null
let _pendingSaveState = null
let _batchTestAbort = null // 批量测试终止控制器

function notifyModelsUpdated() {
  try {
    window.dispatchEvent(new CustomEvent('evopanel:models-updated'))
  } catch {
    /* ignore */
  }
}

function resetStuckDragCards() {
  document.querySelectorAll('.model-card').forEach((card) => {
    if (card.style.position === 'fixed') {
      card.style.position = ''
      card.style.left = ''
      card.style.top = ''
      card.style.width = ''
      card.style.zIndex = ''
      card.style.opacity = ''
      card.style.boxShadow = ''
      card.style.pointerEvents = ''
    }
  })
}

export function cleanup() {
  clearTimeout(_saveTimer)
  _saveTimer = null
  const pending = _pendingSaveState
  _pendingSaveState = null
  if (pending) {
    // 离开页面前必须落盘，否则 300ms 防抖会被取消导致网关未收到新模型
    void doAutoSave(pending)
  }
  if (_batchTestAbort) { _batchTestAbort.abort = true; _batchTestAbort = null }
  resetStuckDragCards()
  cleanupMediaSettings()
  if (_plansTabMod) {
    try {
      _plansTabMod.cleanup()
    } catch {
      /* ignore */
    }
    _plansTabMod = null
  }
}
function autoSave(state) {
  _pendingSaveState = state
  clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    void doAutoSave(state)
  }, 300)
}

/** 保存前规范化所有服务商的 baseUrl，确保 Gateway 能正确调用 */
function normalizeProviderUrls(config) {
  const providers = config?.models?.providers
  if (!providers) return
  for (const [, p] of Object.entries(providers)) {
    if (!p.baseUrl) continue
    let url = p.baseUrl.replace(/\/+$/, '')
    // 去掉尾部的已知端点路径（用户可能粘贴了完整 URL）
    for (const suffix of ['/api/chat', '/api/generate', '/api/tags', '/api', '/chat/completions', '/completions', '/responses', '/messages', '/models']) {
      if (url.endsWith(suffix)) { url = url.slice(0, -suffix.length); break }
    }
    url = url.replace(/\/+$/, '')
    const apiType = (p.api || 'openai-completions').toLowerCase()
    if (apiType === 'anthropic-messages') {
      // Official: SDK base = https://api.anthropic.com (no /v1); SDK appends /v1/messages.
      // Legacy panel rows may have …/v1 — strip so ChatAnthropic does not hit …/v1/v1/messages.
      if (url.endsWith('/v1')) url = url.slice(0, -3).replace(/\/+$/, '')
    } else if (apiType !== 'google-gemini' && apiType !== 'google-generative-ai') {
      // Ollama 端口检测：11434 默认需要加 /v1
      if (/:11434$/.test(url) && !url.endsWith('/v1')) url += '/v1'
      // 不再强制追加 /v1，尊重用户填写的 URL（火山引擎等第三方用 /v3 等路径）
    }
    p.baseUrl = url
  }
}

function apiTypeToUse(apiType) {
  const t = String(apiType || '').toLowerCase()
  if (t === 'anthropic-messages') return 'langchain_anthropic:ChatAnthropic'
  if (t === 'google-generative-ai') return 'langchain_google_genai:ChatGoogleGenerativeAI'
  // openai-completions / openai-responses / 默认：OpenAI 兼容
  return 'langchain_openai:ChatOpenAI'
}

function buildThinkingConfig(providerKey, provider, supportsThinking) {
  if (!supportsThinking) return undefined

  // Aliyun DashScope(OpenAI-compatible) expects `extra_body.enable_thinking`.
  if (isAliyunLikeProvider(providerKey, provider)) {
    return { extra_body: { enable_thinking: true } }
  }

  // Native ChatAnthropic: top-level `thinking` constructor param (not extra_body).
  if (String(provider?.api || '').toLowerCase() === 'anthropic-messages') {
    return { thinking: { type: 'enabled' } }
  }

  // Generic OpenAI-compatible thinking switch.
  return { extra_body: { thinking: { type: 'enabled' } } }
}

/** 百炼 / DashScope：可走 extra_body.enable_search 原生联网 */
function isAliyunLikeProvider(providerKey, provider) {
  const key = String(providerKey || '').toLowerCase()
  const baseUrl = String(provider?.baseUrl || '').toLowerCase()
  return key.includes('aliyun') || baseUrl.includes('dashscope') || baseUrl.includes('aliyuncs.com')
}

function nativeWebSearchCheckboxHtml({ checked = false, enabled = false } = {}) {
  const disabledAttr = enabled ? '' : ' disabled'
  const checkedAttr = checked && enabled ? ' checked' : ''
  return `
    <label class="models-edit-checkbox-item${!enabled ? ' is-disabled' : ''}" title="${enabled ? '' : '仅阿里云百炼 / DashScope 支持模型参数联网'}">
      <input type="checkbox" data-name="enableWebSearch"${checkedAttr}${disabledAttr}>
      <span>厂商原生联网</span>
    </label>
  `
}

const NATIVE_WEB_SEARCH_HINT =
  '仅百炼有效（extra_body.enable_search）。Agent 已挂 tools 时厂商可能忽略；可靠联网请开角色 web_search 工具。'

const THINKING_MODE_OPTIONS = [
  { value: 'auto', label: '自动（按会话 / Auto 决策）' },
  { value: 'enabled', label: '默认开启' },
  { value: 'disabled', label: '默认关闭' },
]

/** 模型设置页可选思考强度（与聊天菜单 low/medium/high 对齐） */
const MODEL_THINKING_LEVEL_OPTIONS = [
  { key: 'low', label: 'Low（轻度）' },
  { key: 'medium', label: 'Medium（中度）' },
  { key: 'high', label: 'High（深度）' },
]

function normalizeThinkingLevelKey(raw) {
  const s = String(raw || '').trim().toLowerCase().replace('x-high', 'xhigh')
  if (s === 'low' || s === 'medium' || s === 'high') return s
  if (s === 'minimal' || s === 'max' || s === 'xhigh') return 'low'
  return null
}

function normalizeThinkingSupportedLevels(levels) {
  const out = []
  for (const raw of Array.isArray(levels) ? levels : []) {
    const n = normalizeThinkingLevelKey(raw)
    if (n && !out.includes(n)) out.push(n)
  }
  return out.length ? out : ['low', 'medium', 'high']
}

function readDefaultThinkingMode(thinking) {
  const raw = String(thinking?.default_mode || thinking?.defaultMode || 'auto').trim().toLowerCase()
  if (raw === 'enabled' || raw === 'disabled') return raw
  return 'auto'
}

/** 模型默认思考强度（单选）；旧配置仅有 supported_levels 时取唯一项或 medium */
function readDefaultThinkingLevel(thinking) {
  const fromDefault = normalizeThinkingLevelKey(thinking?.default_level || thinking?.defaultLevel)
  if (fromDefault) return fromDefault
  const supported = normalizeThinkingSupportedLevels(thinking?.supported_levels || thinking?.supportedLevels)
  if (supported.length === 1) return supported[0]
  return 'medium'
}

function buildThinkingUiConfig(defaultLevel, defaultMode) {
  const level = normalizeThinkingLevelKey(defaultLevel) || 'medium'
  return {
    // 聊天菜单仍可切换三级；此处只固定模型默认强度
    supported_levels: ['low', 'medium', 'high'],
    default_level: level,
    default_mode: defaultMode || 'auto',
  }
}

function thinkingLevelRadiosHtml(selectedLevel, groupName = 'defaultThinkingLevel') {
  const selected = normalizeThinkingLevelKey(selectedLevel) || 'medium'
  return `<div class="models-edit-thinking-levels-grid" role="radiogroup" aria-label="默认思考强度">
    ${MODEL_THINKING_LEVEL_OPTIONS.map((l) => `
      <label class="models-edit-checkbox-item">
        <input type="radio" name="${groupName}" data-thinking-level="${l.key}" value="${l.key}" ${selected === l.key ? 'checked' : ''}>
        <span>${l.label}</span>
      </label>
    `).join('')}
  </div>`
}

function readThinkingLevelFromOverlay(overlay) {
  const checked = overlay.querySelector('[data-thinking-level]:checked')
  return normalizeThinkingLevelKey(checked?.dataset?.thinkingLevel || checked?.value) || 'medium'
}

function thinkingModeSelectHtml(selectedMode, fieldName = 'defaultThinkingMode') {
  const mode = selectedMode || 'auto'
  return `<select class="form-input" data-name="${fieldName}">
    ${THINKING_MODE_OPTIONS.map(o => `
      <option value="${o.value}" ${mode === o.value ? 'selected' : ''}>${o.label}</option>
    `).join('')}
  </select>`
}

function bindThinkingFieldsVisibility(overlay) {
  const reasoningCb = overlay.querySelector('[data-name="reasoning"]')
  const fields = overlay.querySelector('.models-edit-thinking-fields')
  if (!reasoningCb || !fields) return
  const sync = () => {
    fields.style.display = reasoningCb.checked ? '' : 'none'
  }
  reasoningCb.addEventListener('change', sync)
  sync()
}

function buildGatewayModelRequest(providerKey, provider, m, usedNames, fallbackModels = []) {
  const modelId = modelProviderId(m)
  if (!modelId) return null

  let configName = typeof m === 'object' ? String(m.configName || '').trim() : ''
  const displayName = resolveModelDisplayName(typeof m === 'object' ? m.name : '', modelId)
  if (!configName || !isValidConfigName(configName)) {
    configName = deriveConfigName(displayName, providerKey, modelId, usedNames)
    if (typeof m === 'object') m.configName = configName
  } else {
    usedNames.add(configName)
  }

  const input = (m && m.input) || []
  const supports_vision = Array.isArray(input) ? input.includes('image') : false
  const supports_thinking = Boolean(m?.reasoning)
  const when_thinking_enabled = buildThinkingConfig(providerKey, provider, supports_thinking)
  const enable_web_search = Boolean(m?.enableWebSearch) && isAliyunLikeProvider(providerKey, provider)

  // Build thinking config with default level and mode
  let thinkingConfig = null
  if (supports_thinking) {
    const thinking = m?.thinking || {}
    const defaultLevel = readDefaultThinkingLevel(thinking)
    const defaultMode = readDefaultThinkingMode(thinking)
    thinkingConfig = buildThinkingUiConfig(defaultLevel, defaultMode)
  }

  const fbList = Array.isArray(fallbackModels)
    ? fallbackModels.map((x) => String(x || '').trim()).filter((x) => x && x !== configName)
    : []

  const req = {
    name: configName,
    vendor: providerKey, // evoflow_models.vendor = Panel 连接键
    model: modelId,
    display_name: displayName,
    description: typeof m === 'object' ? (m.description || null) : null,
    base_url: provider?.baseUrl || '',
    use: apiTypeToUse(provider?.api),
    request_timeout: Number.isFinite(Number(m?.requestTimeout)) ? Number(m.requestTimeout) : 600,
    max_retries: Number.isFinite(Number(m?.maxRetries)) ? Number(m.maxRetries) : 2,
    temperature: m?.temperature === null ? null : (Number.isFinite(Number(m?.temperature)) ? Number(m.temperature) : undefined),
    supports_vision,
    supports_thinking,
    supports_reasoning_effort: Boolean(m?.reasoning),
    enable_web_search,
    when_thinking_enabled,
    thinking: thinkingConfig,
    fallback_models: fbList,
  }

  if (enable_web_search && m?.webSearchOptions && typeof m.webSearchOptions === 'object') {
    req.web_search_options = m.webSearchOptions
  }

  const apiKeyRaw = String(provider?.apiKey ?? '').trim()
  // 无本地明文时省略 api_key：create 时后端从同连接已有模型行继承；update 时保留 DB 原值
  if (apiKeyRaw && !isMaskedGatewayApiKey(apiKeyRaw)) {
    req.api_key = apiKeyRaw
  }

  const contextWindow = Number(m?.contextWindow)
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    req.context_length = contextWindow
  }

  const inputCtxLen = Number(m?.inputContextLength)
  if (Number.isFinite(inputCtxLen) && inputCtxLen > 0) {
    req.input_context_length = inputCtxLen
  }

  const outputCtxLen = Number(m?.outputContextLength)
  if (Number.isFinite(outputCtxLen) && outputCtxLen > 0) {
    req.output_context_length = outputCtxLen
    req.max_tokens = outputCtxLen
  } else {
    req.max_tokens = DEFAULT_MODEL_MAX_OUTPUT_TOKENS
  }

  return req
}

async function syncModelsToGateway(state) {
  const providers = state?.config?.models?.providers || {}
  const providerKeys = Object.keys(providers)
  if (!providerKeys.length) return

  try {
    await api.cleanupStaleModels()
  } catch {
    /* best-effort legacy cleanup */
  }

  // Panel 期望写入 evoflow_models 的 model name 集合
  const desiredNames = new Set()
  const desiredReqByName = new Map()
  const usedConfigNames = collectUsedConfigNames(state?.config || {})
  const managedVendorSet = new Set(providerKeys)
  const managedScopeSet = new Set()

  // First pass: build requests without fallbacks to lock config names
  const pending = []
  for (const providerKey of providerKeys) {
    const provider = providers[providerKey] || {}
    managedScopeSet.add(connectionScopeFingerprint(provider.baseUrl, provider.api))
    for (const m of provider.models || []) {
      const req = buildGatewayModelRequest(providerKey, provider, m, usedConfigNames, [])
      if (!req) continue
      pending.push(req)
      desiredNames.add(req.name)
    }
  }

  // Each model falls back to every other configured model (stable name order)
  const allNames = [...desiredNames]
  for (const req of pending) {
    req.fallback_models = allNames.filter((n) => n !== req.name)
    desiredReqByName.set(req.name, req)
  }

  const list = await api.listModels()
  const existingModels = Array.isArray(list?.models) ? list.models : []
  const existingByName = new Map(existingModels.map((m) => [m?.name, m]))

  // Delete removed models (match by vendor key or endpoint scope for legacy rows)
  for (const em of existingModels) {
    if (isEmbeddingModel(em)) continue
    const en = em?.name
    if (!en) continue
    const ev = em?.vendor
    const isManaged = managedVendorSet.has(ev) || managedScopeSet.has(gatewayModelScopeFingerprint(em))
    if (!isManaged) continue
    if (desiredNames.has(en)) continue
    await api.deleteModel(en)
  }

  // Create or update desired models
  for (const [name, req] of desiredReqByName.entries()) {
    if (existingByName.has(name)) {
      await api.updateModel(name, req)
    } else {
      await api.createModel(req)
    }
  }

  // 写入 evoflow_models 主模型
  const primaryConfigName = resolvePrimaryConfigName(state?.config, getCurrentPrimary(state?.config))
  if (primaryConfigName && desiredNames.has(primaryConfigName)) {
    await api.setPrimaryModel(primaryConfigName)
  } else if (desiredNames.size > 0) {
    const first = desiredReqByName.values().next().value
    if (first?.name) {
      try {
        await api.setPrimaryModel(first.name)
      } catch {
        /* ignore */
      }
    }
  }
}

// 仅保存配置，不重启 Gateway（用于测试结果等元数据持久化）
async function saveConfigOnly(state) {
  try {
    const primary = getCurrentPrimary(state.config)
    if (primary) applyDefaultModel(state)
    normalizeProviderUrls(state.config)
    persistProviderDisplayNames(state.config?.models?.providers || {})
    await syncConnectionsToGateway(state)
    await syncModelsToGateway(state)
    notifyModelsUpdated()
  } catch (e) {
    toast('保存失败: ' + e, 'error')
  }
}

async function doAutoSave(state) {
  try {
    const primary = getCurrentPrimary(state.config)
    if (primary) applyDefaultModel(state)
    normalizeProviderUrls(state.config)
    persistProviderDisplayNames(state.config?.models?.providers || {})
    await syncConnectionsToGateway(state)
    await syncModelsToGateway(state)
    notifyModelsUpdated()
  } catch (e) {
    toast('自动保存失败: ' + e, 'error')
  }
}

// 更新撤销按钮状态
function updateUndoBtn(page, state) {
  const btn = page.querySelector('#btn-undo')
  if (!btn) return
  const n = state.undoStack.length
  btn.disabled = !n
  btn.textContent = n ? `↩ 撤销 (${n})` : '↩ 撤销'
}

// 渲染完成后，直接给每个 [data-action] 按钮绑定 onclick
function bindProviderButtons(listEl, page, state) {
  // 绑定拖拽排序（Pointer 事件实现，兼容 Tauri WebView2/WKWebView）
  listEl.querySelectorAll('.provider-models').forEach(container => {
    let dragged = null
    let placeholder = null
    let startY = 0

    // 仅从拖拽手柄启动
    container.addEventListener('pointerdown', e => {
      const handle = e.target.closest('.drag-handle')
      if (!handle) return
      const card = handle.closest('.model-card')
      if (!card) return

      e.preventDefault()
      dragged = card
      startY = e.clientY

      // 创建占位符
      placeholder = document.createElement('div')
      placeholder.style.cssText = `height:${card.offsetHeight}px;border:2px dashed var(--border);border-radius:var(--radius-md);margin-bottom:8px;background:var(--bg-secondary)`
      card.after(placeholder)

      // 浮动拖拽元素
      const rect = card.getBoundingClientRect()
      card.style.position = 'fixed'
      card.style.left = rect.left + 'px'
      card.style.top = rect.top + 'px'
      card.style.width = rect.width + 'px'
      card.style.zIndex = '9999'
      card.style.opacity = '0.85'
      card.style.boxShadow = '0 8px 24px rgba(0,0,0,0.2)'
      card.style.pointerEvents = 'none'
      card.setPointerCapture(e.pointerId)
      window.addEventListener('pointerup', finishDrag)
      window.addEventListener('blur', finishDrag)
    })

    container.addEventListener('pointermove', e => {
      if (!dragged || !placeholder) return
      e.preventDefault()

      // 移动浮动元素
      const dy = e.clientY - startY
      const origTop = parseFloat(dragged.style.top)
      dragged.style.top = (origTop + dy) + 'px'
      startY = e.clientY

      // 查找目标位置
      const siblings = [...container.querySelectorAll('.model-card:not([style*="position: fixed"])')].filter(c => c !== dragged)
      for (const sibling of siblings) {
        const rect = sibling.getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        if (e.clientY < midY) {
          sibling.before(placeholder)
          return
        }
      }
      // 放到最后
      if (siblings.length) siblings[siblings.length - 1].after(placeholder)
    })

    const finishDrag = () => {
      if (!dragged || !placeholder) return

      dragged.style.position = ''
      dragged.style.left = ''
      dragged.style.top = ''
      dragged.style.width = ''
      dragged.style.zIndex = ''
      dragged.style.opacity = ''
      dragged.style.boxShadow = ''
      dragged.style.pointerEvents = ''

      placeholder.before(dragged)
      placeholder.remove()

      const section = container.closest('[data-provider]')
      if (section) {
        const providerKey = section.dataset.provider
        const provider = state.config.models.providers[providerKey]
        if (provider) {
          const newOrderIds = [...container.querySelectorAll('.model-card')].map((c) => c.dataset.modelId)
          pushUndo(state)
          const oldModels = [...provider.models]
          provider.models = newOrderIds.map((id) => oldModels.find((m) => modelConfigName(m) === id))
          autoSave(state)
        }
      }

      dragged = null
      placeholder = null
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('blur', finishDrag)
    }

    container.addEventListener('pointerup', finishDrag)
    container.addEventListener('pointercancel', finishDrag)
  })

  // 绑定按钮
  listEl.querySelectorAll('button[data-action], input[data-action]').forEach(btn => {
    const action = btn.dataset.action
    const section = btn.closest('[data-provider]')
    if (!section) return
    const providerKey = section.dataset.provider
    const provider = state.config.models.providers[providerKey]
    if (!provider) return
    const card = btn.closest('.model-card')

    if (action === 'connection-name') {
      const saveName = () => {
        const next = btn.value.trim()
        const prev = String(provider.displayName || '').trim()
        if (next === prev) return
        pushUndo(state)
        setProviderDisplayName(state, providerKey, next)
        renderProviders(page, state)
        updateUndoBtn(page, state)
        autoSave(state)
        toast(next ? `连接已命名为「${next}」` : '已恢复默认名称', 'info')
      }
      btn.onblur = saveName
      btn.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          btn.blur()
        }
      }
      return
    }

        // checkbox 改变时不需要阻止冒泡，由 handleAction 内部处理
    if (btn.type === 'checkbox') {
      btn.onchange = (e) => {
        handleAction(action, btn, card, section, providerKey, provider, page, state)
      }
    } else {
      btn.onclick = (e) => {
        e.stopPropagation()
        handleAction(action, btn, card, section, providerKey, provider, page, state)
      }
    }
  })
}

// 统一处理按钮动作
async function handleAction(action, btn, card, section, providerKey, provider, page, state) {
  switch (action) {
    case 'edit-provider':
      editProvider(page, state, providerKey)
      break
    case 'add-connection':
      addProviderConnection(page, state, providerKey)
      break
    case 'add-model':
      addModel(page, state, providerKey)
      break
    case 'delete-provider': {
      const provs = state.config.models.providers || {}
      const disp = displayTitleForProvider(providerKey, provs)
      const pr = VENDOR_PRESETS.find((p) => providerKeyBelongsToPreset(providerKey, p.key))
      const siblingCount = pr ? findProviderKeysForPreset(provs, pr).length : 1
      const confirmMsg = siblingCount > 1
        ? `确定删除连接「${resolveConnectionLabel(providerKey, provs, pr.key)}」及其所有模型？`
        : `确定删除「${disp}」及其所有模型？`
      const yes = await showConfirm(confirmMsg)
      if (!yes) return
      pushUndo(state)
      delete state.config.models.providers[providerKey]
      const remainingProviders = state.config.models.providers || {}
      if (pr && findProviderKeysForPreset(remainingProviders, pr).length > 0) {
        state.selectedVendorPreset = pr.key
        reconcileModelPageSelection(state, remainingProviders)
      } else if (pr) {
        state.selectedVendorPreset = pr.key
        state.selectedProviderKey = null
      } else {
        pickDefaultVendorSelection(state, remainingProviders)
      }
      renderProviders(page, state)
      renderDefaultBar(page, state)
      updateUndoBtn(page, state)
      // 显式删除连接及其名下模型（后端按 vendor 精确匹配，避免残留模型被刷新时重建）
      try {
        await api.deleteModelConnection(providerKey)
      } catch (e) {
        // 连接已不存在（404）等同删除成功；其余错误提示但允许前端继续
        if (e?.status !== 404) {
          toast('删除连接失败: ' + (e?.message || e), 'error')
        }
      }
      autoSave(state)
      const deletedLabel = siblingCount > 1 && pr
        ? resolveConnectionLabel(providerKey, remainingProviders, pr.key)
        : disp
      toast(`已删除「${deletedLabel}」`, 'info')
      break
    }
    case 'select-all':
      handleSelectAll(section)
      break
    case 'batch-delete':
      handleBatchDelete(section, page, state, providerKey)
      break
    case 'batch-test':
      handleBatchTest(section, state, providerKey)
      break
    case 'delete-model': {
      if (!card) return
      const configName = card.dataset.modelId
      const label = resolveModelDisplayLabel(state.config, configName)
      const yes = await showConfirm(`确定删除模型「${label}」？`)
      if (!yes) return
      pushUndo(state)
      const idx = findModelIdx(provider, configName)
      if (idx >= 0) provider.models.splice(idx, 1)
      renderProviders(page, state)
      renderDefaultBar(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
      toast(`已删除 ${label}`, 'info')
      break
    }
    case 'edit-model': {
      if (!card) return
      const idx = findModelIdx(provider, card.dataset.modelId)
      if (idx >= 0) editModel(page, state, providerKey, idx)
      break
    }
    case 'toggle-vision': {
      if (!card) return
      const idx = findModelIdx(provider, card.dataset.modelId)
      if (idx < 0) return
      const model = provider.models[idx]
      if (typeof model === 'string') return
      pushUndo(state)
      setModelVision(model, Boolean(btn.checked))
      renderProviders(page, state)
      renderDefaultBar(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
      toast(modelSupportsVision(model) ? '已开启视觉识别' : '已关闭视觉识别', 'info')
      break
    }
    case 'set-primary': {
      if (!card) return
      pushUndo(state)
      setPrimary(state, card.dataset.full)
      renderProviders(page, state)
      renderDefaultBar(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
      toast('已设为主模型', 'success')
      break
    }
    case 'test-model': {
      if (!card) return
      const idx = findModelIdx(provider, card.dataset.modelId)
      if (idx >= 0) testModel(btn, state, providerKey, idx)
      break
    }
    case 'clear-unavailable': {
      if (!card) return
      const configName = card.dataset.modelId
      try {
        await api.clearModelUnavailable(configName)
        const idx = findModelIdx(provider, configName)
        if (idx >= 0) {
          provider.models[idx].availabilityStatus = 'available'
          provider.models[idx].unavailableReason = ''
          provider.models[idx].unavailableCode = ''
          provider.models[idx].unavailableAt = ''
        }
        renderProviders(page, state)
        notifyModelsUpdated()
        toast('已清除不可用标记', 'success')
      } catch (e) {
        toast('清除失败: ' + e, 'error')
      }
      break
    }
  }
}

// 设置主模型（仅修改 state，不写入文件）
function setPrimary(state, full) {
  if (!state.config.agents) state.config.agents = {}
  if (!state.config.agents.defaults) state.config.agents.defaults = {}
  if (!state.config.agents.defaults.model) state.config.agents.defaults.model = {}
  state.config.agents.defaults.model.primary = full
}

// 应用默认模型：primary + 其余自动成为备选
// 确保 primary 指向的模型仍然存在，不存在则自动切到第一个可用模型
function ensureValidPrimary(state) {
  const primary = resolvePrimaryConfigName(state.config, getCurrentPrimary(state.config))
  const allModels = collectAllModels(state.config)
  if (allModels.length === 0) {
    if (state.config.agents?.defaults?.model) {
      state.config.agents.defaults.model.primary = ''
    }
    return
  }
  const exists = allModels.some((m) => m.full === primary)
  if (!exists) {
    const newPrimary = allModels[0].full
    setPrimary(state, newPrimary)
    toast(`主模型已自动切换为 ${resolveModelDisplayLabel(state.config, newPrimary)}`, 'info')
  } else if (primary !== getCurrentPrimary(state.config)) {
    setPrimary(state, primary)
  }
}

function applyDefaultModel(state) {
  ensureValidPrimary(state)
  const primary = getCurrentPrimary(state.config)
  const allModels = collectAllModels(state.config)
  const fallbacks = allModels.filter(m => m.full !== primary).map(m => m.full)

  const defaults = state.config.agents.defaults
  defaults.model.primary = primary
  defaults.model.fallbacks = fallbacks

  const modelsMap = {}
  modelsMap[primary] = {}
  for (const fb of fallbacks) modelsMap[fb] = {}
  defaults.models = modelsMap

  // 同步到各 agent 的模型覆盖配置，避免 agent 级别的旧值覆盖全局默认
  const list = state.config.agents?.list
  if (Array.isArray(list)) {
    for (const agent of list) {
      if (agent.model && typeof agent.model === 'object' && agent.model.primary) {
        agent.model.primary = primary
      }
    }
  }
}

function applySelectionAfterProviderAdded(state, key) {
  const providers = state.config?.models?.providers || {}
  if (VENDOR_PRESETS.some((p) => p.key === key)) {
    state.selectedVendorPreset = key
    state.selectedProviderKey = key
    return
  }
  for (const pr of VENDOR_PRESETS) {
    if (providerKeyBelongsToPreset(key, pr.key)) {
      state.selectedVendorPreset = pr.key
      state.selectedProviderKey = key
      return
    }
  }
  for (const pr of VENDOR_PRESETS) {
    if (findProviderKeysForPreset(providers, pr).includes(key)) {
      state.selectedVendorPreset = pr.key
      state.selectedProviderKey = key
      return
    }
  }
  // 如果 key 不匹配任何预设，选中第一个已配置的预设
  const firstConfigured = VENDOR_PRESETS.find(pr => findProviderKeysForPreset(providers, pr).length)
  if (firstConfigured) {
    state.selectedVendorPreset = firstConfigured.key
    state.selectedProviderKey = findProviderKeysForPreset(providers, firstConfigured)[0]
  } else {
    state.selectedVendorPreset = VENDOR_PRESETS[0]?.key || null
    state.selectedProviderKey = null
  }
}

// 顶部按钮事件
function bindTopActions(page, state) {
  const addBtn = page.querySelector('#btn-add-provider')
  const undoBtn = page.querySelector('#btn-undo')
  if (addBtn) addBtn.onclick = () => addProvider(page, state)
  if (undoBtn) undoBtn.onclick = () => undo(page, state)

  page.addEventListener('click', (e) => {
    const plansSettingsBtn = e.target.closest('[data-action="open-plans-settings"]')
    if (plansSettingsBtn) {
      e.preventDefault()
      void switchTab(page, state, 'plan')
      return
    }
    const planBundleBtn = e.target.closest('[data-action="open-plan-bundle"]')
    if (planBundleBtn) {
      e.preventDefault()
      const catalog = planBundleBtn.getAttribute('data-catalog') || 'volcengine.agent_plan'
      openPlanBundleWizard({
        catalogId: catalog,
        existingBinding: state.planBindings?.[catalog] || null,
        onDone: async (binding) => {
          const n = Number(binding?.materialized?.chat_model_count || 0)
          toast(
            n > 0
              ? `Plan 全家桶已绑定：已配置 ${n} 个对话模型`
              : 'Plan 全家桶已绑定：对话 / 媒体 / 语音已接通',
            'success',
          )
          if (binding?.catalog_id) {
            state.planBindings = state.planBindings || {}
            state.planBindings[binding.catalog_id] = binding
          }
          // 选中火山并刷新连接列表
          state.selectedVendorPreset = 'volcengine'
          try {
            await loadConfig(page, state)
          } catch {
            renderProviders(page, state)
          }
        },
      })
      return
    }
    const saveInline = e.target.closest('[data-action="save-inline-provider"]')
    if (saveInline) {
      const root = saveInline.closest('.models-inline-setup')
      if (!root || !state.config) return
      const key = root.querySelector('[data-inline-field="key"]')?.value?.trim()
      let baseUrl = root.querySelector('[data-inline-field="baseUrl"]')?.value?.trim() ?? ''
      const apiKey = root.querySelector('[data-inline-field="apiKey"]')?.value?.trim() ?? ''
      const inlinePresetKey = root.dataset.inlinePreset || ''
      const preset = VENDOR_PRESETS.find((p) => p.key === inlinePresetKey)
      const api = preset?.api || 'openai-completions'
      baseUrl = resolveBaseUrlFromUrlMode(root, preset, 'models-inline-url-mode', baseUrl)
      if (!key) {
        toast('配置标识无效', 'warning')
        return
      }
      if ((state.config.models?.providers || {})[key]) {
        // 同厂商多套配置：key 已存在时自动追加后缀
        let suffix = 2
        while ((state.config.models?.providers || {})[`${key}-${suffix}`]) suffix++
        const finalKey = `${key}-${suffix}`
        pushUndo(state)
        if (!state.config.models) state.config.models = { mode: 'replace', providers: {} }
        if (!state.config.models.providers) state.config.models.providers = {}
        state.config.models.providers[finalKey] = buildProviderEntry({ baseUrl, apiKey, api })
        applySelectionAfterProviderAdded(state, finalKey)
        renderProviders(page, state)
        renderDefaultBar(page, state)
        updateUndoBtn(page, state)
        autoSave(state)
        const vendorLabel = VENDOR_PRESETS.find(p => p.key === key)?.label || key
        toast(`已添加 ${vendorLabel} 的第 ${suffix} 套配置`, 'success')
        return
      }
      pushUndo(state)
      if (!state.config.models) state.config.models = { mode: 'replace', providers: {} }
      if (!state.config.models.providers) state.config.models.providers = {}
      state.config.models.providers[key] = buildProviderEntry({ baseUrl, apiKey, api })
      applySelectionAfterProviderAdded(state, key)
      renderProviders(page, state)
      renderDefaultBar(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
      toast('已保存，可继续添加模型', 'success')
      return
    }

    

    const vp = e.target.closest('[data-vendor-preset]')
    if (vp && vp.closest('#models-provider-rail')) {
      const pk = vp.dataset.vendorPreset
      if (!pk) return
      showModelsBar(page, state)
      state.selectedVendorPreset = pk
      const providers = state.config?.models?.providers || {}
      const pr = VENDOR_PRESETS.find((p) => p.key === pk)
      const pks = pr ? findProviderKeysForPreset(providers, pr) : []
      state.selectedProviderKey =
        pks.includes(state.selectedProviderKey) ? state.selectedProviderKey : (pks[0] || null)
      renderProviders(page, state)
    }
  })
}

// 添加服务商（带预设快捷选择）；presetKey 可选，打开时自动选中该预设
function addProvider(page, state, presetKey) {
  // 构建预设按钮 HTML
  const presetsHtml = PROVIDER_PRESETS.filter(p => !p.hidden).map(p =>
    `<button class="btn btn-sm btn-secondary preset-btn" data-preset="${p.key}" style="margin:0 6px 6px 0">${p.label}${p.badge ? ' <span style="font-size:9px;background:var(--accent);color:#fff;padding:1px 5px;border-radius:8px;margin-left:4px">' + p.badge + '</span>' : ''}</button>`
  ).join('')

  const overlay = mountModelsModalOverlay(`
    <div class="modal" style="max-height:85vh;overflow-y:auto">
      <div class="modal-title">添加服务商</div>
      <div class="form-group">
        <label class="form-label">快捷选择</label>
        <div style="display:flex;flex-wrap:wrap">${presetsHtml}</div>
        <div class="form-hint">选择常用服务商自动填充，或手动填写下方信息</div>
        <div id="preset-detail" style="display:none;margin-top:8px;padding:10px 14px;background:var(--bg-tertiary);border-radius:var(--radius-md);font-size:var(--font-size-sm)"></div>
      </div>
      <div class="form-group" id="add-provider-key-group">
        <label class="form-label">服务商名称</label>
        <input class="form-input" data-name="key" placeholder="如 openai, newapi">
        <div class="form-hint">自定义标识名，用于区分不同来源；从上方快捷选择后将自动隐藏此项</div>
      </div>
      <div id="add-provider-url-mode-host" class="models-add-url-mode-host" hidden></div>
      <div class="form-group" id="add-provider-baseurl-group">
        <label class="form-label" id="add-provider-baseurl-label">接口地址</label>
        <input class="form-input" data-name="baseUrl" placeholder="https://api.openai.com/v1 或兼容端点">
        <div class="form-hint" id="add-provider-baseurl-hint">模型服务的 API 地址，通常以 /v1 结尾；可选官方或任意 OpenAI 兼容端点。Ollama：http://127.0.0.1:11434/v1</div>
      </div>
      <div id="add-provider-apikey-host">
        <div class="form-group">
          <label class="form-label">密钥 (API Key)</label>
          <input class="form-input" data-name="apiKey" placeholder="sk-...">
          <div class="form-hint">访问服务所需的密钥（官方或兼容端均可），留空表示无需认证。与 ChatGPT Plus 订阅无关。</div>
        </div>
      </div>
      <!-- 接口类型已由厂商预设决定；此处隐藏以兼容“快捷选择”自动填充 -->
      <input type="hidden" data-name="api" value="openai-completions" />
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
        <button class="btn btn-primary btn-sm" data-action="confirm">确定</button>
      </div>
    </div>
  `)

  const keyGroup = overlay.querySelector('#add-provider-key-group')
  const syncAddProviderKeyRow = (presetSelected) => {
    if (keyGroup) keyGroup.hidden = !!presetSelected
  }

  if (presetKey) {
    const btn = [...overlay.querySelectorAll('.preset-btn')].find((b) => b.dataset.preset === presetKey)
    if (btn) btn.click()
  } else {
    syncAddProviderKeyRow(false)
  }

  // 预设按钮点击自动填充
  overlay.querySelectorAll('.preset-btn').forEach(btn => {
    btn.onclick = () => {
      const preset = PROVIDER_PRESETS.find(p => p.key === btn.dataset.preset)
      if (!preset) return
      syncAddProviderKeyRow(true)
      overlay.querySelector('[data-name="key"]').value = preset.key
      overlay.querySelector('[data-name="baseUrl"]').value = preset.baseUrl
      overlay.querySelector('[data-name="api"]').value = preset.api
      const host = overlay.querySelector('#add-provider-url-mode-host')
      const baseEl = overlay.querySelector('[data-name="baseUrl"]')
      const baseLabel = overlay.querySelector('#add-provider-baseurl-label')
      const baseHint = overlay.querySelector('#add-provider-baseurl-hint')
      const apiKeyHost = overlay.querySelector('#add-provider-apikey-host')
      if (apiKeyHost) {
        const openaiCompat = preset.key === 'openai'
        apiKeyHost.innerHTML = apiKeyFieldGroupHtml({
          optional: !!preset.apiKeyOptional,
          placeholder: openaiCompat ? '官方 sk-…，或兼容端点发放的 Key' : 'sk-...',
          hint: preset.apiKeyOptional
            ? ''
            : (openaiCompat
              ? '官方或兼容端点的 API Key 均可；与 ChatGPT Plus 网页订阅无关，留空表示无需认证'
              : '访问服务所需的密钥，留空表示无需认证'),
          fieldAttr: 'data-name="apiKey"',
        })
      }
      if (host && baseEl && baseLabel && PROVIDER_URL_MODE_KEYS.includes(preset.key)) {
        host.hidden = false
        host.innerHTML = urlModeRadioBlockHtml(preset, 'add-provider-url-mode', 'generic')
        bindUrlModeRadiosToInput(host, preset, baseEl, 'add-provider-url-mode')
        baseLabel.textContent = 'Base URL（自定义时编辑）'
        if (baseHint) baseHint.textContent = '选择上方「通用 / Coding Plan」将自动填入对应地址；选「自定义」后可手动修改。'
      } else if (host && baseEl && baseLabel) {
        host.hidden = true
        host.innerHTML = ''
        baseEl.readOnly = false
        baseEl.style.opacity = ''
        baseLabel.textContent = '接口地址'
        if (baseHint) {
          baseHint.textContent = preset.apiKeyOptional
            ? '本机 Ollama 默认地址；一般无需修改'
            : (preset.key === 'openai'
              ? '默认可填官方 api.openai.com/v1；也可改为 NewAPI / OneAPI / Azure 兼容端 / 自建网关等任意兼容端点'
              : '模型服务的 API 地址，通常以 /v1 结尾；Ollama 可直接填 http://127.0.0.1:11434')
        }
      }
      // 高亮选中的预设
      overlay.querySelectorAll('.preset-btn').forEach(b => b.style.opacity = '0.5')
      btn.style.opacity = '1'
      // 显示服务商详情（官网、描述）
      const detailEl = overlay.querySelector('#preset-detail')
      if (detailEl) {
        if (preset.desc || preset.site) {
          let html = preset.desc ? `<div style="color:var(--text-secondary);line-height:1.6">${preset.desc}</div>` : ''
          if (preset.site) html += `<a href="${preset.site}" target="_blank" style="color:var(--accent);text-decoration:none;font-size:12px;margin-top:4px;display:inline-block">→ 访问 ${preset.label}官网</a>`
          detailEl.innerHTML = html
          detailEl.style.display = 'block'
        } else {
          detailEl.style.display = 'none'
        }
      }
    }
  })

  // 表单弹窗不因点击遮罩关闭，避免 API Key 等输入误触丢失
  overlay.querySelector('[data-action="cancel"]').onclick = () => overlay.remove()

  overlay.querySelector('[data-action="confirm"]').onclick = () => {
    const key = overlay.querySelector('[data-name="key"]').value.trim()
    let baseUrl = overlay.querySelector('[data-name="baseUrl"]').value.trim()
    const apiKey = overlay.querySelector('[data-name="apiKey"]')?.value?.trim() ?? ''
    const apiType = overlay.querySelector('[data-name="api"]').value
    const presetPick = PROVIDER_PRESETS.find((x) => x.key === key)
    if (presetPick && PROVIDER_URL_MODE_KEYS.includes(presetPick.key)) {
      const host = overlay.querySelector('#add-provider-url-mode-host')
      baseUrl = resolveBaseUrlFromUrlMode(host || overlay, presetPick, 'add-provider-url-mode', baseUrl)
    }
    if (!key) { toast('请填写服务商名称', 'warning'); return }

    // 同厂商多套配置：key 已存在时自动追加后缀（如 aliyun-2、aliyun-3）
    let finalKey = key
    const existingProviders = state.config.models?.providers || {}
    if (existingProviders[finalKey]) {
      let suffix = 2
      while (existingProviders[`${key}-${suffix}`]) suffix++
      finalKey = `${key}-${suffix}`
    }

    pushUndo(state)
    if (!state.config.models) state.config.models = { mode: 'replace', providers: {} }
    if (!state.config.models.providers) state.config.models.providers = {}
    state.config.models.providers[finalKey] = buildProviderEntry({
      baseUrl: baseUrl || '',
      apiKey,
      api: apiType,
    })
    applySelectionAfterProviderAdded(state, finalKey)
    overlay.remove()
    renderProviders(page, state)
    updateUndoBtn(page, state)
    autoSave(state)
    const addedDisp = displayTitleForProvider(finalKey, state.config.models.providers || {})
    toast(finalKey !== key ? `已添加 ${addedDisp} 的第 ${finalKey.split('-').pop()} 套配置` : `已添加服务商：${addedDisp}`, 'success')
  }

  overlay.querySelector('[data-name="key"]')?.focus()
}

// 同厂商添加第二套连接配置
function addProviderConnection(page, state, providerKey) {
  const providers = state.config?.models?.providers || {}
  const currentP = providers[providerKey]
  if (!currentP) { toast('当前厂商配置不存在', 'warning'); return }

  const preset = VENDOR_PRESETS.find(p => p.key === providerKey || providerKey.startsWith(p.key + '-') || providerKey.startsWith(p.key + '_'))
  const vendorLabel = preset ? preset.label : displayTitleForProvider(providerKey, providers)
  const vendorKey = preset ? preset.key : providerKey

  // 生成不冲突的新 key（vendor-2, vendor-3...）
  let suffix = 2
  while (providers[`${vendorKey}-${suffix}`]) suffix++
  const newKey = `${vendorKey}-${suffix}`

  // 如果厂商有 URL 模式选择（如百炼/火山），显示模式切换
  const hasUrlMode = preset && PROVIDER_URL_MODE_KEYS.includes(preset.key)
  const urlModeBlock = hasUrlMode ? urlModeRadioBlockHtml(preset, 'add-conn-url-mode', 'generic') : ''

  const defaultConnName = defaultConnectionLabel(newKey, vendorKey)

  const overlay = mountModelsModalOverlay(`
    <div class="modal" style="max-width:560px;max-height:85vh;overflow-y:auto">
      <div class="modal-title">添加连接 · ${escHtml(vendorLabel)}（第 ${suffix} 套）</div>
      <div class="form-hint" style="margin-bottom:12px">为同一厂商添加新的接口地址${preset?.apiKeyOptional ? '' : '和密钥'}，用于多账号/多区域配置。添加后可在「添加模型」或「编辑模型」时选择此连接。</div>
      <div class="form-group">
        <label class="form-label" for="add-conn-name">连接名称</label>
        <input id="add-conn-name" class="form-input" data-name="displayName" value="${escAttr(defaultConnName)}" placeholder="${escAttr(defaultConnName)}" autocomplete="off">
        <div class="form-hint">可自定义名称，便于区分多套连接</div>
      </div>
      ${urlModeBlock}
      <div class="form-group">
        <label class="form-label" for="add-conn-base">${hasUrlMode ? 'Base URL（自定义时编辑）' : '接口地址'}</label>
        <input id="add-conn-base" class="form-input" data-name="baseUrl" value="${escAttr(preset?.baseUrl || '')}" placeholder="https://api.example.com/v1" autocomplete="off">
        ${preset?.key === 'openai' ? '<div class="form-hint">可填官方地址，或 NewAPI / OneAPI / 自建网关等兼容端点；不要求 ChatGPT Plus。</div>' : ''}
      </div>
      ${apiKeyFieldGroupHtml({
        id: 'add-conn-key',
        optional: !!preset?.apiKeyOptional,
        placeholder: preset?.key === 'openai' ? '官方 sk-…，或兼容端点发放的 Key' : 'sk-...',
        hint: preset?.key === 'openai' ? '官方或兼容端密钥均可；与 ChatGPT Plus 无关，留空表示无需认证' : '留空表示无需认证',
        fieldAttr: 'data-name="apiKey"',
        label: 'API Key',
      })}
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
        <button type="button" class="btn btn-primary btn-sm" data-action="save">保存</button>
      </div>
    </div>
  `)

  // URL 模式联动
  const baseEl = overlay.querySelector('[data-name="baseUrl"]')
  if (hasUrlMode && baseEl) {
    bindUrlModeRadiosToInput(overlay, preset, baseEl, 'add-conn-url-mode')
  }

  // 表单弹窗不因点击遮罩关闭，避免 API Key 等输入误触丢失
  overlay.querySelector('[data-action="cancel"]').onclick = () => overlay.remove()
  overlay.querySelector('[data-action="save"]').onclick = () => {
    let baseUrl = overlay.querySelector('[data-name="baseUrl"]')?.value?.trim() ?? ''
    const apiKey = overlay.querySelector('[data-name="apiKey"]')?.value?.trim() ?? ''
    const api = preset?.api || currentP.api || 'openai-completions'

    if (hasUrlMode) {
      baseUrl = resolveBaseUrlFromUrlMode(overlay, preset, 'add-conn-url-mode', baseUrl)
    }
    if (!baseUrl) { toast('请填写接口地址', 'warning'); return }

    const displayNameRaw = overlay.querySelector('[data-name="displayName"]')?.value?.trim() ?? ''
    pushUndo(state)
    if (!state.config.models) state.config.models = { mode: 'replace', providers: {} }
    if (!state.config.models.providers) state.config.models.providers = {}
    const entry = buildProviderEntry({
      baseUrl,
      apiKey,
      api,
      displayName: displayNameRaw && displayNameRaw !== defaultConnName ? displayNameRaw : undefined,
    })
    state.config.models.providers[newKey] = entry
    persistProviderDisplayNames(state.config.models.providers)
    overlay.remove()
    // 切换到新添加的连接
    state.selectedProviderKey = newKey
    if (preset) state.selectedVendorPreset = preset.key
    renderProviders(page, state)
    renderDefaultBar(page, state)
    updateUndoBtn(page, state)
    autoSave(state)
    toast(`已添加 ${vendorLabel} 的第 ${suffix} 套配置`, 'success')
  }

  overlay.querySelector('[data-name="baseUrl"]')?.focus()
}

// 编辑服务商
function editProvider(page, state, providerKey) {
  const p = state.config.models.providers[providerKey]
  const vendorPreset = findVendorPresetForProviderKey(providerKey)
  const presetKey = vendorPreset?.key || providerKey
  const defaultName = defaultConnectionLabel(providerKey, presetKey)
  const nameFieldHtml = `
    <div class="form-group">
      <label class="form-label" for="edit-prov-name">连接名称</label>
      <input id="edit-prov-name" class="form-input" data-edit-name value="${escAttr(p.displayName || '')}" placeholder="${escAttr(defaultName)}" autocomplete="off">
      <div class="form-hint">留空则使用默认「${escHtml(defaultName)}」</div>
    </div>
  `
  const preset = PROVIDER_PRESETS.find((x) => x.key === presetKey)
  const keyOptional = providerApiKeyOptional(providerKey, p)
  const keyHint = p.apiKeyConfigured && !String(p.apiKey || '').trim()
    ? '密钥已保存在服务端（脱敏不可见）；留空表示不修改，输入新值可替换'
    : '修改后保存生效；留空并保存将不使用密钥'
  if (preset && PROVIDER_URL_MODE_KEYS.includes(preset.key)) {
    const mode = inferProviderBaseUrlMode(preset, p.baseUrl)
    const block = urlModeRadioBlockHtml(preset, 'edit-provider-url-mode', mode)
    const overlay = mountModelsModalOverlay(`
      <div class="modal" style="max-width:560px;max-height:85vh;overflow-y:auto">
        <div class="modal-title">编辑连接信息 · ${escHtml(preset.label)}</div>
        ${nameFieldHtml}
        ${block}
        <div class="form-group">
          <label class="form-label" for="edit-prov-base">Base URL</label>
          <input id="edit-prov-base" class="form-input" data-edit-base value="${escAttr(p.baseUrl || '')}" autocomplete="off">
        </div>
        ${apiKeyFieldGroupHtml({
          id: 'edit-prov-key',
          value: p.apiKey || '',
          optional: keyOptional,
          placeholder: p.apiKeyConfigured && !p.apiKey ? '已保存在服务端' : '修改后保存生效',
          hint: keyHint,
          fieldAttr: 'data-edit-key',
          label: 'API Key',
        })}
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
          <button type="button" class="btn btn-primary btn-sm" data-action="save">保存</button>
        </div>
      </div>
    `)
    const baseEl = overlay.querySelector('[data-edit-base]')
    if (baseEl) bindUrlModeRadiosToInput(overlay, preset, baseEl, 'edit-provider-url-mode')
    // 表单弹窗不因点击遮罩关闭，避免 API Key 等输入误触丢失
    overlay.querySelector('[data-action="cancel"]').onclick = () => overlay.remove()
    overlay.querySelector('[data-action="save"]').onclick = () => {
      const baseUrl = resolveBaseUrlFromUrlMode(overlay, preset, 'edit-provider-url-mode', (baseEl?.value || '').trim())
      const apiKey = overlay.querySelector('[data-edit-key]')?.value?.trim() ?? ''
      const displayName = overlay.querySelector('[data-edit-name]')?.value?.trim() ?? ''
      pushUndo(state)
      p.baseUrl = baseUrl
      if (!keyOptional) applyProviderApiKeyEdit(p, apiKey)
      setProviderDisplayName(state, providerKey, displayName)
      overlay.remove()
      renderProviders(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
      toast('连接信息已更新', 'success')
    }
    return
  }

  const providersMap = state.config.models.providers || {}
  const editFields = [
    { name: 'displayName', label: '连接名称', value: p.displayName || '', hint: `留空则使用默认「${defaultName}」` },
    {
      name: 'baseUrl',
      label: '接口地址',
      value: p.baseUrl || '',
      hint: keyOptional
        ? '本机服务地址，Ollama 默认 http://127.0.0.1:11434/v1'
        : (presetKey === 'openai'
          ? '默认可填官方 api.openai.com/v1；也可改为 NewAPI / OneAPI / Azure 兼容端 / 自建网关等。与 ChatGPT Plus 订阅无关'
          : '模型服务的 API 地址，通常以 /v1 结尾；Ollama 可直接填 http://127.0.0.1:11434'),
    },
  ]
  if (!keyOptional) {
    editFields.push({ name: 'apiKey', label: '密钥 (API Key)', value: p.apiKey || '', hint: keyHint })
  }
  showModal({
    title: `编辑连接信息 · ${resolveConnectionLabel(providerKey, providersMap, presetKey)}`,
    fields: editFields,
    onConfirm: ({ displayName, baseUrl, apiKey }) => {
      pushUndo(state)
      p.baseUrl = baseUrl
      if (!keyOptional) applyProviderApiKeyEdit(p, apiKey ?? '')
      setProviderDisplayName(state, providerKey, displayName)
      renderProviders(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
      toast('连接信息已更新', 'success')
    },
  })
}

// 添加模型（带预设快捷选择）
function addModel(page, state, providerKey) {
  const providerDisp = displayTitleForProvider(providerKey, state.config.models.providers || {})
  const provider = state.config.models.providers[providerKey] || {}
  const aliyunLike = isAliyunLikeProvider(providerKey, provider)
  const presets = MODEL_PRESETS[providerKey] || []
  const existingIds = (state.config.models.providers[providerKey].models || [])
    .map(m => typeof m === 'string' ? m : m.id)
  const available = presets.filter(p => !existingIds.includes(p.id))

  // 同厂商的供应商连接列表已移除，直接使用当前 providerKey
  const inputPresets = [
    { label: '64K', value: 65536 },
    { label: '128K', value: 131072 },
    { label: '256K', value: 262144 },
    { label: '512K', value: 524288 },
    { label: '1M', value: 1048576 },
  ]
  const outputPresets = [
    { label: '8K', value: 8192 },
    { label: '16K', value: 16384 },
    { label: '32K', value: 32768 },
    { label: '64K', value: 65536 },
  ]
  let presetQuickHtml = ''
  if (available.length) {
    const presetBtn = (p) =>
      `<button type="button" class="btn btn-sm btn-secondary preset-btn" data-mid="${escAttr(p.id)}" style="margin:0 6px 6px 0">${escHtml(p.name)}${p.reasoning ? ' (推理)' : ''}</button>`
    const hasSections = available.some((p) => p.section === 'recommended' || p.section === 'more')
    if (hasSections) {
      const rec = available.filter((p) => p.section === 'recommended')
      const more = available.filter((p) => p.section === 'more')
      const rest = available.filter((p) => p.section !== 'recommended' && p.section !== 'more')
      const blocks = []
      if (rec.length) blocks.push(`<div class="form-hint" style="margin:0 0 6px;font-weight:600">推荐模型</div><div style="display:flex;flex-wrap:wrap">${rec.map(presetBtn).join('')}</div>`)
      if (more.length) blocks.push(`<div class="form-hint" style="margin:10px 0 6px;font-weight:600">更多模型</div><div style="display:flex;flex-wrap:wrap">${more.map(presetBtn).join('')}</div>`)
      if (rest.length) blocks.push(`<div style="display:flex;flex-wrap:wrap;margin-top:8px">${rest.map(presetBtn).join('')}</div>`)
      presetQuickHtml = blocks.join('')
    } else {
      presetQuickHtml = `<div style="display:flex;flex-wrap:wrap">${available.map(presetBtn).join('')}</div>`
    }
  }

  const defaultInputCtx = DEFAULT_MODEL_CONTEXT_WINDOW
  const defaultOutputCtx = DEFAULT_MODEL_MAX_OUTPUT_TOKENS

  const overlay = mountModelsModalOverlay(`
    <div class="modal models-edit-modal">
      <div class="models-edit-modal-header">
        <div class="models-edit-modal-title-row">
          <h2 class="models-edit-modal-title">添加模型</h2>
          <span class="models-edit-modal-subtitle">${escHtml(providerDisp)}</span>
        </div>
        <button type="button" class="models-edit-modal-close" data-action="cancel" title="关闭">&times;</button>
      </div>

      <div class="models-edit-modal-body">
        ${presetQuickHtml ? `
        <div class="form-group">
          <label class="form-label">快捷添加</label>
          ${presetQuickHtml}
          <div class="form-hint">点击直接添加常用模型，或手动填写下方信息</div>
        </div>
        <div class="models-edit-divider"></div>
        ` : ''}

        <div class="models-edit-section-label">模型信息</div>
        <div class="models-edit-field-row">
          <div class="form-group">
            <label class="form-label">模型 ID</label>
            <input class="form-input" data-name="id" value="" placeholder="如 gpt-4o" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="form-label">模型名称（可选）</label>
            <input class="form-input" data-name="name" value="" placeholder="留空则使用模型 ID">
          </div>
        </div>
        <div class="form-hint" style="margin-top:-10px">模型 ID 为调用标识（可含 /）；名称用于对话展示，留空则与 ID 相同</div>

        <div class="models-edit-divider"></div>

        <div class="models-edit-advanced-section">
          <div class="models-edit-advanced-title">高级配置</div>
          <div class="models-edit-checkbox-grid">
            <label class="models-edit-checkbox-item">
              <input type="checkbox" data-name="vision">
              <span>图片输入</span>
            </label>
            <label class="models-edit-checkbox-item">
              <input type="checkbox" data-name="reasoning">
              <span>支持思考</span>
            </label>
            ${nativeWebSearchCheckboxHtml({ checked: false, enabled: aliyunLike })}
          </div>
          <div class="form-hint" style="margin-top:8px">${NATIVE_WEB_SEARCH_HINT}</div>
          <div class="form-group" style="margin-top:10px">
            <label class="form-label">温度 (Temperature)</label>
            <input class="form-input" data-name="temperature" type="number" value="" min="0" max="2" step="0.1" placeholder="留空使用厂商默认值">
            <div class="form-hint">控制生成随机性，0=确定，2=随机；留空则不传此参数，由模型厂商自行决定</div>
          </div>
        </div>

        <div class="models-edit-thinking-fields">
        <div class="form-group">
          <label class="form-label">默认思考模式</label>
          ${thinkingModeSelectHtml('auto')}
          <div class="form-hint">自动 = 会话 Auto 决策；默认开启/关闭 = 使用该模型时固定策略（优先于 Auto 开关）</div>
        </div>

        <div class="form-group">
          <label class="form-label">默认思考强度</label>
          ${thinkingLevelRadiosHtml('medium')}
          <div class="form-hint">三选一；聊天中仍可临时切换，此处为该模型默认强度</div>
        </div>
        </div>

        <div class="models-edit-divider"></div>

        <div class="models-edit-section-label">上下文窗口</div>
        <div class="models-edit-ctx-row">
          <div class="models-edit-ctx-col">
            <label class="form-label">输入</label>
            <input class="form-input models-edit-ctx-input" data-name="inputContextLength" type="number" value="${defaultInputCtx}" min="1024" step="1024">
            ${contextLengthPresetsHtml('inputContextLength', defaultInputCtx, inputPresets)}
          </div>
          <div class="models-edit-ctx-col">
            <label class="form-label">输出</label>
            <input class="form-input models-edit-ctx-input" data-name="outputContextLength" type="number" value="${defaultOutputCtx}" min="1024" step="1024">
            ${contextLengthPresetsHtml('outputContextLength', defaultOutputCtx, outputPresets)}
          </div>
        </div>
      </div>

      <div class="modal-actions models-edit-modal-actions">
        <button type="button" class="btn btn-secondary" data-action="cancel">取消</button>
        <button type="button" class="btn btn-primary" data-action="save">添加</button>
      </div>
    </div>
  `)

  bindThinkingFieldsVisibility(overlay)

  overlay.querySelectorAll('[data-name="id"], [data-name="name"]').forEach((el) => {
    el.addEventListener('input', () => clearModelsEditModalError(overlay))
  })

  // 上下文长度预设按钮
  overlay.querySelectorAll('.models-ctx-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.ctxField
      const value = Number(btn.dataset.ctxValue)
      const input = overlay.querySelector(`[data-name="${field}"]`)
      if (input) input.value = value
      overlay.querySelectorAll(`.models-ctx-preset-btn[data-ctx-field="${field}"]`).forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
    })
  })

  overlay.querySelectorAll('.models-edit-ctx-input').forEach(input => {
    input.addEventListener('input', () => {
      const field = input.dataset.name
      const val = Number(input.value) || 0
      overlay.querySelectorAll(`.models-ctx-preset-btn[data-ctx-field="${field}"]`).forEach(b => {
        b.classList.toggle('active', Number(b.dataset.ctxValue) === val)
      })
    })
  })

  // 关闭（不因点击遮罩关闭，避免已填内容误触丢失）
  const closeModal = () => overlay.remove()
  overlay.querySelectorAll('[data-action="cancel"]').forEach(btn => btn.addEventListener('click', closeModal))

  // 预设快捷添加：点击直接添加并关闭
  overlay.querySelectorAll('.preset-btn').forEach(btn => {
    btn.onclick = () => {
      const preset = available.find(p => p.id === btn.dataset.mid)
      if (!preset) return
      pushUndo(state)
      const { section: _s, vision, ...presetRest } = preset
      const reasoningDefault = providerKey === 'aliyun' ? (preset.reasoning ?? true) : !!preset.reasoning
      const input = vision ? ['text', 'image'] : ['text']
      const usedNames = collectUsedConfigNames(state.config)
      const configName = deriveConfigName(preset.name, providerKey, preset.id, usedNames)
      const model = {
        ...presetRest,
        configName,
        reasoning: reasoningDefault,
        input,
        contextWindow: preset.contextWindow || DEFAULT_MODEL_CONTEXT_WINDOW,
      }
      state.config.models.providers[providerKey].models.push(model)
      overlay.remove()
      renderProviders(page, state)
      renderDefaultBar(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
      toast(`已添加模型: ${preset.name}`, 'success')
    }
  })

  // 保存（手动添加）
  overlay.querySelector('[data-action="save"]')?.addEventListener('click', () => {
    const newId = overlay.querySelector('[data-name="id"]')?.value?.trim()
    const rawName = overlay.querySelector('[data-name="name"]')?.value?.trim() ?? ''
    const newName = resolveModelDisplayName(rawName, newId)
    const newInputCtx = Number(overlay.querySelector('[data-name="inputContextLength"]')?.value) || 0
    const newOutputCtx = Number(overlay.querySelector('[data-name="outputContextLength"]')?.value) || 0
    const newReasoning = overlay.querySelector('[data-name="reasoning"]')?.checked ?? false
    const newVision = overlay.querySelector('[data-name="vision"]')?.checked ?? false
    const newEnableWebSearch = aliyunLike && (overlay.querySelector('[data-name="enableWebSearch"]')?.checked ?? false)
    const newDefaultMode = overlay.querySelector('[data-name="defaultThinkingMode"]')?.value || 'auto'
    const newTemperatureRaw = overlay.querySelector('[data-name="temperature"]')?.value?.trim()
    const newTemperature = newTemperatureRaw && Number.isFinite(Number(newTemperatureRaw)) ? Number(newTemperatureRaw) : null

    if (!newId) {
      showModelsEditModalError(overlay, '请填写模型 ID', 'warning')
      return
    }
    clearModelsEditModalError(overlay)

    const newDefaultLevel = readThinkingLevelFromOverlay(overlay)

    pushUndo(state)

    const usedNames = collectUsedConfigNames(state.config)
    const configName = deriveConfigName(newName, providerKey, newId, usedNames)
    const model = {
      configName,
      id: newId,
      name: rawName,
      reasoning: newReasoning,
      input: newVision ? ['text', 'image'] : ['text'],
      enableWebSearch: newEnableWebSearch,
      contextWindow: newInputCtx || DEFAULT_MODEL_CONTEXT_WINDOW,
      inputContextLength: newInputCtx || null,
      outputContextLength: newOutputCtx || null,
      temperature: newTemperature,
    }
    if (newReasoning) {
      model.thinking = buildThinkingUiConfig(newDefaultLevel, newDefaultMode)
    }

    // 直接添加到当前供应商下
    const targetKey = providerKey
    if (state.config.models.providers[targetKey]) {
      state.config.models.providers[targetKey].models.push(model)
    } else {
      state.config.models.providers[providerKey].models.push(model)
    }

    closeModal()
    renderProviders(page, state)
    renderDefaultBar(page, state)
    updateUndoBtn(page, state)
    autoSave(state)
    toast(`已添加模型: ${newName}`, 'success')
  })

  overlay.querySelector('[data-name="id"]')?.focus()
}

// 构建表单字段 HTML（用于自定义弹窗）
function buildFieldsHtml(fields) {
  return fields.map(f => {
    if (f.type === 'contextWindow') {
      return buildContextWindowFieldHtml(f)
    }
    if (f.type === 'checkbox') {
      return `
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" data-name="${f.name}" ${f.value ? 'checked' : ''}>
            <span class="form-label" style="margin:0">${f.label}</span>
          </label>
          ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
        </div>`
    }
    return `
      <div class="form-group">
        <label class="form-label">${f.label}</label>
        <input class="form-input" data-name="${f.name}" value="${f.value || ''}" placeholder="${f.placeholder || ''}">
        ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
      </div>`
  }).join('')
}

// 绑定自定义弹窗的通用事件（不因点击遮罩关闭，避免 API Key 等输入误触丢失）
function bindModalEvents(overlay, fields, onConfirm) {
  overlay.querySelector('[data-action="cancel"]').onclick = () => overlay.remove()
  overlay.querySelector('[data-action="confirm"]').onclick = () => {
    const result = {}
    overlay.querySelectorAll('[data-name]').forEach(el => {
      result[el.dataset.name] = el.type === 'checkbox' ? el.checked : el.value
    })
    overlay.remove()
    onConfirm(result)
  }
}

// 实际添加模型到 state
function doAddModel(state, providerKey, vals) {
  if (!vals.id) { toast('请填写模型 ID', 'warning'); return }
  const modelId = vals.id.trim()
  const rawName = String(vals.name || '').trim()
  const displayName = resolveModelDisplayName(rawName, modelId)
  const usedNames = collectUsedConfigNames(state.config)
  const configName = deriveConfigName(displayName, providerKey, modelId, usedNames)
  const model = {
    configName,
    id: modelId,
    name: rawName,
    reasoning: !!vals.reasoning,
    input: vals.vision ? ['text', 'image'] : ['text'],
  }
  model.contextWindow = parseInt(vals.contextWindow, 10) || DEFAULT_MODEL_CONTEXT_WINDOW
  state.config.models.providers[providerKey].models.push(model)
  toast(`已添加模型: ${displayName}`, 'success')
}

/** 上下文长度预设按钮组 HTML */
function contextLengthPresetsHtml(fieldName, currentValue, presets) {
  const val = Number(currentValue) || 0
  return `<div class="models-ctx-presets">
    ${presets.map(p => {
      const v = p.value
      const kLabel = p.label || (v >= 1024 ? `${v / 1024}K` : `${v}`)
      return `<button type="button" class="models-ctx-preset-btn${val === v ? ' active' : ''}" data-ctx-field="${fieldName}" data-ctx-value="${v}">${kLabel}</button>`
    }).join('')}
  </div>`
}

/** 编辑模型 — 自定义弹窗（匹配截图布局） */
function editModel(page, state, providerKey, idx) {
  const m = state.config.models.providers[providerKey].models[idx]
  const provider = state.config.models.providers[providerKey] || {}
  const aliyunLike = isAliyunLikeProvider(providerKey, provider)
  const modelId = modelProviderId(m) || ''
  const nameInputValue = modelNameInputValue(m?.name, modelId)

  // 读取现有值
  const inputCtxLen = m?.inputContextLength || m?.contextWindow || DEFAULT_MODEL_CONTEXT_WINDOW
  const outputCtxLen = m?.outputContextLength || DEFAULT_MODEL_MAX_OUTPUT_TOKENS
  const thinking = m?.thinking || {}
  const defaultLevel = readDefaultThinkingLevel(thinking)
  const defaultMode = readDefaultThinkingMode(thinking)
  const supportsThinking = !!m?.reasoning
  const supportsVision = modelSupportsVision(m)
  const enableWebSearch = !!m?.enableWebSearch && aliyunLike

  // 供应商连接选择已移除，直接使用当前 providerKey
  const inputPresets = [
    { label: '64K', value: 65536 },
    { label: '128K', value: 131072 },
    { label: '256K', value: 262144 },
    { label: '512K', value: 524288 },
    { label: '1M', value: 1048576 },
  ]
  const outputPresets = [
    { label: '8K', value: 8192 },
    { label: '16K', value: 16384 },
    { label: '32K', value: 32768 },
    { label: '64K', value: 65536 },
  ]
  const overlay = mountModelsModalOverlay(`
    <div class="modal models-edit-modal">
      <div class="models-edit-modal-header">
        <div class="models-edit-modal-title-row">
          <h2 class="models-edit-modal-title">编辑模型</h2>
          <span class="models-edit-modal-subtitle">协议为 OpenAI 兼容；接口地址可填官方或任意兼容端点（非 ChatGPT Plus 订阅）</span>
        </div>
        <button type="button" class="models-edit-modal-close" data-action="cancel" title="关闭">&times;</button>
      </div>

      <div class="models-edit-modal-body">
        <!-- 模型 ID + 模型名称 并排 -->
        <div class="models-edit-section-label">模型信息</div>
        <div class="models-edit-field-row">
          <div class="form-group">
            <label class="form-label">模型 ID</label>
            <input class="form-input" data-name="id" value="${escAttr(modelId)}" placeholder="如 gpt-4o" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="form-label">模型名称（可选）</label>
            <input class="form-input" data-name="name" value="${escAttr(nameInputValue)}" placeholder="留空则使用模型 ID">
          </div>
        </div>
        <div class="form-hint" style="margin-top:-10px">模型 ID 为调用标识（可含 /）；名称用于对话展示，留空则与 ID 相同</div>

        <div class="models-edit-divider"></div>

        <!-- 高级配置 -->
        <div class="models-edit-advanced-section">
          <div class="models-edit-advanced-title">高级配置</div>
          <div class="models-edit-checkbox-grid">
            <label class="models-edit-checkbox-item">
              <input type="checkbox" data-name="vision" ${supportsVision ? 'checked' : ''}>
              <span>图片输入</span>
            </label>
            <label class="models-edit-checkbox-item">
              <input type="checkbox" data-name="reasoning" ${supportsThinking ? 'checked' : ''}>
              <span>支持思考</span>
            </label>
            ${nativeWebSearchCheckboxHtml({ checked: enableWebSearch, enabled: aliyunLike })}
          </div>
          <div class="form-hint" style="margin-top:8px">${NATIVE_WEB_SEARCH_HINT}</div>
          <div class="form-group" style="margin-top:10px">
            <label class="form-label">温度 (Temperature)</label>
            <input class="form-input" data-name="temperature" type="number" value="${m?.temperature != null ? m.temperature : ''}" min="0" max="2" step="0.1" placeholder="留空使用厂商默认值">
            <div class="form-hint">控制生成随机性，0=确定，2=随机；留空则不传此参数，由模型厂商自行决定</div>
          </div>
        </div>

        <div class="models-edit-thinking-fields">
        <div class="form-group">
          <label class="form-label">默认思考模式</label>
          ${thinkingModeSelectHtml(defaultMode)}
          <div class="form-hint">自动 = 会话 Auto 决策；默认开启/关闭 = 使用该模型时固定策略（优先于 Auto 开关）</div>
        </div>

        <!-- 默认思考强度（单选） -->
        <div class="form-group">
          <label class="form-label">默认思考强度</label>
          ${thinkingLevelRadiosHtml(defaultLevel)}
          <div class="form-hint">三选一；聊天中仍可临时切换，此处为该模型默认强度</div>
        </div>
        </div>

        <div class="models-edit-divider"></div>

        <!-- 输入 / 输出 上下文长度 -->
        <div class="models-edit-section-label">上下文窗口</div>
        <div class="models-edit-ctx-row">
          <div class="models-edit-ctx-col">
            <label class="form-label">输入</label>
            <input class="form-input models-edit-ctx-input" data-name="inputContextLength" type="number" value="${inputCtxLen}" min="1024" step="1024">
            ${contextLengthPresetsHtml('inputContextLength', inputCtxLen, inputPresets)}
          </div>
          <div class="models-edit-ctx-col">
            <label class="form-label">输出</label>
            <input class="form-input models-edit-ctx-input" data-name="outputContextLength" type="number" value="${outputCtxLen}" min="1024" step="1024">
            ${contextLengthPresetsHtml('outputContextLength', outputCtxLen, outputPresets)}
          </div>
        </div>
      </div>

      <div class="modal-actions models-edit-modal-actions">
        <button type="button" class="btn btn-secondary" data-action="cancel">取消</button>
        <button type="button" class="btn btn-primary" data-action="save">保存</button>
      </div>
    </div>
  `)

  bindThinkingFieldsVisibility(overlay)

  overlay.querySelectorAll('[data-name="id"], [data-name="name"]').forEach((el) => {
    el.addEventListener('input', () => clearModelsEditModalError(overlay))
  })

  // 绑定事件
  // 上下文长度预设按钮
  overlay.querySelectorAll('.models-ctx-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.ctxField
      const value = Number(btn.dataset.ctxValue)
      const input = overlay.querySelector(`[data-name="${field}"]`)
      if (input) input.value = value
      // 更新按钮高亮
      overlay.querySelectorAll(`.models-ctx-preset-btn[data-ctx-field="${field}"]`).forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
    })
  })

  // 输入框变化时更新预设高亮
  overlay.querySelectorAll('.models-edit-ctx-input').forEach(input => {
    input.addEventListener('input', () => {
      const field = input.dataset.name
      const val = Number(input.value) || 0
      overlay.querySelectorAll(`.models-ctx-preset-btn[data-ctx-field="${field}"]`).forEach(b => {
        b.classList.toggle('active', Number(b.dataset.ctxValue) === val)
      })
    })
  })

  // 关闭（不因点击遮罩关闭，避免已填内容误触丢失）
  const closeModal = () => overlay.remove()
  overlay.querySelectorAll('[data-action="cancel"]').forEach(btn => btn.addEventListener('click', closeModal))

  // 保存
  overlay.querySelector('[data-action="save"]')?.addEventListener('click', () => {
    const newId = overlay.querySelector('[data-name="id"]')?.value?.trim()
    const rawName = overlay.querySelector('[data-name="name"]')?.value?.trim() ?? ''
    const newName = resolveModelDisplayName(rawName, newId)
    const newInputCtx = Number(overlay.querySelector('[data-name="inputContextLength"]')?.value) || 0
    const newOutputCtx = Number(overlay.querySelector('[data-name="outputContextLength"]')?.value) || 0
    const newReasoning = overlay.querySelector('[data-name="reasoning"]')?.checked ?? false
    const newVision = overlay.querySelector('[data-name="vision"]')?.checked ?? false
    const newEnableWebSearch = aliyunLike && (overlay.querySelector('[data-name="enableWebSearch"]')?.checked ?? false)
    const newDefaultMode = overlay.querySelector('[data-name="defaultThinkingMode"]')?.value || 'auto'
    const newTemperatureRaw = overlay.querySelector('[data-name="temperature"]')?.value?.trim()
    const newTemperature = newTemperatureRaw && Number.isFinite(Number(newTemperatureRaw)) ? Number(newTemperatureRaw) : null

    if (!newId) {
      showModelsEditModalError(overlay, '请填写模型 ID', 'warning')
      return
    }
    clearModelsEditModalError(overlay)

    const newDefaultLevel = readThinkingLevelFromOverlay(overlay)

    pushUndo(state)

    // 同一供应商内更新
    if (typeof m === 'object') {
      m.id = newId
      m.name = rawName
      m.reasoning = newReasoning
      setModelVision(m, newVision)
      m.enableWebSearch = newEnableWebSearch
      m.contextWindow = newInputCtx || DEFAULT_MODEL_CONTEXT_WINDOW
      m.inputContextLength = newInputCtx || null
      m.outputContextLength = newOutputCtx || null
      m.temperature = newTemperature
      if (newReasoning) {
        m.thinking = buildThinkingUiConfig(newDefaultLevel, newDefaultMode)
      } else {
        m.thinking = null
      }
    }

    closeModal()
    renderProviders(page, state)
    renderDefaultBar(page, state)
    updateUndoBtn(page, state)
    autoSave(state)
    toast('模型已更新', 'success')
  })

  overlay.querySelector('[data-name="id"]')?.focus()
}

// 全选/取消全选
function handleSelectAll(section) {
  const boxes = section.querySelectorAll('.model-checkbox')
  const allChecked = [...boxes].every(cb => cb.checked)
  boxes.forEach(cb => { cb.checked = !allChecked })
  // 更新批量删除按钮状态
  const batchDelBtn = section.querySelector('[data-action="batch-delete"]')
  if (batchDelBtn) batchDelBtn.disabled = allChecked
}

// 批量删除选中的模型
async function handleBatchDelete(section, page, state, providerKey) {
  const checked = [...section.querySelectorAll('.model-checkbox:checked')]
  if (!checked.length) { toast('请先勾选要删除的模型', 'warning'); return }
  const ids = checked.map(cb => cb.dataset.modelId)
  const yes = await showConfirm(`确定删除选中的 ${ids.length} 个模型？\n${ids.join(', ')}`)
  if (!yes) return
  pushUndo(state)
  const provider = state.config.models.providers[providerKey]
  provider.models = (provider.models || []).filter((m) => !ids.includes(modelConfigName(m)))
  renderProviders(page, state)
  renderDefaultBar(page, state)
  updateUndoBtn(page, state)
  autoSave(state)
  toast(`已删除 ${ids.length} 个模型`, 'info')
}

/** 通过 Gateway 测试模型（优先 /models/invoke，与对话同源的后端模型栈）。
 *  未落库时先 sync 再 invoke；/models/test 仅作无 configName 时的兜底。
 *  Tokenizer/观测已改为非阻塞，不会因 token 统计拖垮 Gateway。
 */
async function probeModelConnectivity(state, providerKey, model, { skipSync = false } = {}) {
  const provider = state.config?.models?.providers?.[providerKey]
  if (!provider) throw new Error('连接不存在')

  const apiModelId = modelProviderId(model)
  if (!apiModelId) throw new Error('模型 ID 为空')

  const configName = modelConfigName(model)
  normalizeProviderUrls(state.config)

  async function invokeConfigured() {
    const res = await api.invokeConfiguredModel({
      model_name: configName,
      messages: [{ role: 'user', content: 'Hi' }],
    })
    const text = String(res?.content ?? '').trim()
    return text || '连接成功'
  }

  if (configName) {
    let didSync = false
    if (!skipSync) {
      await syncModelsToGateway(state)
      didSync = true
    }
    try {
      return await invokeConfigured()
    } catch (e) {
      const msg = String(e?.message || e)
      const notSynced = /不存在|not found|404/i.test(msg)
      if (notSynced && !didSync) {
        await syncModelsToGateway(state)
        return await invokeConfigured()
      }
      if (notSynced) {
        throw new Error('模型尚未保存到数据库，请稍候自动保存完成后再测试')
      }
      throw e
    }
  }

  // 尚无 configName：先尽量 sync 生成配置名后再走后端 invoke
  await syncModelsToGateway(state)
  const syncedName = modelConfigName(model)
  if (syncedName) {
    const res = await api.invokeConfiguredModel({
      model_name: syncedName,
      messages: [{ role: 'user', content: 'Hi' }],
    })
    const text = String(res?.content ?? '').trim()
    return text || '连接成功'
  }

  // 极端兜底：本地明文密钥直连探测（仍经 Gateway /models/test）
  const localKey = String(provider.apiKey || '').trim()
  const apiType = provider.api || 'openai-completions'
  if (localKey) {
    return api.testModel(provider.baseUrl, localKey, apiModelId, apiType, null)
  }
  if (providerApiKeyOptional(providerKey, provider)) {
    return api.testModel(provider.baseUrl, '', apiModelId, apiType, null)
  }
  throw new Error('缺少 API Key，请在编辑连接中填写')
}

let _tokenizerHintShownAt = 0

/** 测试前提示 Tokenizer 准备态（不阻塞后端 invoke） */
async function maybeHintTokenizerPreparing() {
  const now = Date.now()
  if (now - _tokenizerHintShownAt < 60_000) return
  try {
    const st = await api.tokenizerStatus()
    if (st?.ready) return
    _tokenizerHintShownAt = now
    const msg = String(st?.message || '正在准备 Tokenizer').trim()
    toast(`${msg} · 连通性仍走后端模型栈`, 'info')
  } catch {
    /* ignore — tokenizer status is best-effort */
  }
}

// 批量测试：勾选的模型，没勾选则测试全部（记录耗时和状态）
async function handleBatchTest(section, state, providerKey) {
  // 如果正在测试，点击则终止
  if (_batchTestAbort) {
    _batchTestAbort.abort = true
    toast('正在终止批量测试...', 'warning')
    return
  }

  const provider = state.config.models.providers[providerKey]
  const checked = [...section.querySelectorAll('.model-checkbox:checked')]
  const ids = checked.length
    ? checked.map((cb) => cb.dataset.modelId)
    : (provider.models || []).map((m) => modelConfigName(m))

  if (!ids.length) { toast('没有可测试的模型', 'warning'); return }

  const batchBtn = section.querySelector('[data-action="batch-test"]')
  const ctrl = { abort: false }
  _batchTestAbort = ctrl
  if (batchBtn) {
    batchBtn.textContent = '终止测试'
    batchBtn.classList.remove('btn-secondary')
    batchBtn.classList.add('btn-danger')
  }

  const page = section.closest('.page')
  let ok = 0, fail = 0
  let syncedForBatch = false
  void maybeHintTokenizerPreparing()
  for (const configName of ids) {
    if (ctrl.abort) break

    const model = (provider.models || []).find((m) => modelConfigName(m) === configName)
    const card = section.querySelector(`.model-card[data-model-id="${CSS.escape(configName)}"]`)
    if (card) card.style.outline = '2px solid var(--accent)'

    const start = Date.now()
    try {
      await probeModelConnectivity(state, providerKey, model, { skipSync: syncedForBatch })
      syncedForBatch = true
      const elapsed = Date.now() - start
      if (model && typeof model === 'object') {
        model.latency = elapsed
        model.lastTestAt = Date.now()
        model.testStatus = 'ok'
        delete model.testError
      }
      ok++
    } catch (e) {
      const elapsed = Date.now() - start
      if (model && typeof model === 'object') {
        model.latency = null
        model.lastTestAt = Date.now()
        model.testStatus = 'fail'
        model.testError = String(e).slice(0, 100)
      }
      fail++
    }

    // 每测完一个实时刷新卡片
    if (page) {
      renderProviders(page, state)
      renderDefaultBar(page, state)
    }
    // 进度 toast
    const status = model?.testStatus === 'ok' ? '\u2713' : '\u2717'
    const latStr = model?.latency != null ? ` ${(model.latency / 1000).toFixed(1)}s` : ''
    const label = model && typeof model === 'object'
      ? resolveModelDisplayName(model.name, modelProviderId(model))
      : configName
    toast(`${status} ${label}${latStr} (${ok + fail}/${ids.length})`, model?.testStatus === 'ok' ? 'success' : 'error')
  }

  // 恢复按钮
  _batchTestAbort = null
  // 重新查找按钮（renderProviders 后 DOM 已更新）
  const newSection = page?.querySelector(`[data-provider="${providerKey}"]`)
  const newBtn = newSection?.querySelector('[data-action="batch-test"]')
  if (newBtn) {
    newBtn.textContent = '批量测试'
    newBtn.classList.remove('btn-danger')
    newBtn.classList.add('btn-secondary')
  }

  const aborted = ctrl.abort
  // 测试结果仅更新本页展示；不在此 sync/apply 配置（与「保存」解耦）
  if (aborted) {
    toast(`批量测试已终止：${ok} 成功，${fail} 失败，${ids.length - ok - fail} 跳过`, 'warning')
  } else {
    toast(`批量测试完成：${ok} 成功，${fail} 失败`, ok === ids.length ? 'success' : 'warning')
  }
}

// 测试模型连通性（记录耗时和状态；不 apply 配置）
async function testModel(btn, state, providerKey, idx) {
  const provider = state.config.models.providers[providerKey]
  const model = provider.models[idx]
  const apiModelId = modelProviderId(model)
  const label = resolveModelDisplayName(typeof model === 'object' ? model.name : '', apiModelId)

  const origHtml = btn.innerHTML
  btn.disabled = true
  btn.classList.add('models-test-btn--busy')
  btn.textContent = '测试中...'

  void maybeHintTokenizerPreparing()
  const start = Date.now()
  try {
    const reply = await probeModelConnectivity(state, providerKey, model)
    const elapsed = Date.now() - start
    // 记录到模型对象
    if (typeof model === 'object') {
      model.latency = elapsed
      model.lastTestAt = Date.now()
      model.testStatus = 'ok'
      delete model.testError
      model.availabilityStatus = 'available'
      model.unavailableReason = ''
      model.unavailableCode = ''
      model.unavailableAt = ''
    }
    toast(`${label} 连通正常 (${(elapsed / 1000).toFixed(1)}s): "${reply.slice(0, 50)}"`, 'success', {
      duration: 5000,
    })
    notifyModelsUpdated()
  } catch (e) {
    const elapsed = Date.now() - start
    if (typeof model === 'object') {
      model.latency = null
      model.lastTestAt = Date.now()
      model.testStatus = 'fail'
      model.testError = String(e).slice(0, 100)
    }
    toast(`${label} 不可用 (${(elapsed / 1000).toFixed(1)}s): ${e}`, 'error', { duration: 6000 })
  } finally {
    btn.disabled = false
    btn.classList.remove('models-test-btn--busy')
    btn.innerHTML = origHtml
    // 刷新卡片显示最新状态
    const page = btn.closest('.page')
    if (page) {
      renderProviders(page, state)
      renderDefaultBar(page, state)
    }
    // 故意不 sync/apply：测试结果只更新本页；配置保存走自动保存或显式保存
  }
}

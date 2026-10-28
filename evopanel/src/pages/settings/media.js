/**
 * 媒体渠道配置 — 嵌入「设置 → 模型」：
 * - 生图生视频 Tab（creative）
 * - 语音 Tab（voice）
 */
import { toast } from '../../components/toast.js'
import { publicIconUrl } from '../../lib/public-asset.js'
import {
  DEFAULT_MEDIA_CREDENTIALS,
  DEFAULT_ENABLED_VENDORS,
  fetchMediaCredentials,
  getEnabledVendors,
  isFieldConfigured,
  maskedSecretHint,
  patchMediaCredentials,
} from '../../lib/media-settings.js'
import {
  buildTtsSpeakerFieldHtml,
  bindTtsSpeakerFields,
  readTtsSpeakerDraft,
} from '../../components/tts-speaker-picker.js'
import {
  VOLCENGINE_TTS_SPEAKER_DOC_URL,
  VOLCENGINE_TTS_SPEAKER_PRESETS,
} from '../../lib/volcengine-tts-speakers.js'

// Agent Plan 套餐概览用短 ID；按量 Ark 官方快照带日期后缀（见方舟模型列表）。
const JIMENG_IMAGE_MODEL_PRESETS = [
  { value: 'doubao-seedream-5-0-pro', label: 'Seedream 5.0 Pro（套餐）' },
  { value: 'doubao-seedream-5.0-flash', label: 'Seedream 5.0 Flash（套餐）' },
  { value: 'doubao-seedream-5-0-pro-260628', label: 'Seedream 5.0 Pro · 260628（按量）' },
  { value: 'doubao-seedream-5-0-flash-260915', label: 'Seedream 5.0 Flash · 260915（按量）' },
]

const JIMENG_VIDEO_MODEL_PRESETS = [
  { value: 'doubao-seedance-2.5', label: 'Seedance 2.5（套餐）' },
  { value: 'doubao-seedance-2.0', label: 'Seedance 2.0（套餐）' },
  { value: 'doubao-seedance-2.0-fast', label: 'Seedance 2.0 Fast（套餐）' },
  { value: 'doubao-seedance-2.0-mini', label: 'Seedance 2.0 Mini（套餐）' },
  { value: 'doubao-seedance-2-5-260628', label: 'Seedance 2.5 · 260628（按量）' },
  { value: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0 · 260128（按量）' },
  { value: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast · 260128（按量）' },
  { value: 'doubao-seedance-2-0-mini-260615', label: 'Seedance 2.0 Mini · 260615（按量）' },
]

const ADVANCED_VENDORS = [
  {
    key: 'volcengine',
    label: '火山方舟',
    sub: 'Seedream · Seedance',
    icon: 'volcengine',
    setupGuide:
      '默认优先用「套餐」里绑定的 Agent Plan Key。也可在此填写自定义 Ark API Key / Base URL（按量或自建网关）。选 doubao-seedream / doubao-seedance 时走此渠道。',
    officialUrl: 'https://www.volcengine.com/docs/82379/2366394?lang=zh',
    officialLabel: 'Agent Plan / 媒体模型说明',
  },
  {
    key: 'dashscope',
    label: '通义万相',
    sub: 'Wan 生图/视频',
    icon: 'alibabacloud',
    setupGuide:
      '在阿里云百炼控制台创建 DashScope API Key，并启用本渠道。默认 wan2.7-image（多模态同步）/ wan2.7-i2v（media[] 异步）；仍可显式指定 wan2.6-* 走旧协议。',
    officialUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key',
    officialLabel: '百炼 API Key 说明',
  },
  {
    key: 'openai-image',
    label: 'OpenAI 生图',
    sub: 'GPT · Qwen-Image',
    icon: 'openai',
    setupGuide:
      '官方：api.openai.com + gpt-image-2.5-*。兼容网关（如 hon-maas）：Base URL 填 …/v1，模型用 Qwen-Image-2.1 或 Qwen-Image-2.1/QY5。',
    officialUrl: 'https://developers.openai.com/api/docs/guides/image-generation',
    officialLabel: 'OpenAI Images 文档',
  },
  {
    key: 'minimax',
    label: 'MiniMax 视频',
    sub: 'H3 · H3 Max',
    icon: 'minimax',
    setupGuide:
      '官方：api.minimax.cn + MiniMax-H3。OpenAI Videos 网关（如 hon-maas）：Base URL 填 …/v1（勿多加 /videos），模型用 minimax-h3 或 minimax-h3/QY3；走 multipart /videos。',
    officialUrl: 'https://platform.minimax.io/docs/guides/video-generation',
    officialLabel: 'MiniMax 视频文档',
  },
  {
    key: 'volcengine-tts',
    label: '火山语音',
    sub: '合成 · 识别',
    icon: 'volcengine',
    setupGuide: '',
    officialUrl: 'https://console.volcengine.com/speech/service/8',
    officialLabel: '获取 API Key',
  },
  {
    key: 'kling',
    label: '可灵',
    sub: 'Kling 生图/视频',
    icon: null,
    setupGuide: '在可灵开放平台获取 Access Key ID + Secret，或 Bearer API Key。',
    officialUrl: 'https://klingai.com/cn/dev/document-api/quickStart/productIntroduction/overview',
    officialLabel: '可灵 API 文档',
  },
  {
    key: 'agnes',
    label: 'Agnes AI',
    sub: 'Image 2.1 · Video v2.0',
    icon: null,
    setupGuide: '在 Agnes 平台申请 API Key，用于生图、改图、生视频。官方文档见 agnes-ai.com/doc/overview。',
    officialUrl: 'https://agnes-ai.com/doc/overview',
    officialLabel: 'Agnes API 文档',
  },
  {
    key: 'aliyun',
    label: '阿里云',
    sub: '字幕提取',
    icon: 'alibabacloud',
    setupGuide: '配置 AccessKey 与 OSS Bucket，用于字幕提取（可选）。',
    officialUrl: 'https://help.aliyun.com/zh/vod/use-cases/subtitle-extraction',
    officialLabel: '字幕提取文档',
  },
]

const CREATIVE_VENDOR_KEYS = new Set([
  'volcengine',
  'dashscope',
  'openai-image',
  'minimax',
  'kling',
  'agnes',
  'aliyun',
])
const VOICE_VENDOR_KEYS = new Set(['volcengine-tts'])

const ALWAYS_VISIBLE_CREATIVE_KEYS = new Set(['volcengine', 'dashscope', 'openai-image', 'minimax'])
const ALWAYS_VISIBLE_VOICE_KEYS = new Set(['volcengine-tts'])

const ALL_VENDORS = [...ADVANCED_VENDORS]

/** @type {'creative' | 'voice'} */
let _railMode = 'creative'
/** @type {{ tier_id?: string, status?: string } | null} */
let _volcPlanBinding = null

function vendorsForMode(mode = _railMode) {
  const keys = mode === 'voice' ? VOICE_VENDOR_KEYS : CREATIVE_VENDOR_KEYS
  return ALL_VENDORS.filter((v) => keys.has(v.key))
}

function alwaysVisibleKeys(mode = _railMode) {
  return mode === 'voice' ? ALWAYS_VISIBLE_VOICE_KEYS : ALWAYS_VISIBLE_CREATIVE_KEYS
}

function defaultVendorForMode(mode = _railMode) {
  return mode === 'voice' ? 'volcengine-tts' : 'volcengine'
}

function isVolcPlanActive() {
  return String(_volcPlanBinding?.status || '').toLowerCase() === 'active'
}

async function refreshVolcPlanBinding() {
  try {
    const { api } = await import('../../lib/tauri-api.js')
    const bindRes = await api.listPlanBindings(false)
    const items = Array.isArray(bindRes?.items) ? bindRes.items : []
    _volcPlanBinding =
      items.find((b) => b.catalog_id === 'volcengine.agent_plan' && b.status === 'active') ||
      items.find(
        (b) => b.vendor === 'volcengine' && b.plan_family === 'agent_plan' && b.status === 'active',
      ) ||
      null
  } catch {
    _volcPlanBinding = null
  }
}

function railVendors(creds = _loaded, mode = _railMode) {
  const pool = vendorsForMode(mode)
  const alwaysKeys = alwaysVisibleKeys(mode)
  const always = pool.filter((v) => alwaysKeys.has(v.key))
  const extra = pool.filter((v) => !alwaysKeys.has(v.key) && isVendorConfigured(v.key, creds))
  const seen = new Set()
  const out = []
  for (const v of [...always, ...extra]) {
    if (seen.has(v.key)) continue
    seen.add(v.key)
    out.push(v)
  }
  return out
}

function isVoiceVendor(key) {
  return VOICE_VENDOR_KEYS.has(key)
}

const SECRET_IDS = [
  'volcengineApiKey',
  'dashscopeApiKey',
  'klingAccessKeyId',
  'klingAccessKeySecret',
  'klingApiKey',
  'agnesApiKey',
  'volcengineSpeechApiKey',
  'volcengineTtsAccessToken',
  'openaiImageApiKey',
  'minimaxMediaApiKey',
  'aliyunAccessKeySecret',
]

/** @type {HTMLElement | null} */
let _modelsPage = null
/** @type {{ activeSection?: string } | null} */
let _modelsState = null
/** @type {Record<string, unknown>} */
let _loaded = { ...DEFAULT_MEDIA_CREDENTIALS }
/** @type {Record<string, unknown>} */
let _draft = { ...DEFAULT_MEDIA_CREDENTIALS }
let _selected = 'dashscope'
let _pickerMode = false
/** @type {((e: Event) => void) | null} */
let _clickHandler = null
/** @type {ReturnType<typeof setTimeout> | null} */
let _autosaveTimer = null
let _autosaveInflight = false
let _autosaveQueued = false

function vendorByKey(key) {
  return ALL_VENDORS.find((x) => x.key === key) || ALL_VENDORS[0]
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

function vendorIcon(v) {
  if (v.icon) {
    return `<img src="${publicIconUrl(v.icon)}" alt="" width="22" height="22" style="width:22px;height:22px;object-fit:contain"/>`
  }
  if (v.key === 'kling') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="4" fill="#1a1a2e"/><path d="M8 10h8v4H8z" fill="#7c3aed"/></svg>`
  }
  if (v.key === 'agnes') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#0ea5e9"/><path d="M8 12h8M12 8v8" stroke="#fff" stroke-width="1.5"/></svg>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22"><rect x="3" y="3" width="18" height="18" rx="5" fill="#64748b"/></svg>`
}

function isVendorConfigured(key, creds) {
  const c = creds?._configured || {}
  switch (key) {
    case 'volcengine':
      return !!(
        c.volcengineApiKey ||
        isFieldConfigured(creds, 'volcengineApiKey') ||
        isVolcPlanActive()
      )
    case 'agnes':
      return !!c.agnesApiKey
    case 'volcengine-tts':
      return !!(
        c.volcengineSpeechApiKey ||
        c.volcengineApiKey ||
        isFieldConfigured(creds, 'volcengineSpeechApiKey') ||
        isFieldConfigured(creds, 'volcengineApiKey')
      )
    case 'dashscope':
      return !!c.dashscopeApiKey
    case 'openai-image':
      return !!(c.openaiImageApiKey || isFieldConfigured(creds, 'openaiImageApiKey'))
    case 'minimax':
      return !!(c.minimaxMediaApiKey || isFieldConfigured(creds, 'minimaxMediaApiKey'))
    case 'kling':
      return !!(c.klingApiKey || (c.klingAccessKeyId && c.klingAccessKeySecret))
    case 'aliyun':
      return !!(
        String(creds.aliyunAccessKeyId || '').trim() &&
        (c.aliyunAccessKeySecret || isFieldConfigured(creds, 'aliyunAccessKeySecret'))
      )
    default:
      return false
  }
}

function isVendorEnabled(key, creds) {
  return !!getEnabledVendors(creds)[key]
}

function configuredVendors(creds = _loaded, mode = _railMode) {
  return vendorsForMode(mode).filter((v) => isVendorConfigured(v.key, creds))
}

function unconfiguredVendors(creds = _loaded, mode = _railMode) {
  return vendorsForMode(mode).filter((v) => !isVendorConfigured(v.key, creds))
}

function vendorRailItemHtml(v, creds) {
  const active = !_pickerMode && _selected === v.key
  const configured = isVendorConfigured(v.key, creds)
  if (!configured) {
    return `<button type="button" class="models-vendor-item${active ? ' active' : ''}"
    data-media-vendor="${escAttr(v.key)}">
    <span class="models-vendor-icon" aria-hidden="true">${vendorIcon(v)}</span>
    <span class="models-vendor-meta">
      <span class="models-vendor-label-row">
        <span class="models-vendor-label">${escHtml(v.label)}</span>
        <span class="models-vendor-disabled-badge" title="尚未配置">未配置</span>
      </span>
      <span class="models-vendor-sub">${escHtml(v.sub)} · 点击填写</span>
    </span>
  </button>`
  }
  const enabled = isVendorEnabled(v.key, creds)
  const hasLocalKey =
    v.key === 'volcengine' &&
    !!(creds?._configured?.volcengineApiKey || isFieldConfigured(creds, 'volcengineApiKey'))
  const planBadge =
    v.key === 'volcengine' && isVolcPlanActive()
      ? `<span class="models-vendor-primary-badge" title="Agent Plan 已绑定">套餐${
          _volcPlanBinding?.tier_id ? ` · ${escHtml(String(_volcPlanBinding.tier_id))}` : ''
        }</span>`
      : ''
  const badge = !enabled
    ? '<span class="models-vendor-disabled-badge" title="已配置但未启用">停用</span>'
    : planBadge || '<span class="models-vendor-primary-badge" title="Agent 可调用">启用</span>'
  let sub = enabled ? 'Agent 可调用' : '已配置 · 未启用'
  if (v.key === 'volcengine') {
    if (isVolcPlanActive() && hasLocalKey) sub = '套餐 Key · 也可自定义下方 Key'
    else if (isVolcPlanActive()) sub = 'Agent Plan 已接通'
    else if (hasLocalKey) sub = enabled ? '自定义 Key · Agent 可调用' : '已填自定义 Key · 未启用'
  }
  return `<button type="button" class="models-vendor-item configured${active ? ' active' : ''}"
    data-media-vendor="${escAttr(v.key)}">
    <span class="models-vendor-icon" aria-hidden="true">${vendorIcon(v)}</span>
    <span class="models-vendor-meta">
      <span class="models-vendor-label-row">
        <span class="models-vendor-label">${escHtml(v.label)}</span>
        ${badge}
      </span>
      <span class="models-vendor-sub">${escHtml(sub)}</span>
    </span>
  </button>`
}

function renderRail() {
  const creativeList = _modelsPage?.querySelector('#creative-vendor-rail')
  if (creativeList) {
    creativeList.innerHTML = railVendors(_loaded, 'creative')
      .map((v) => vendorRailItemHtml(v, _loaded))
      .join('')
  }
  const voiceList = _modelsPage?.querySelector('#media-vendor-rail')
  if (voiceList) {
    voiceList.innerHTML = railVendors(_loaded, 'voice')
      .map((v) => vendorRailItemHtml(v, _loaded))
      .join('')
  }
}

function modelsLayoutRoot(page) {
  if (!page) return null
  const inner = page.querySelector(':scope > .models-split-layout')
  if (inner) return inner
  if (page.classList?.contains('models-split-layout')) return page
  return page
}

function getSidebarSection(page, section) {
  const root = modelsLayoutRoot(page)
  return root?.querySelector(`#${section}-sidebar-section`) ?? null
}

function setSectionExpanded(page, section, expanded) {
  const sec = getSidebarSection(page, section)
  if (!sec) return
  sec.classList.toggle('collapsed', !expanded)
  sec.querySelector(`[data-sidebar-section-toggle="${section}"]`)?.setAttribute(
    'aria-expanded',
    expanded ? 'true' : 'false',
  )
}

function applySidebarSection(page, section) {
  if (!page) return
  setSectionExpanded(page, 'models', section === 'models')
  setSectionExpanded(page, 'creative', section === 'creative')
  setSectionExpanded(page, 'media', section === 'media' || section === 'voice')
}

function toggleSectionCollapsed(page, section) {
  const sec = getSidebarSection(page, section)
  if (!sec) return true
  sec.classList.toggle('collapsed')
  const collapsed = sec.classList.contains('collapsed')
  sec.querySelector(`[data-sidebar-section-toggle="${section}"]`)?.setAttribute(
    'aria-expanded',
    collapsed ? 'false' : 'true',
  )
  return !collapsed
}

/** @deprecated use toggleSectionCollapsed */
export function toggleSidebarSectionHead(page, section) {
  const sec = getSidebarSection(page, section)
  if (!sec) return false
  if (sec.classList.contains('collapsed')) {
    applySidebarSection(page, section)
    return true
  }
  setSectionExpanded(page, section, false)
  return false
}

/** @type {Array<{ btn: Element, fn: (e: Event) => void }>} */
const _sectionHeadBindings = []

function unbindSectionHeads() {
  for (const { btn, fn } of _sectionHeadBindings) {
    btn.removeEventListener('click', fn)
  }
  _sectionHeadBindings.length = 0
}

function bindSidebarSectionToggles(page, modelsState, callbacks = {}) {
  unbindSectionHeads()
  const root = modelsLayoutRoot(page)
  if (!root) return

  root.querySelectorAll('[data-sidebar-section-toggle]').forEach((btn) => {
    const section = btn.getAttribute('data-sidebar-section-toggle')
    if (!section) return
    const fn = (e) => {
      e.preventDefault()
      e.stopPropagation()
      const expanded = toggleSectionCollapsed(page, section)
      if (section === 'models') {
        if (expanded) {
          if (modelsState) modelsState.activeSection = 'models'
          page.querySelector('#default-model-bar')?.removeAttribute('hidden')
          clearMediaSelection(page)
          callbacks.onModelsSectionExpand?.()
        }
        return
      }
      if ((section === 'media' || section === 'creative') && expanded) {
        const mode = section === 'creative' ? 'creative' : 'voice'
        _railMode = mode
        if (modelsState) modelsState.activeSection = mode
        page.querySelector('#default-model-bar')?.setAttribute('hidden', '')
        _selected = defaultVendorForMode(mode)
        _pickerMode = false
        renderDetail()
      }
    }
    btn.addEventListener('click', fn)
    _sectionHeadBindings.push({ btn, fn })
  })
}

function enableToggleHtml(vendorKey, creds) {
  const configured = isVendorConfigured(vendorKey, creds)
  // 火山生图/视频：套餐可用或未填 Key 时也显示开关（默认启用）
  if (!configured && vendorKey !== 'volcengine-tts' && vendorKey !== 'volcengine') return ''
  const enabled =
    (vendorKey === 'volcengine-tts' || vendorKey === 'volcengine') && !configured
      ? true
      : isVendorEnabled(vendorKey, creds)
  const label =
    vendorKey === 'volcengine-tts'
      ? '启用语音功能'
      : vendorKey === 'volcengine'
        ? '启用火山生图/生视频'
        : '启用（Agent 可调用）'
  return `
    <div class="media-enable-row">
      <label class="media-enable-label">
        <input type="checkbox" data-media-enabled ${enabled ? 'checked' : ''}>
        <span>${escHtml(label)}</span>
      </label>
    </div>`
}

function secretFieldHtml(id, label, creds) {
  const configured = isFieldConfigured(creds, id)
  const masked = maskedSecretHint(creds, id)
  const ph = configured
    ? masked && masked !== '已配置'
      ? `已保存 ${masked} · 留空不修改`
      : '留空表示不修改'
    : '粘贴 Key 后自动保存'
  const status = configured
    ? `<p class="form-hint media-secret-status media-secret-status--ok">已保存${
        masked && masked !== '已配置' ? ` · <code>${escHtml(masked)}</code>` : ''
      }</p>`
    : ''
  return `
    <div class="form-group">
      <label class="form-label" for="media-${escAttr(id)}">${escHtml(label)}</label>
      ${status}
      <input id="media-${escAttr(id)}" class="form-input" type="password" autocomplete="off"
        placeholder="${escAttr(ph)}" data-media-secret="${escAttr(id)}">
    </div>`
}

function textFieldHtml(id, label, placeholder, creds) {
  const v = creds[id]
  const val = v != null && !String(v).includes('*') ? escAttr(v) : ''
  return `
    <div class="form-group">
      <label class="form-label" for="media-${escAttr(id)}">${escHtml(label)}</label>
      <input id="media-${escAttr(id)}" class="form-input" type="text"
        value="${val}" placeholder="${escAttr(placeholder || '')}" data-media-field="${escAttr(id)}">
    </div>`
}

function jimengModelFieldHtml(fieldId, label, presets, creds, hint, customPlaceholder) {
  const raw = String(_draft[fieldId] ?? creds[fieldId] ?? presets[0]?.value ?? '').trim()
  const isPreset = presets.some((p) => p.value === raw)
  const selectValue = isPreset ? raw : '__custom__'
  const customVal = isPreset ? '' : escAttr(raw)
  const options = presets
    .map(
      (p) =>
        `<option value="${escAttr(p.value)}"${selectValue === p.value ? ' selected' : ''}>${escHtml(p.label)}</option>`,
    )
    .join('')
  const customHiddenAttr = selectValue === '__custom__' ? '' : ' hidden'
  const customPh = customPlaceholder || '例如 ep-20250101123456-abcde'
  return `
    <div class="form-group media-model-field" data-media-model-group="${escAttr(fieldId)}">
      <label class="form-label" for="media-${escAttr(fieldId)}-select">${escHtml(label)}</label>
      ${hint ? `<p class="form-hint">${escHtml(hint)}</p>` : ''}
      <select id="media-${escAttr(fieldId)}-select" class="form-input" data-media-model-select="${escAttr(fieldId)}">
        ${options}
        <option value="__custom__"${selectValue === '__custom__' ? ' selected' : ''}>自定义（ep-... 或模型 ID）</option>
      </select>
      <input id="media-${escAttr(fieldId)}-custom" class="form-input media-model-custom"
        type="text" value="${customVal}" placeholder="${escAttr(customPh)}"
        data-media-model-custom="${escAttr(fieldId)}"${customHiddenAttr}>
    </div>`
}

function bindJimengModelFields(panel) {
  panel.querySelectorAll('[data-media-model-select]').forEach((sel) => {
    const fieldId = sel.getAttribute('data-media-model-select')
    if (!fieldId) return
    const custom = panel.querySelector(`[data-media-model-custom="${CSS.escape(fieldId)}"]`)
    const syncCustomVisibility = () => {
      const isCustom = sel.value === '__custom__'
      if (custom) {
        if (isCustom) {
          custom.removeAttribute('hidden')
        } else {
          custom.setAttribute('hidden', '')
          custom.value = ''
        }
      }
    }
    sel.addEventListener('change', syncCustomVisibility)
    syncCustomVisibility()
  })
}

function bindMediaAdvancedToggle(panel) {
  const btn = panel.querySelector('[data-media-advanced-toggle]')
  const group = panel.querySelector('[data-media-advanced-group]')
  if (!btn || !group) return
  group.setAttribute('hidden', '')
  btn.classList.remove('open')
  btn.setAttribute('aria-expanded', 'false')
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const open = !group.hasAttribute('hidden')
    if (open) {
      group.setAttribute('hidden', '')
      btn.classList.remove('open')
      btn.setAttribute('aria-expanded', 'false')
    } else {
      group.removeAttribute('hidden')
      btn.classList.add('open')
      btn.setAttribute('aria-expanded', 'true')
    }
  })
}

function buildVolcengineTtsHeader() {
  return `
    <header class="media-vendor-detail-head media-vendor-detail-head--speech">
      <h3 class="media-vendor-detail-title">火山语音</h3>
      <p class="media-vendor-detail-desc">小V Frame 语音运行时默认走火山 ASR/TTS；下方可选其它通道（需已配置凭证）。</p>
      <p class="media-vendor-help-links">
        <a href="https://console.volcengine.com/speech/service/8" target="_blank" rel="noopener noreferrer">获取 API Key</a>
        <span class="media-tts-speaker-hint-sep">·</span>
        <a href="https://www.volcengine.com/docs/82379/2516286?lang=zh" target="_blank" rel="noopener noreferrer">Agent Plan 说明</a>
        <span class="media-tts-speaker-hint-sep">·</span>
        <a href="${escAttr(VOLCENGINE_TTS_SPEAKER_DOC_URL)}" target="_blank" rel="noopener noreferrer">音色列表</a>
      </p>
    </header>`
}

function buildXiaomiProviderFieldsHtml() {
  return `
    <div class="form-field" data-xiaomi-voice-providers>
      <label class="form-label">小V · 识别通道（ASR）</label>
      <select class="form-input" data-xiaomi-asr-provider>
        <option value="volcengine">火山引擎（默认）</option>
        <option value="whisper">本地 Whisper</option>
      </select>
      <p class="form-hint" data-xiaomi-asr-hint></p>
    </div>
    <div class="form-field">
      <label class="form-label">小V · 合成通道（TTS）</label>
      <select class="form-input" data-xiaomi-tts-provider>
        <option value="volcengine">火山引擎（默认）</option>
        <option value="doubao">豆包（方舟）</option>
        <option value="openai">OpenAI TTS</option>
        <option value="elevenlabs">ElevenLabs</option>
        <option value="minimax">MiniMax</option>
        <option value="dashscope">阿里 DashScope</option>
      </select>
      <p class="form-hint" data-xiaomi-tts-hint></p>
    </div>`
}

function buildVolcengineTtsFieldsHtml(creds) {
  return `
    ${secretFieldHtml('volcengineSpeechApiKey', 'API Key', creds)}
    ${buildXiaomiProviderFieldsHtml()}
    ${buildTtsSpeakerFieldHtml('volcengineTtsSpeaker', '朗读音色', VOLCENGINE_TTS_SPEAKER_PRESETS, creds, {
      showVoiceId: false,
      customModeLabel: '自定义音色',
      customPlaceholder: '输入音色 ID',
    })}
    <button type="button" class="media-advanced-toggle gw-advanced-toggle" data-media-advanced-toggle aria-expanded="false">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      <span>高级设置</span>
    </button>
    <div class="media-advanced-group" data-media-advanced-group hidden>
      ${textFieldHtml('volcengineTtsResourceId', 'TTS 模型', 'seed-tts-2.0', creds)}
      <p class="form-hint">小V 语音全屏走 Frame 运行时（/api/speech/session）；切句与打断由后端编排。</p>
    </div>`
}

function buildVolcengineCreativeHeader() {
  const tier = String(_volcPlanBinding?.tier_id || '').trim()
  const planLine = isVolcPlanActive()
    ? `<p class="form-hint media-vendor-setup-guide">Agent Plan 已绑定${
        tier ? `（${escHtml(tier)}）` : ''
      }：生图/生视频优先用套餐 Key。下方可改默认模型，或另填自定义 Ark Key / Base URL。</p>`
    : `<p class="form-hint media-vendor-setup-guide">未绑定套餐时，请填写 Ark API Key。也可到「套餐」Tab 绑定 Agent Plan 后自动接通。</p>`
  return `
    <header class="media-vendor-detail-head">
      <h3 class="media-vendor-detail-title">火山方舟</h3>
      ${planLine}
      <p class="media-vendor-official-link">
        <a href="https://www.volcengine.com/docs/82379/2366394?lang=zh" target="_blank" rel="noopener noreferrer">套餐与媒体模型说明</a>
        <span class="media-tts-speaker-hint-sep"> · </span>
        <a href="https://console.volcengine.com/ark" target="_blank" rel="noopener noreferrer">方舟控制台</a>
      </p>
    </header>`
}

function buildVolcengineCreativeFieldsHtml(creds) {
  return `
    ${secretFieldHtml('volcengineApiKey', 'Ark API Key（可选）', creds)}
    <p class="form-hint">有 Agent Plan 时可留空。自定义 Key 用于按量 / 兼容网关，保存后与套餐并行：运行时优先套餐 Key。</p>
    ${textFieldHtml(
      'volcengineArkBaseUrl',
      'Ark Base URL（可选）',
      'https://ark.cn-beijing.volces.com/api/plan/v3',
      creds,
    )}
    ${textFieldHtml(
      'jimengVideoBaseUrl',
      '视频 API Base（可选）',
      '默认跟随 Ark Base / 方舟视频口',
      creds,
    )}
    ${jimengModelFieldHtml(
      'jimengImageModel',
      '默认生图模型',
      JIMENG_IMAGE_MODEL_PRESETS,
      creds,
      'Agent 未显式传 model 时使用',
    )}
    ${jimengModelFieldHtml(
      'jimengVideoModel',
      '默认生视频模型',
      JIMENG_VIDEO_MODEL_PRESETS,
      creds,
      'Large/Max 套餐可用 Seedance；Small/Medium 官方不含视频',
    )}
  `
}

function buildDetailHtml(vendorKey, creds) {
  const v = vendorByKey(vendorKey)
  let fields
  switch (vendorKey) {
    case 'volcengine':
      fields = buildVolcengineCreativeFieldsHtml(creds)
      break
    case 'agnes':
      fields = `
        ${secretFieldHtml('agnesApiKey', 'API Key', creds)}
      `
      break
    case 'volcengine-tts':
      fields = buildVolcengineTtsFieldsHtml(creds)
      break
    case 'dashscope':
      fields = `
        ${secretFieldHtml('dashscopeApiKey', 'API Key', creds)}
        ${textFieldHtml('dashscopeBaseUrl', 'Base URL（可选）', 'https://dashscope.aliyuncs.com/api/v1', creds)}
        <p class="form-hint">生图推荐 wan2.7-image / wan2.7-image-pro；图生视频 wan2.7-i2v（支持首尾帧 + driving_audio）。兼容 wan2.6-t2i / wan2.6-i2v。</p>
      `
      break
    case 'openai-image':
      fields = `
        ${secretFieldHtml('openaiImageApiKey', 'API Key', creds)}
        ${textFieldHtml('openaiImageBaseUrl', 'Base URL（可选）', 'https://api.openai.com/v1', creds)}
        <p class="form-hint">官方用 gpt-image-2.5-*。第三方 OpenAI Images 网关填 https://…/v1（勿多加 /images/generations），模型用 Qwen-Image-2.1。</p>
      `
      break
    case 'minimax':
      fields = `
        ${secretFieldHtml('minimaxMediaApiKey', 'API Key', creds)}
        ${textFieldHtml('minimaxMediaBaseUrl', 'Base URL（可选）', 'https://api.minimax.cn', creds)}
        <p class="form-hint">官方默认 https://api.minimax.cn（模型 MiniMax-H3）。第三方网关（hon-maas）填 https://…/v1（勿多加 /videos），模型用 minimax-h3 或 minimax-h3/QY3。与 TTS Key 分开。</p>
      `
      break
    case 'kling':
      fields = `
        ${secretFieldHtml('klingAccessKeyId', 'Access Key ID', creds)}
        ${secretFieldHtml('klingAccessKeySecret', 'Access Key Secret', creds)}
        ${secretFieldHtml('klingApiKey', '或 Bearer API Key', creds)}
        ${textFieldHtml('klingApiBase', 'API Base（可选）', 'https://api.klingai.com', creds)}
      `
      break
    case 'aliyun':
      fields = `
        ${textFieldHtml('aliyunAccessKeyId', 'Access Key ID', '', creds)}
        ${secretFieldHtml('aliyunAccessKeySecret', 'Access Key Secret', creds)}
        ${textFieldHtml('aliyunOssBucket', 'OSS Bucket', 'my-bucket', creds)}
      `
      break
    default:
      fields = '<p class="form-hint">未知厂商</p>'
  }

  const guide =
    vendorKey !== 'volcengine-tts' && vendorKey !== 'volcengine' && v.setupGuide
      ? `<p class="form-hint media-vendor-setup-guide">${escHtml(v.setupGuide)}</p>`
      : ''
  const officialLink =
    vendorKey !== 'volcengine-tts' && vendorKey !== 'volcengine' && v.officialUrl
      ? `<p class="media-vendor-official-link"><a href="${escAttr(v.officialUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(v.officialLabel || '官方文档')}</a></p>`
      : ''
  const header =
    vendorKey === 'volcengine-tts'
      ? buildVolcengineTtsHeader()
      : vendorKey === 'volcengine'
        ? buildVolcengineCreativeHeader()
        : `<header class="media-vendor-detail-head">
        <h3 class="media-vendor-detail-title">${escHtml(v.label)}</h3>
        ${guide}
        ${officialLink}
      </header>`

  return `
    <div class="media-vendor-detail" data-media-vendor-panel="${escAttr(vendorKey)}">
      ${header}
      <p class="form-hint media-save-status" data-media-save-status aria-live="polite">改动后自动保存</p>
      ${enableToggleHtml(vendorKey, creds)}
      <form class="media-vendor-form" autocomplete="off">${fields}</form>
    </div>`
}

function buildPickerHtml() {
  const pending = unconfiguredVendors()
  if (!pending.length) {
    const emptyHint =
      _railMode === 'voice'
        ? '语音渠道已配置。在左侧选择一项编辑或切换启用状态。'
        : '生图/生视频渠道均已配置。在左侧选择一项编辑或切换启用状态。'
    return `<div class="media-vendor-empty"><p class="form-hint">${emptyHint}</p></div>`
  }
  const cards = pending
    .map(
      (v) => `<button type="button" class="models-vendor-item" data-media-pick="${escAttr(v.key)}">
      <span class="models-vendor-icon" aria-hidden="true">${vendorIcon(v)}</span>
      <span class="models-vendor-meta">
        <span class="models-vendor-label">${escHtml(v.label)}</span>
        <span class="models-vendor-sub">${escHtml(v.sub)}</span>
      </span>
    </button>`,
    )
    .join('')
  return `
    <div class="media-vendor-picker">
      <h3 class="media-vendor-detail-title">${_railMode === 'voice' ? '添加语音渠道' : '添加生图/生视频渠道'}</h3>
      <p class="form-hint">选择厂商并填写 API Key，保存后可勾选启用。</p>
      <div class="media-vendor-picker-list">${cards}</div>
    </div>`
}

function syncDraftFromDetail() {
  if (!_modelsPage) return
  const panel = _modelsPage.querySelector(`[data-media-vendor-panel="${CSS.escape(_selected)}"]`)
  if (!panel) return
  panel.querySelectorAll('[data-media-field]').forEach((el) => {
    const key = el.getAttribute('data-media-field')
    if (key) _draft[key] = el.value.trim()
  })
  panel.querySelectorAll('[data-media-secret]').forEach((el) => {
    const key = el.getAttribute('data-media-secret')
    const v = el.value.trim()
    if (key && v) _draft[key] = v
  })
  panel.querySelectorAll('[data-media-model-select]').forEach((el) => {
    const key = el.getAttribute('data-media-model-select')
    if (!key) return
    if (el.value === '__custom__') {
      const custom = panel.querySelector(`[data-media-model-custom="${CSS.escape(key)}"]`)
      _draft[key] = custom?.value.trim() || ''
    } else {
      _draft[key] = el.value
    }
  })
  Object.assign(_draft, readTtsSpeakerDraft(panel))
}

function collectPatch() {
  syncDraftFromDetail()
  const patch = {}
  for (const [k, v] of Object.entries(_draft)) {
    if (k.startsWith('_')) continue
    if (k === 'enabledVendors') continue
    if (SECRET_IDS.includes(k)) {
      const s = String(v || '').trim()
      if (s && !s.includes('*')) patch[k] = s
    } else if (k in DEFAULT_MEDIA_CREDENTIALS) {
      patch[k] = String(v ?? '').trim()
    }
  }
  const panel = _modelsPage?.querySelector(`[data-media-vendor-panel="${CSS.escape(_selected)}"]`)
  const enabledEl = panel?.querySelector('[data-media-enabled]')
  if (enabledEl) {
    patch.enabledVendors = { ...getEnabledVendors(_loaded), [_selected]: enabledEl.checked }
  }
  return patch
}

function showMediaDetailPanel() {
  if (!_modelsPage) return
  const section = _railMode === 'creative' ? 'creative' : 'media'
  setSectionExpanded(_modelsPage, section, true)
  const bar = _modelsPage.querySelector('#default-model-bar')
  bar?.setAttribute('hidden', '')
  _modelsPage.querySelectorAll('#models-provider-rail .models-vendor-item.active').forEach((el) => {
    el.classList.remove('active')
  })
  if (_modelsState) _modelsState.activeSection = _railMode
  renderDetail()
}

function focusMediaSection() {
  if (!_modelsPage) return
  const section = _railMode === 'creative' ? 'creative' : 'media'
  setSectionExpanded(_modelsPage, section, true)
  if (_modelsState) _modelsState.activeSection = _railMode
  _modelsPage.querySelector('#default-model-bar')?.setAttribute('hidden', '')
  _modelsPage.querySelectorAll('#models-provider-rail .models-vendor-item.active').forEach((el) => {
    el.classList.remove('active')
  })
}

function renderDetail() {
  const mount = _modelsPage?.querySelector('#models-detail-inner')
  if (!mount) return
  try {
    mount.innerHTML = _pickerMode ? buildPickerHtml() : buildDetailHtml(_selected, { ..._loaded, ..._draft })
    if (_pickerMode) return
    const panel = mount.querySelector('[data-media-vendor-panel]')
    if (!panel) return
    panel.querySelectorAll('[data-media-field]').forEach((el) => {
      const key = el.getAttribute('data-media-field')
      if (!key) return
      const d = _draft[key]
      if (d != null && !String(d).includes('*')) el.value = String(d)
    })
    bindJimengModelFields(panel)
    bindTtsSpeakerFields(panel, VOLCENGINE_TTS_SPEAKER_PRESETS)
    bindMediaAdvancedToggle(panel)
    bindAutosave(panel)
    void bindXiaomiProviderFields(panel)
  } catch (e) {
    mount.innerHTML = `<p style="color:var(--error);padding:16px">渲染失败：${escHtml(e?.message || e)}</p>`
  }
}

async function bindXiaomiProviderFields(panel) {
  if (!panel) return
  const asrEl = panel.querySelector('[data-xiaomi-asr-provider]')
  const ttsEl = panel.querySelector('[data-xiaomi-tts-provider]')
  if (!asrEl && !ttsEl) return
  try {
    const {
      getXiaomiAsrProvider,
      setXiaomiAsrProvider,
      getXiaomiTtsProvider,
      setXiaomiTtsProvider,
    } = await import('../../lib/xiaomi-voice/config.js')
    if (asrEl) {
      asrEl.value = getXiaomiAsrProvider()
      asrEl.addEventListener('change', () => {
        setXiaomiAsrProvider(asrEl.value)
        const hint = panel.querySelector('[data-xiaomi-asr-hint]')
        if (hint) hint.textContent = `已选择 ${asrEl.value}（下次进入小V语音全屏生效）`
      })
    }
    if (ttsEl) {
      ttsEl.value = getXiaomiTtsProvider()
      ttsEl.addEventListener('change', () => {
        setXiaomiTtsProvider(ttsEl.value)
        const hint = panel.querySelector('[data-xiaomi-tts-hint]')
        if (hint) hint.textContent = `已选择 ${ttsEl.value}（需对应厂商凭证已配置）`
      })
    }
    // Validate against gateway catalogs (best-effort)
    const apiBase = import.meta.env?.DEV ? '/api/speech' : null
    if (apiBase) {
      try {
        const { apiUrl } = await import('../../lib/api-client.js')
        const base = import.meta.env?.DEV ? '/api/speech' : apiUrl('/speech')
        const [asrRes, ttsRes] = await Promise.all([
          fetch(`${base}/asr/providers`, { credentials: 'same-origin' }).then((r) => r.json()).catch(() => null),
          fetch(`${base}/tts/providers`, { credentials: 'same-origin' }).then((r) => r.json()).catch(() => null),
        ])
        const asrHint = panel.querySelector('[data-xiaomi-asr-hint]')
        const ttsHint = panel.querySelector('[data-xiaomi-tts-hint]')
        if (asrHint && asrRes?.providers) {
          const hit = asrRes.providers.find((p) => p.id === asrEl?.value)
          asrHint.textContent = hit?.configured ? '凭证就绪' : '当前通道未配置 / 不可用'
        }
        if (ttsHint && ttsRes?.providers) {
          const hit = ttsRes.providers.find((p) => p.id === ttsEl?.value)
          ttsHint.textContent = hit?.configured ? '凭证就绪' : '当前通道未配置 / 不可用'
        }
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    console.warn('[media] xiaomi provider bind failed', e)
  }
}

function selectMediaVendor(key, { picker = false } = {}) {
  if (!key || !ALL_VENDORS.some((v) => v.key === key)) return
  syncDraftFromDetail()
  _railMode = isVoiceVendor(key) ? 'voice' : 'creative'
  _selected = key
  _pickerMode = picker
  renderRail()
  showMediaDetailPanel()
}

function openAddPicker() {
  _pickerMode = true
  focusMediaSection()
  _modelsPage
    ?.querySelectorAll('#creative-vendor-rail .models-vendor-item.active, #media-vendor-rail .models-vendor-item.active')
    .forEach((el) => {
      el.classList.remove('active')
    })
  renderDetail()
}

function setSaveStatus(text, { ok = false } = {}) {
  const el = _modelsPage?.querySelector('[data-media-save-status]')
  if (!el) return
  el.textContent = text
  el.classList.toggle('media-save-status--ok', ok)
}

function scheduleAutosave() {
  if (_autosaveTimer) clearTimeout(_autosaveTimer)
  setSaveStatus('保存中…')
  _autosaveTimer = setTimeout(() => {
    _autosaveTimer = null
    void onSave({ quiet: false, fromAutosave: true })
  }, 350)
}

function bindAutosave(panel) {
  if (!panel || panel.dataset.mediaAutosaveBound === '1') return
  panel.dataset.mediaAutosaveBound = '1'
  const kick = () => scheduleAutosave()
  panel.querySelector('[data-media-enabled]')?.addEventListener('change', kick)
  // One listener for selects / secret blur / speaker picker — debounce coalesces bursts.
  panel.addEventListener('change', (e) => {
    const t = e.target
    if (!(t instanceof HTMLElement)) return
    if (t.closest('[data-xiaomi-voice-providers], [data-xiaomi-asr-provider], [data-xiaomi-tts-provider]')) {
      return // Xiaomi channel prefs persist locally; not media.credentials
    }
    if (t.matches('input, select, textarea') || t.closest('[data-tts-speaker], [data-media-model-group]')) {
      kick()
    }
  })
  panel.addEventListener(
    'blur',
    (e) => {
      const t = e.target
      if (!(t instanceof HTMLElement)) return
      if (t.matches('[data-media-secret], [data-media-field], [data-media-model-custom], [data-tts-speaker-custom]')) {
        kick()
      }
    },
    true,
  )
}

async function onSave({ quiet = false, fromAutosave = false } = {}) {
  if (_autosaveInflight) {
    _autosaveQueued = true
    return true
  }
  _autosaveInflight = true
  try {
    const wasConfigured = isVendorConfigured(_selected, _loaded)
    const patch = collectPatch()
    if (!wasConfigured) {
      patch.enabledVendors = { ...getEnabledVendors(_loaded), [_selected]: true }
    }
    if (_selected === 'volcengine-tts') {
      const panel = _modelsPage?.querySelector(`[data-media-vendor-panel="${CSS.escape(_selected)}"]`)
      const enabledEl = panel?.querySelector('[data-media-enabled]')
      const toggledOff = enabledEl && !enabledEl.checked
      const hasSpeechKey = !!patch.volcengineSpeechApiKey
      if (!toggledOff && (hasSpeechKey || !wasConfigured)) {
        patch.enabledVendors = {
          ...getEnabledVendors(_loaded),
          ...(patch.enabledVendors || {}),
          'volcengine-tts': true,
        }
      }
    }
    await patchMediaCredentials(patch)
    _loaded = await fetchMediaCredentials()
    _draft = { ...DEFAULT_MEDIA_CREDENTIALS, ..._loaded }
    delete _draft._configured
    // Keep Xiaomi Frame session speaker in sync with saved TTS voice
    try {
      const { setXiaomiTtsSpeaker } = await import('../../lib/xiaomi-voice/config.js')
      const sp = String(patch.volcengineTtsSpeaker || _loaded.volcengineTtsSpeaker || '').trim()
      setXiaomiTtsSpeaker(sp)
    } catch {
      /* ignore */
    }
    _pickerMode = false
    renderRail()
    renderDetail()
    setSaveStatus('已保存', { ok: true })
    if (!quiet) {
      toast(
        fromAutosave
          ? '已保存'
          : isVoiceVendor(_selected)
            ? '语音配置已保存'
            : '生图/生视频渠道已保存',
        'success',
      )
    }
    window.dispatchEvent(new CustomEvent('evopanel:media-updated'))
    return true
  } catch (e) {
    setSaveStatus('保存失败', { ok: false })
    toast(String(e?.message || e), 'error')
    return false
  } finally {
    _autosaveInflight = false
    if (_autosaveQueued) {
      _autosaveQueued = false
      scheduleAutosave()
    }
  }
}

/** 设置弹窗点「完成」时落盘当前媒体配置 */
export async function flushMediaSettingsOnDone() {
  if (!_modelsPage || _pickerMode) return true
  syncDraftFromDetail()
  return onSave({ quiet: true })
}

function bindClicks() {
  if (!_modelsPage || _clickHandler) return
  _clickHandler = (e) => {
    if (e.target.closest('[data-sidebar-section-toggle]')) return
    const addBtn = e.target.closest?.('[data-media-add-vendor]')
    if (addBtn) {
      e.preventDefault()
      _railMode = 'creative'
      openAddPicker()
      return
    }
    const pick = e.target.closest?.('[data-media-pick]')
    if (pick) {
      e.preventDefault()
      selectMediaVendor(pick.getAttribute('data-media-pick'), { picker: false })
      return
    }
    const vendorBtn = e.target.closest?.('[data-media-vendor]')
    if (
      vendorBtn &&
      (vendorBtn.closest('#media-vendor-rail') || vendorBtn.closest('#creative-vendor-rail'))
    ) {
      e.preventDefault()
      selectMediaVendor(vendorBtn.getAttribute('data-media-vendor'))
    }
  }
  _modelsPage.addEventListener('click', _clickHandler)
}

/**
 * 嵌入模型设置页：生图生视频 + 语音 两个侧栏分组
 * @param {HTMLElement} page models 页根节点
 * @param {{ activeSection?: string }} modelsState
 */
export async function attachMediaToModelsPage(page, modelsState, callbacks = {}) {
  if (_modelsPage && _modelsPage !== page) cleanup()
  _modelsPage = page
  _modelsState = modelsState
  _loaded = { ...DEFAULT_MEDIA_CREDENTIALS, enabledVendors: { ...DEFAULT_ENABLED_VENDORS } }
  _draft = { ...DEFAULT_MEDIA_CREDENTIALS, enabledVendors: { ...DEFAULT_ENABLED_VENDORS } }
  _railMode = 'creative'
  _selected = defaultVendorForMode('creative')
  _pickerMode = false

  const host = page.querySelector('#media-vendor-rail-host')
  if (host) {
    host.innerHTML = `
      <section class="models-sidebar-section" id="creative-sidebar-section" data-sidebar-section="creative" hidden>
        <button type="button" class="models-sidebar-section-head" data-sidebar-section-toggle="creative" aria-expanded="true" style="display:none">
          <span>生图生视频</span>
          <svg class="models-sidebar-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <div class="models-sidebar-section-body">
          <nav id="creative-vendor-rail" class="models-vendor-list" aria-label="生图生视频渠道"></nav>
          <button type="button" class="btn btn-sm btn-secondary" data-media-add-vendor style="margin:8px 12px;width:calc(100% - 24px)">+ 添加渠道</button>
        </div>
      </section>
      <section class="models-sidebar-section" id="media-sidebar-section" data-sidebar-section="media" hidden>
        <button type="button" class="models-sidebar-section-head" data-sidebar-section-toggle="media" aria-expanded="true" style="display:none">
          <span>语音</span>
          <svg class="models-sidebar-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <div class="models-sidebar-section-body">
          <nav id="media-vendor-rail" class="models-vendor-list" aria-label="语音服务"></nav>
        </div>
      </section>
    `
  }

  setSectionExpanded(page, 'models', true)
  setSectionExpanded(page, 'creative', true)
  setSectionExpanded(page, 'media', true)

  bindSidebarSectionToggles(page, modelsState, callbacks)
  bindClicks()
  renderRail()

  try {
    await refreshVolcPlanBinding()
    _loaded = await fetchMediaCredentials()
    _draft = { ...DEFAULT_MEDIA_CREDENTIALS, ..._loaded }
    delete _draft._configured
    _selected = defaultVendorForMode(_railMode)
    renderRail()
  } catch (e) {
    toast(`加载媒体配置失败：${e?.message || e}`, 'error')
  }
}

/** 用户点击对话模型厂商时清除媒体选中态 */
export function clearMediaSelection(page) {
  const root = modelsLayoutRoot(page)
  root
    ?.querySelectorAll('#creative-vendor-rail .models-vendor-item.active, #media-vendor-rail .models-vendor-item.active')
    .forEach((el) => {
      el.classList.remove('active')
    })
  _pickerMode = false
}

export { applySidebarSection, modelsLayoutRoot, setSectionExpanded }

/**
 * 渲染生图生视频 / 语音 Tab 详情区（供 models.js tab 切换时调用）
 * @param {'creative' | 'voice'} [mode]
 */
export function renderMediaDetail(mode = 'voice') {
  _railMode = mode === 'creative' ? 'creative' : 'voice'
  _selected = defaultVendorForMode(_railMode)
  _pickerMode = false
  void refreshVolcPlanBinding().then(() => {
    renderRail()
    renderDetail()
  })
  renderRail()
  renderDetail()
}

export function cleanup() {
  unbindSectionHeads()
  if (_autosaveTimer) {
    clearTimeout(_autosaveTimer)
    _autosaveTimer = null
  }
  _autosaveInflight = false
  _autosaveQueued = false
  if (_modelsPage && _clickHandler) {
    _modelsPage.removeEventListener('click', _clickHandler)
  }
  _clickHandler = null
  _modelsPage = null
  _modelsState = null
  _draft = { ...DEFAULT_MEDIA_CREDENTIALS, enabledVendors: { ...DEFAULT_ENABLED_VENDORS } }
  _loaded = { ...DEFAULT_MEDIA_CREDENTIALS, enabledVendors: { ...DEFAULT_ENABLED_VENDORS } }
  _railMode = 'creative'
  _volcPlanBinding = null
  _selected = defaultVendorForMode('creative')
  _pickerMode = false
}

/** @deprecated 独立 Tab 已移除，保留空实现避免旧引用报错 */
export async function mountMediaForSettingsModal(container) {
  container.innerHTML =
    '<p class="form-hint" style="padding:16px">媒体配置已移至「设置 → 模型」：生图生视频 / 语音 Tab。</p>'
}

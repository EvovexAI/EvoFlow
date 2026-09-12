/**
 * 语音 API 配置 — 嵌入「设置 → 模型」页左侧分组
 */
import { toast } from '../../components/toast.js'
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

const ADVANCED_VENDORS = [
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
    key: 'dashscope',
    label: '通义万相',
    sub: 'Wan 生图/视频',
    icon: 'alibabacloud',
    setupGuide: '在阿里云百炼控制台创建 DashScope API Key。',
    officialUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key',
    officialLabel: '百炼 API Key 说明',
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
    key: 'aliyun',
    label: '阿里云',
    sub: '字幕提取',
    icon: 'alibabacloud',
    setupGuide: '配置 AccessKey 与 OSS Bucket，用于字幕提取（可选）。',
    officialUrl: 'https://help.aliyun.com/zh/vod/use-cases/subtitle-extraction',
    officialLabel: '字幕提取文档',
  },
]

const ALWAYS_VISIBLE_MEDIA_KEYS = new Set(['volcengine-tts'])

const ALL_VENDORS = [...ADVANCED_VENDORS]

/** 当前仅开放语音配置（视频渠道已下线） */
const VOICE_VENDORS = ALL_VENDORS.filter((v) => v.key === 'volcengine-tts')

function railVendors(_creds = _loaded) {
  return VOICE_VENDORS
}

const SECRET_IDS = [
  'dashscopeApiKey',
  'klingAccessKeyId',
  'klingAccessKeySecret',
  'klingApiKey',
  'agnesApiKey',
  'volcengineSpeechApiKey',
  'volcengineTtsAccessToken',
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
let _selected = 'volcengine-tts'
let _pickerMode = false
/** @type {((e: Event) => void) | null} */
let _clickHandler = null

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
    return `<img src="/icons/${escAttr(v.icon)}.svg" alt="" width="22" height="22" style="width:22px;height:22px;object-fit:contain"/>`
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

function configuredVendors(creds = _loaded) {
  return ALL_VENDORS.filter((v) => isVendorConfigured(v.key, creds))
}

function unconfiguredVendors(creds = _loaded) {
  return ALL_VENDORS.filter((v) => !isVendorConfigured(v.key, creds))
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
  const badge = enabled
    ? '<span class="models-vendor-primary-badge" title="Agent 可调用">启用</span>'
    : '<span class="models-vendor-disabled-badge" title="已配置但未启用">停用</span>'
  const sub = enabled ? 'Agent 可调用' : '已配置 · 未启用'
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
  const list = _modelsPage?.querySelector('#media-vendor-rail')
  if (!list) return
  const items = railVendors().map((v) => vendorRailItemHtml(v, _loaded)).join('')
  list.innerHTML = items
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
  setSectionExpanded(page, 'media', section === 'media')
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
      if (section === 'media' && expanded) {
        if (modelsState) modelsState.activeSection = 'media'
        page.querySelector('#default-model-bar')?.setAttribute('hidden', '')
        _selected = 'volcengine-tts'
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
  if (!configured && vendorKey !== 'volcengine-tts') return ''
  const enabled =
    vendorKey === 'volcengine-tts' && !configured ? true : isVendorEnabled(vendorKey, creds)
  const label =
    vendorKey === 'volcengine-tts' ? '启用语音功能' : '启用（Agent 可调用）'
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
  const ph = configured ? '留空表示不修改' : '粘贴 Key 后保存'
  const status = configured
    ? `<p class="form-hint media-secret-status media-secret-status--ok">已保存${masked && masked !== '已配置' ? ` · ${escHtml(masked)}` : ''}</p>`
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
      <p class="media-vendor-detail-desc">用于语音朗读与 Agent 语音回复（TTS）。输入区扬声器可开关语音播报。</p>
      <p class="media-vendor-help-links">
        <a href="https://console.volcengine.com/speech/service/8" target="_blank" rel="noopener noreferrer">获取 API Key</a>
        <span class="media-tts-speaker-hint-sep">·</span>
        <a href="https://www.volcengine.com/docs/82379/2516286?lang=zh" target="_blank" rel="noopener noreferrer">Agent Plan 说明</a>
        <span class="media-tts-speaker-hint-sep">·</span>
        <a href="${escAttr(VOLCENGINE_TTS_SPEAKER_DOC_URL)}" target="_blank" rel="noopener noreferrer">音色列表</a>
      </p>
    </header>`
}

function buildVolcengineTtsFieldsHtml(creds) {
  return `
    ${secretFieldHtml('volcengineSpeechApiKey', 'API Key', creds)}
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
      <p class="form-hint">语音识别（ASR）已临时改用系统识别；火山 ASR 配置口子已隐藏，后端逻辑仍保留。</p>
    </div>`
}

function buildDetailHtml(vendorKey, creds) {
  const v = vendorByKey(vendorKey)
  let fields
  switch (vendorKey) {
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
    vendorKey !== 'volcengine-tts' && v.setupGuide
      ? `<p class="form-hint media-vendor-setup-guide">${escHtml(v.setupGuide)}</p>`
      : ''
  const officialLink =
    vendorKey !== 'volcengine-tts' && v.officialUrl
      ? `<p class="media-vendor-official-link"><a href="${escAttr(v.officialUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(v.officialLabel || '官方文档')}</a></p>`
      : ''
  const header =
    vendorKey === 'volcengine-tts'
      ? buildVolcengineTtsHeader()
      : `<header class="media-vendor-detail-head">
        <h3 class="media-vendor-detail-title">${escHtml(v.label)}</h3>
        ${guide}
        ${officialLink}
      </header>`

  return `
    <div class="media-vendor-detail" data-media-vendor-panel="${escAttr(vendorKey)}">
      ${header}
      ${enableToggleHtml(vendorKey, creds)}
      <form class="media-vendor-form" autocomplete="off">${fields}</form>
    </div>`
}

function buildPickerHtml() {
  const pending = unconfiguredVendors()
  if (!pending.length) {
    return `<div class="media-vendor-empty"><p class="form-hint">所有视频模型厂商均已配置。在左侧选择一项编辑或切换启用状态。</p></div>`
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
      <h3 class="media-vendor-detail-title">添加视频模型厂商</h3>
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
  setSectionExpanded(_modelsPage, 'media', true)
  const bar = _modelsPage.querySelector('#default-model-bar')
  bar?.setAttribute('hidden', '')
  _modelsPage.querySelectorAll('#models-provider-rail .models-vendor-item.active').forEach((el) => {
    el.classList.remove('active')
  })
  if (_modelsState) _modelsState.activeSection = 'media'
  renderDetail()
}

function focusMediaSection() {
  if (!_modelsPage) return
  setSectionExpanded(_modelsPage, 'media', true)
  if (_modelsState) _modelsState.activeSection = 'media'
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
  } catch (e) {
    mount.innerHTML = `<p style="color:var(--error);padding:16px">渲染失败：${escHtml(e?.message || e)}</p>`
  }
}

function selectMediaVendor(key, { picker = false } = {}) {
  if (!key || !ALL_VENDORS.some((v) => v.key === key)) return
  syncDraftFromDetail()
  _selected = key
  _pickerMode = picker
  renderRail()
  showMediaDetailPanel()
}

function openAddPicker() {
  _pickerMode = true
  focusMediaSection()
  _modelsPage?.querySelectorAll('#media-vendor-rail .models-vendor-item.active').forEach((el) => {
    el.classList.remove('active')
  })
  renderDetail()
}

async function onSave({ quiet = false } = {}) {
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
    _pickerMode = false
    renderRail()
    renderDetail()
    if (!quiet) {
      toast('语音配置已保存', 'success')
    }
    window.dispatchEvent(new CustomEvent('evopanel:media-updated'))
    return true
  } catch (e) {
    toast(String(e?.message || e), 'error')
    return false
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
    if (vendorBtn && vendorBtn.closest('#media-vendor-rail')) {
      e.preventDefault()
      selectMediaVendor(vendorBtn.getAttribute('data-media-vendor'))
    }
  }
  _modelsPage.addEventListener('click', _clickHandler)
}

/**
 * 嵌入模型设置页：左侧「语音」分组 + 右侧详情
 * @param {HTMLElement} page models 页根节点
 * @param {{ activeSection?: string }} modelsState
 */
export async function attachMediaToModelsPage(page, modelsState, callbacks = {}) {
  if (_modelsPage && _modelsPage !== page) cleanup()
  _modelsPage = page
  _modelsState = modelsState
  _loaded = { ...DEFAULT_MEDIA_CREDENTIALS, enabledVendors: { ...DEFAULT_ENABLED_VENDORS } }
  _draft = { ...DEFAULT_MEDIA_CREDENTIALS, enabledVendors: { ...DEFAULT_ENABLED_VENDORS } }
  _selected = 'volcengine-tts'
  _pickerMode = false

  const host = page.querySelector('#media-vendor-rail-host')
  if (host) {
    host.innerHTML = `
      <section class="models-sidebar-section" id="media-sidebar-section" data-sidebar-section="media">
        <button type="button" class="models-sidebar-section-head" data-sidebar-section-toggle="media" aria-expanded="true">
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
  setSectionExpanded(page, 'media', true)

  bindSidebarSectionToggles(page, modelsState, callbacks)
  bindClicks()
  renderRail()

  try {
    _loaded = await fetchMediaCredentials()
    _draft = { ...DEFAULT_MEDIA_CREDENTIALS, ..._loaded }
    delete _draft._configured
    _selected = 'volcengine-tts'
    renderRail()
  } catch (e) {
    toast(`加载语音配置失败：${e?.message || e}`, 'error')
  }
}

/** 用户点击对话模型厂商时清除语音选中态 */
export function clearMediaSelection(page) {
  const root = modelsLayoutRoot(page)
  root?.querySelectorAll('#media-vendor-rail .models-vendor-item.active').forEach((el) => {
    el.classList.remove('active')
  })
  _pickerMode = false
}

export { applySidebarSection, modelsLayoutRoot, setSectionExpanded }

/** 渲染语音 Tab 详情区（供 models.js tab 切换时调用） */
export function renderMediaDetail() {
  _selected = 'volcengine-tts'
  _pickerMode = false
  renderDetail()
}

export function cleanup() {
  unbindSectionHeads()
  if (_modelsPage && _clickHandler) {
    _modelsPage.removeEventListener('click', _clickHandler)
  }
  _clickHandler = null
  _modelsPage = null
  _modelsState = null
  _draft = { ...DEFAULT_MEDIA_CREDENTIALS, enabledVendors: { ...DEFAULT_ENABLED_VENDORS } }
  _loaded = { ...DEFAULT_MEDIA_CREDENTIALS, enabledVendors: { ...DEFAULT_ENABLED_VENDORS } }
  _selected = 'volcengine-tts'
  _pickerMode = false
}

/** @deprecated 独立 Tab 已移除，保留空实现避免旧引用报错 */
export async function mountMediaForSettingsModal(container) {
  container.innerHTML =
    '<p class="form-hint" style="padding:16px">语音配置已移至「设置 → 模型 → 语音」Tab。</p>'
}

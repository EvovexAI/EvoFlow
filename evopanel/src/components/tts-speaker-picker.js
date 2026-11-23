/**
 * TTS 音色选择器 — 可搜索弹窗 + 在线试听（火山 OpenSpeech / 各厂商共用壳）。
 */

import { toast } from './toast.js'
import { fetchSpeechConfigured, previewSpeechTts, stopAllAssistantSpeech } from '../lib/speech-client.js'
import {
  VOLCENGINE_TTS_PREVIEW_TEXT_EN,
  VOLCENGINE_TTS_PREVIEW_TEXT_ZH,
  VOLCENGINE_TTS_SPEAKER_TRIAL_URL,
} from '../lib/volcengine-tts-speakers.js'

const PREVIEW_PLAY_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`
const PREVIEW_STOP_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg>`

/** @type {HTMLAudioElement | null} */
let _previewAudio = null
/** @type {HTMLElement | null} */
let _previewBtn = null
/** @type {AbortController | null} */
let _previewAbort = null
/** @type {number} */
let _previewGen = 0

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

function findPreset(presets, value) {
  return presets.find((p) => p.value === value) || null
}

function displayForValue(presets, raw) {
  const preset = findPreset(presets, raw)
  if (preset) return { label: preset.label, id: preset.value, isCustom: false }
  return { label: raw ? '自定义音色' : '未选择', id: raw, isCustom: true }
}

function normalizeQuery(q) {
  return String(q ?? '')
    .trim()
    .toLowerCase()
}

function matchesPreset(preset, q) {
  if (!q) return true
  const hay = `${preset.label} ${preset.value}`.toLowerCase()
  return hay.includes(q)
}

function previewTextForSpeaker(voiceType, presets) {
  const v = String(voiceType || '').toLowerCase()
  const preset = presets?.find((p) => p.value === voiceType)
  if (preset?.label) {
    const name = String(preset.label)
      .replace(/（.*?）/g, '')
      .replace(/\s*2\.0/g, '')
      .trim()
    if (name) {
      if (v.startsWith('en_') || v.includes('_en_')) {
        return `Hello, this is ${name}. Welcome to the voice preview.`
      }
      return `你好，我是${name}，欢迎试听火山语音合成效果。`
    }
  }
  if (v.startsWith('en_') || v.includes('_en_')) return VOLCENGINE_TTS_PREVIEW_TEXT_EN
  return VOLCENGINE_TTS_PREVIEW_TEXT_ZH
}

function stopPreview() {
  _previewGen += 1
  if (_previewAbort) {
    _previewAbort.abort()
    _previewAbort = null
  }
  if (_previewAudio) {
    _previewAudio.pause()
    _previewAudio.currentTime = 0
    _previewAudio = null
  }
  if (_previewBtn) {
    _previewBtn.classList.remove('is-playing')
    _previewBtn.innerHTML = PREVIEW_PLAY_SVG
    _previewBtn = null
  }
}

function setPreviewBtnPlaying(btn, playing) {
  if (!btn) return
  btn.classList.toggle('is-playing', playing)
  btn.innerHTML = playing ? PREVIEW_STOP_SVG : PREVIEW_PLAY_SVG
}

/**
 * @param {string} voiceType
 * @param {HTMLElement | null} btn
 * @param {{ value: string, label: string }[]} [presets]
 * @param {string} [providerHint] 弹窗内试听必须显式传入：列表不在 data-media-tts-speaker-group 内，
 *   否则会默认 volcengine，阿里云音色 ▶ 也会打成 OpenSpeech → 401。
 */
async function playSpeakerPreview(voiceType, btn, presets, providerHint) {
  const group = btn?.closest('[data-media-tts-speaker-group]')
  const overlay = btn?.closest('[data-tts-preview-provider]')
  const hiddenVoice = group?.querySelector('[data-media-tts-speaker-value]')?.value?.trim() || ''
  const voice = String(voiceType || hiddenVoice || '').trim()
  if (!voice) return
  if (_previewBtn === btn && _previewAudio && !_previewAudio.paused) {
    stopPreview()
    return
  }
  stopPreview()
  stopAllAssistantSpeech()
  _previewBtn = btn || null
  if (btn) setPreviewBtnPlaying(btn, true)
  const gen = _previewGen
  const ac = new AbortController()
  _previewAbort = ac
  const provider = String(
    providerHint ||
      group?.getAttribute('data-tts-provider') ||
      overlay?.getAttribute('data-tts-preview-provider') ||
      'volcengine',
  )
    .trim()
    .toLowerCase() || 'volcengine'
  try {
    if (provider === 'volcengine' || provider === 'doubao') {
      const configured = await fetchSpeechConfigured()
      if (gen !== _previewGen) return
      if (!configured) {
        stopPreview()
        toast('请先在设置中配置火山语音 API Key，或前往火山语音控制台试听', 'info')
        window.open(VOLCENGINE_TTS_SPEAKER_TRIAL_URL, '_blank', 'noopener,noreferrer')
        return
      }
    }
    const { audio, speakerUsed, digest } = await previewSpeechTts(
      previewTextForSpeaker(voice, presets),
      voice,
      { signal: ac.signal, provider },
    )
    if (gen !== _previewGen) {
      audio.pause()
      return
    }
    _previewAudio = audio
    if (btn && speakerUsed && speakerUsed !== voice) {
      btn.setAttribute('data-tts-speaker-preview', speakerUsed)
    }
    if (import.meta.env?.DEV && digest) {
      console.debug('[tts-preview]', speakerUsed, digest)
    }
    audio.onended = () => {
      if (_previewAudio === audio) stopPreview()
    }
    audio.onerror = () => {
      if (_previewAudio === audio) stopPreview()
    }
  } catch (e) {
    if (e?.name === 'AbortError') return
    stopPreview()
    const msg = String(e?.message || e)
    if (
      (provider === 'volcengine' || provider === 'doubao') &&
      /45000010|Invalid X-Api-Key|InvalidApiKey/i.test(msg)
    ) {
      toast(
        '火山试听失败：OpenSpeech 拒绝当前 API Key。请换火山语音控制台 / Agent Plan 语音 Key；阿里云音色请在「阿里云语音」页试听。',
        'error',
      )
    } else if (provider === 'dashscope' && /volcengine|openspeech|45000010/i.test(msg)) {
      toast('阿里云试听误走了火山口，请刷新页面后再试（已修复 provider 传递）。', 'error')
    } else {
      toast(msg, 'error')
    }
  } finally {
    if (_previewAbort === ac) _previewAbort = null
  }
}

/**
 * @param {string} fieldId
 * @param {string} label
 * @param {{ value: string, label: string }[]} presets
 * @param {Record<string, unknown>} creds
 * @param {string | { hint?: string, customPlaceholder?: string, showVoiceId?: boolean, customModeLabel?: string }} [hintOrOpts]
 * @param {string} [customPlaceholderLegacy]
 */
export function buildTtsSpeakerFieldHtml(fieldId, label, presets, creds, hintOrOpts, customPlaceholderLegacy) {
  let hint = ''
  let customPh = '例如 zh_female_vv_uranus_bigtts'
  let showVoiceId = true
  let customModeLabel = '自定义音色'

  if (typeof hintOrOpts === 'object' && hintOrOpts) {
    hint = hintOrOpts.hint || ''
    customPh = hintOrOpts.customPlaceholder || customPh
    showVoiceId = hintOrOpts.showVoiceId !== false
    customModeLabel = hintOrOpts.customModeLabel || customModeLabel
  } else {
    if (hintOrOpts) hint = hintOrOpts
    if (customPlaceholderLegacy) customPh = customPlaceholderLegacy
  }

  const raw = String(creds[fieldId] ?? presets[0]?.value ?? '').trim()
  const disp = displayForValue(presets, raw)
  const customHidden = disp.isCustom ? '' : ' hidden'
  const canPreview = !!raw && !disp.isCustom
  const triggerClass = showVoiceId ? '' : ' media-tts-speaker-trigger--label-only'
  const idHtml = showVoiceId
    ? `<code class="media-tts-speaker-trigger-id">${escHtml(disp.id)}</code>`
    : ''

  return `
    <div class="form-group media-tts-speaker-field" data-media-tts-speaker-group="${escAttr(fieldId)}">
      <label class="form-label">${escHtml(label)}</label>
      ${hint ? `<p class="form-hint">${escHtml(hint)}</p>` : ''}
      <div class="media-tts-speaker-trigger-row"${disp.isCustom ? ' hidden' : ''}>
        <button type="button" class="media-tts-speaker-trigger form-input${triggerClass}" data-tts-speaker-open="${escAttr(fieldId)}">
          <span class="media-tts-speaker-trigger-main">
            <span class="media-tts-speaker-trigger-label">${escHtml(disp.label)}</span>
            ${idHtml}
          </span>
          <svg class="media-tts-speaker-trigger-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <button type="button" class="media-tts-speaker-preview-btn" data-tts-speaker-preview="${escAttr(raw)}" title="试听"${canPreview ? '' : ' hidden'} aria-label="试听当前音色">${PREVIEW_PLAY_SVG}</button>
      </div>
      <label class="media-tts-speaker-custom-toggle">
        <input type="checkbox" data-tts-speaker-custom-mode="${escAttr(fieldId)}"${disp.isCustom ? ' checked' : ''}>
        <span>${escHtml(customModeLabel)}</span>
      </label>
      <input class="form-input media-tts-speaker-custom" type="text"
        data-media-tts-speaker-custom="${escAttr(fieldId)}"
        value="${disp.isCustom ? escAttr(raw) : ''}"
        placeholder="${escAttr(customPh)}"${customHidden ? ' hidden' : ''}>
      <input type="hidden" data-media-tts-speaker-value="${escAttr(fieldId)}" value="${escAttr(raw)}">
    </div>`
}

function renderPickerList(presets, query, selectedValue) {
  const q = normalizeQuery(query)
  const items = presets.filter((p) => matchesPreset(p, q))
  if (!items.length) {
    return `<p class="media-tts-speaker-empty">无匹配音色，可勾选「自定义音色」手动输入</p>`
  }
  return items
    .map((p) => {
      const active = p.value === selectedValue ? ' active' : ''
      return `<div class="media-tts-speaker-item${active}" data-tts-speaker-item="${escAttr(p.value)}">
        <button type="button" class="media-tts-speaker-item-main" data-tts-speaker-pick="${escAttr(p.value)}">
          <span class="media-tts-speaker-item-label">${escHtml(p.label)}</span>
          <code class="media-tts-speaker-item-id">${escHtml(p.value)}</code>
        </button>
        <button type="button" class="media-tts-speaker-preview-btn" data-tts-speaker-preview="${escAttr(p.value)}" title="试听" aria-label="试听 ${escAttr(p.label)}">${PREVIEW_PLAY_SVG}</button>
      </div>`
    })
    .join('')
}

function bindPreviewButtons(root, presets, provider) {
  root.querySelectorAll('[data-tts-speaker-preview]').forEach((btn) => {
    if (btn.dataset.previewBound) return
    btn.dataset.previewBound = '1'
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const voice = btn.getAttribute('data-tts-speaker-preview') || ''
      playSpeakerPreview(voice, btn, presets, provider)
    })
  })
}

function subtitleForProvider(provider) {
  const p = String(provider || 'volcengine').trim().toLowerCase()
  if (p === 'dashscope') return '阿里云语音 · Token Plan / CosyVoice'
  if (p === 'openai') return 'OpenAI TTS'
  if (p === 'elevenlabs') return 'ElevenLabs'
  if (p === 'minimax') return 'MiniMax TTS'
  if (p === 'doubao') return '火山方舟 Key · OpenSpeech（非阿里云）'
  return '火山 OpenSpeech · seed-tts-2.0'
}

/**
 * 全屏音色弹窗（可搜索 + 行内试听）。供设置页与 React 部门群声线共用。
 * @param {{ presets: { value: string, label: string }[], currentValue?: string, onSelect: (value: string) => void, title?: string, provider?: string }} opts
 */
export function openTtsSpeakerPicker({ presets, currentValue, onSelect, title, provider }) {
  const prov = String(provider || 'volcengine').trim().toLowerCase() || 'volcengine'
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay media-tts-speaker-overlay'
  overlay.setAttribute('data-tts-preview-provider', prov)
  const footLink =
    prov === 'dashscope'
      ? `<a href="https://help.aliyun.com/zh/model-studio/token-plan-speech-synthesis" target="_blank" rel="noopener noreferrer">阿里云音色说明</a>`
      : `<a href="${escAttr(VOLCENGINE_TTS_SPEAKER_TRIAL_URL)}" target="_blank" rel="noopener noreferrer">火山语音控制台试听</a>`
  overlay.innerHTML = `
    <div class="modal models-edit-modal media-tts-speaker-modal" role="dialog" aria-modal="true" aria-labelledby="tts-speaker-modal-title">
      <div class="models-edit-modal-header">
        <div class="models-edit-modal-title-row">
          <h2 class="models-edit-modal-title" id="tts-speaker-modal-title">${escHtml(title || '选择 TTS 音色')}</h2>
          <span class="models-edit-modal-subtitle">${escHtml(subtitleForProvider(prov))}</span>
        </div>
        <button type="button" class="models-edit-modal-close" data-tts-speaker-close title="关闭">&times;</button>
      </div>
      <div class="media-tts-speaker-search-row">
        <input class="form-input media-tts-speaker-search" type="search" placeholder="搜索音色名称或 voice_type…" autocomplete="off" spellcheck="false">
      </div>
      <div class="media-tts-speaker-list" data-tts-speaker-list></div>
      <div class="media-tts-speaker-modal-foot">
        ${footLink}
        <span>· 已配置对应厂商 Key 时点击 ▶ 在线试听</span>
      </div>
    </div>`

  document.body.appendChild(overlay)

  const searchEl = overlay.querySelector('.media-tts-speaker-search')
  const listEl = overlay.querySelector('[data-tts-speaker-list]')
  let selectedValue = currentValue

  const paint = () => {
    listEl.innerHTML = renderPickerList(presets, searchEl.value, selectedValue)
    bindPreviewButtons(listEl, presets, prov)
    listEl.querySelectorAll('[data-tts-speaker-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedValue = btn.getAttribute('data-tts-speaker-pick') || ''
        stopPreview()
        onSelect(selectedValue)
        close()
      })
    })
  }

  const close = () => {
    stopPreview()
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  overlay.querySelector('[data-tts-speaker-close]')?.addEventListener('click', close)
  searchEl.addEventListener('input', paint)
  document.addEventListener('keydown', onKey)

  paint()
  searchEl.focus()
}

function syncTrigger(group, presets, value) {
  const triggerRow = group.querySelector('.media-tts-speaker-trigger-row')
  const trigger = group.querySelector('[data-tts-speaker-open]')
  const previewBtn = group.querySelector('.media-tts-speaker-preview-btn')
  const hidden = group.querySelector('[data-media-tts-speaker-value]')
  if (hidden) hidden.value = value
  const disp = displayForValue(presets, value)
  const labelEl = group.querySelector('.media-tts-speaker-trigger-label')
  const idEl = group.querySelector('.media-tts-speaker-trigger-id')
  if (labelEl) labelEl.textContent = disp.label
  if (idEl) idEl.textContent = disp.id
  if (triggerRow) triggerRow.hidden = disp.isCustom
  if (previewBtn) {
    previewBtn.hidden = disp.isCustom || !value
    previewBtn.setAttribute('data-tts-speaker-preview', value)
    setPreviewBtnPlaying(previewBtn, false)
  }
}

function bindOneTtsSpeakerField(group, presets) {
  const fieldId = group.getAttribute('data-media-tts-speaker-group')
  if (!fieldId) return

  const trigger = group.querySelector('[data-tts-speaker-open]')
  const customToggle = group.querySelector(`[data-tts-speaker-custom-mode="${CSS.escape(fieldId)}"]`)
  const customInput = group.querySelector(`[data-media-tts-speaker-custom="${CSS.escape(fieldId)}"]`)
  const hidden = group.querySelector(`[data-media-tts-speaker-value="${CSS.escape(fieldId)}"]`)

  const provider =
    group.getAttribute('data-tts-provider')?.trim().toLowerCase() || 'volcengine'
  bindPreviewButtons(group, presets, provider)

  // 「自定义音色」勾选框是 UI 模式切换(预设选择器 ↔ 手动输入),不是数据字段:
  // 进入自定义模式不得立即用空输入覆盖已配置音色(曾配合面板自动保存把预设音色
  // 清空落盘);取消勾选时恢复进入前的值。hidden 只在用户真正输入时更新。
  let valueBeforeCustom = null

  const syncCustomMode = () => {
    const custom = !!customToggle?.checked
    const triggerRow = group.querySelector('.media-tts-speaker-trigger-row')
    if (customInput) {
      if (custom) customInput.removeAttribute('hidden')
      else customInput.setAttribute('hidden', '')
    }
    if (triggerRow) triggerRow.hidden = custom
    if (custom) {
      if (valueBeforeCustom === null) valueBeforeCustom = hidden?.value || ''
    } else if (valueBeforeCustom !== null && hidden) {
      hidden.value = valueBeforeCustom
      valueBeforeCustom = null
    }
  }

  trigger?.addEventListener('click', () => {
    const current = hidden?.value || presets[0]?.value || ''
    openTtsSpeakerPicker({
      presets,
      currentValue: current,
      provider,
      onSelect: (value) => {
        syncTrigger(group, presets, value)
        if (customToggle) customToggle.checked = false
        if (customInput) {
          customInput.value = ''
          customInput.setAttribute('hidden', '')
        }
      },
    })
  })

  customToggle?.addEventListener('change', syncCustomMode)
  customInput?.addEventListener('input', () => {
    if (customToggle?.checked && hidden) hidden.value = customInput.value.trim()
  })

  syncCustomMode()
}

/** @param {HTMLElement} root */
export function bindTtsSpeakerFields(root, presets) {
  root.querySelectorAll('[data-media-tts-speaker-group]').forEach((group) => {
    bindOneTtsSpeakerField(group, presets)
  })
}

/**
 * 在线试听某个 voice_type（与弹窗行内 ▶ 同一套）。
 * @param {string} voiceType
 * @param {{ value: string, label: string }[]} [presets]
 * @param {HTMLElement | null} [btn]
 */
export function previewTtsSpeaker(voiceType, presets = [], btn = null, provider) {
  return playSpeakerPreview(voiceType, btn, presets, provider)
}

export function stopTtsSpeakerPreview() {
  stopPreview()
}

/** @param {HTMLElement} panel */
export function readTtsSpeakerDraft(panel) {
  /** @type {Record<string, string>} */
  const out = {}
  panel.querySelectorAll('[data-media-tts-speaker-group]').forEach((group) => {
    const fieldId = group.getAttribute('data-media-tts-speaker-group')
    if (!fieldId) return
    const customToggle = group.querySelector(`[data-tts-speaker-custom-mode="${CSS.escape(fieldId)}"]`)
    const customInput = group.querySelector(`[data-media-tts-speaker-custom="${CSS.escape(fieldId)}"]`)
    const hidden = group.querySelector(`[data-media-tts-speaker-value="${CSS.escape(fieldId)}"]`)
    if (customToggle?.checked) {
      // 自定义输入为空 = 用户还没真正输入;回落到当前值(可能是预设),
      // 不能把空串交给自动保存,否则已配置音色被清空。
      out[fieldId] = customInput?.value.trim() || hidden?.value.trim() || ''
    } else {
      out[fieldId] = hidden?.value.trim() || ''
    }
  })
  return out
}

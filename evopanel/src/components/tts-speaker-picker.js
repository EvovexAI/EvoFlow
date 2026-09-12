/**
 * 豆包 TTS 音色选择器 — 可搜索弹窗 + 在线试听。
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
      return `你好，我是${name}，欢迎试听豆包语音合成效果。`
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

async function playSpeakerPreview(voiceType, btn, presets) {
  const group = btn?.closest('[data-media-tts-speaker-group]')
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
  try {
    const configured = await fetchSpeechConfigured()
    if (gen !== _previewGen) return
    if (!configured) {
      stopPreview()
      toast('请先在设置中配置火山 TTS API Key，或前往豆包语音控制台试听', 'info')
      window.open(VOLCENGINE_TTS_SPEAKER_TRIAL_URL, '_blank', 'noopener,noreferrer')
      return
    }
    const { audio, speakerUsed, digest } = await previewSpeechTts(
      previewTextForSpeaker(voice, presets),
      voice,
      { signal: ac.signal },
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
    toast(String(e?.message || e), 'error')
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

function bindPreviewButtons(root, presets) {
  root.querySelectorAll('[data-tts-speaker-preview]').forEach((btn) => {
    if (btn.dataset.previewBound) return
    btn.dataset.previewBound = '1'
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const voice = btn.getAttribute('data-tts-speaker-preview') || ''
      playSpeakerPreview(voice, btn, presets)
    })
  })
}

function openTtsSpeakerPicker({ presets, currentValue, onSelect }) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay media-tts-speaker-overlay'
  overlay.innerHTML = `
    <div class="modal models-edit-modal media-tts-speaker-modal" role="dialog" aria-modal="true" aria-labelledby="tts-speaker-modal-title">
      <div class="models-edit-modal-header">
        <div class="models-edit-modal-title-row">
          <h2 class="models-edit-modal-title" id="tts-speaker-modal-title">选择 TTS 音色</h2>
          <span class="models-edit-modal-subtitle">豆包语音合成 2.0 · seed-tts-2.0</span>
        </div>
        <button type="button" class="models-edit-modal-close" data-tts-speaker-close title="关闭">&times;</button>
      </div>
      <div class="media-tts-speaker-search-row">
        <input class="form-input media-tts-speaker-search" type="search" placeholder="搜索音色名称或 voice_type…" autocomplete="off" spellcheck="false">
      </div>
      <div class="media-tts-speaker-list" data-tts-speaker-list></div>
      <div class="media-tts-speaker-modal-foot">
        <a href="${escAttr(VOLCENGINE_TTS_SPEAKER_TRIAL_URL)}" target="_blank" rel="noopener noreferrer">豆包语音控制台试听</a>
        <span>· 已配置 API Key 时点击 ▶ 在线试听</span>
      </div>
    </div>`

  document.body.appendChild(overlay)

  const searchEl = overlay.querySelector('.media-tts-speaker-search')
  const listEl = overlay.querySelector('[data-tts-speaker-list]')
  let selectedValue = currentValue

  const paint = () => {
    listEl.innerHTML = renderPickerList(presets, searchEl.value, selectedValue)
    bindPreviewButtons(listEl, presets)
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

  bindPreviewButtons(group, presets)

  const syncCustomMode = () => {
    const custom = !!customToggle?.checked
    const triggerRow = group.querySelector('.media-tts-speaker-trigger-row')
    if (customInput) {
      if (custom) customInput.removeAttribute('hidden')
      else customInput.setAttribute('hidden', '')
    }
    if (triggerRow) triggerRow.hidden = custom
    if (custom && customInput) {
      hidden.value = customInput.value.trim()
    }
  }

  trigger?.addEventListener('click', () => {
    const current = hidden?.value || presets[0]?.value || ''
    openTtsSpeakerPicker({
      presets,
      currentValue: current,
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
      out[fieldId] = customInput?.value.trim() || ''
    } else {
      out[fieldId] = hidden?.value.trim() || ''
    }
  })
  return out
}

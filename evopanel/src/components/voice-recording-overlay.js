/**
 * 语音录音状态浮层 — 科技感 HUD（与桌面系统浮层同款视觉）
 */

import {
  VoiceVisualizer,
  createVoiceHudElement,
  VOICE_VISUALIZER_STYLES,
  createVoiceVisualizer,
} from '../lib/voice-visualizer.js'

let _overlay = null
/** @type {VoiceVisualizer | null} */
let _viz = null
let _isVisible = false
let _resultTimer = null

function ensureOverlay() {
  if (!_overlay) {
    const styleEl = document.createElement('style')
    styleEl.textContent = VOICE_VISUALIZER_STYLES
    document.head.appendChild(styleEl)

    _overlay = document.createElement('div')
    _overlay.className = 'voice-recording-overlay'
    const hud = createVoiceHudElement({ floating: true })
    _overlay.appendChild(hud)
    document.body.appendChild(_overlay)

    _viz = createVoiceVisualizer(hud)
    _viz.start()
  }
  return _overlay
}

/** 显示录音状态浮层 */
export function showVoiceRecordingOverlay() {
  if (_isVisible) return
  _isVisible = true
  ensureOverlay()
  _viz?.reset()
  _viz?.setState('listening')
  void _overlay.offsetWidth
  _overlay.classList.add('visible')
}

/** 实时更新识别文字 */
export function updateVoiceRecordingText(text) {
  if (!_viz) return
  const clean = String(text || '').trim()
  _viz.setText(clean || '正在聆听…')
}

/** 实时更新频谱（0–1 数组或单值 RMS） */
export function updateVoiceRecordingLevels(levels) {
  if (!_viz) return
  _viz.setLevels(levels)
}

/** 隐藏录音状态浮层 */
export function hideVoiceRecordingOverlay() {
  if (!_isVisible || !_overlay) return
  _isVisible = false
  _overlay.classList.remove('visible')
}

/**
 * 显示语音识别结果
 * @param {string} text
 * @param {number} [duration]
 */
export function showVoiceRecognitionResult(text, duration = 2000) {
  const overlay = ensureOverlay()
  if (_resultTimer) {
    clearTimeout(_resultTimer)
    _resultTimer = null
  }

  const clean = String(text || '').trim()
  _viz?.setText(clean)
  _viz?.setState('complete')

  void overlay.offsetWidth
  overlay.classList.add('visible')
  _isVisible = true

  _resultTimer = setTimeout(() => {
    overlay.classList.remove('visible')
    _isVisible = false
    _viz?.reset()
  }, duration)
}

/** 识别处理中 */
export function showVoiceProcessingState() {
  ensureOverlay()
  _viz?.setState('processing')
}

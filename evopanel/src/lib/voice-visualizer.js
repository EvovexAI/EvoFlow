import { VoiceOrbCanvas } from './voice-orb-canvas.js'

/**
 * Siri-style voice overlay — SmoothUI Siri Orb (pure CSS) + compact status card.
 * Uses RGB + transform animation for Tauri WebView2 / transparent window compatibility.
 * @see https://smoothui.dev/docs/components/siri-orb
 */

const ORB_SIZE_PX = 96
const BAR_COUNT = 32

/** Default Siri-like pastel palette (hex — no oklch). */
export const SIRI_ORB_COLORS = {
  bg: '#eef0fb',
  c1: '#f472b6',
  c2: '#60a5fa',
  c3: '#a78bfa',
}

/** @param {number} sizeValue */
function siriOrbMetrics(sizeValue) {
  const small = sizeValue < 50
  const blurAmount = small
    ? Math.max(sizeValue * 0.008, 1)
    : Math.max(sizeValue * 0.015, 4)
  const contrastAmount = small
    ? Math.max(sizeValue * 0.004, 1.2)
    : Math.max(sizeValue * 0.008, 1.5)
  const dotSize = small
    ? Math.max(sizeValue * 0.004, 0.05)
    : Math.max(sizeValue * 0.008, 0.1)
  const shadowSpread = small
    ? Math.max(sizeValue * 0.004, 0.5)
    : Math.max(sizeValue * 0.008, 2)
  return { blurAmount, contrastAmount, dotSize, shadowSpread }
}

/** @param {HTMLElement} el @param {Record<string, string>} vars */
function applyCssVars(el, vars) {
  for (const [key, value] of Object.entries(vars)) {
    el.style.setProperty(key, value)
  }
}

/** @param {number} [sizePx] @param {Record<string, string>} [colors] */
export function createSiriOrbElement(sizePx = ORB_SIZE_PX, colors = {}) {
  const m = siriOrbMetrics(sizePx)
  const pal = { ...SIRI_ORB_COLORS, ...colors }
  const orb = document.createElement('div')
  orb.className = 'siri-orb'
  orb.setAttribute('aria-hidden', 'true')
  orb.style.width = `${sizePx}px`
  orb.style.height = `${sizePx}px`
  applyCssVars(orb, {
    '--bg': pal.bg,
    '--c1': pal.c1,
    '--c2': pal.c2,
    '--c3': pal.c3,
    '--animation-duration': '18s',
    '--blur-amount': `${m.blurAmount}px`,
    '--contrast-amount': String(m.contrastAmount),
    '--dot-size': `${m.dotSize}px`,
    '--shadow-spread': `${m.shadowSpread}px`,
    '--orb-scale': '1',
  })
  return orb
}

export const VOICE_VISUALIZER_STYLES = `
.siri-orb {
  display: grid;
  grid-template-areas: "stack";
  overflow: hidden;
  border-radius: 50%;
  position: relative;
  flex-shrink: 0;
  isolation: isolate;
  background: var(--bg, #eef0fb);
  transform: scale(var(--orb-scale, 1));
  transition: transform 0.14s ease-out;
  will-change: transform;
  box-shadow: 0 0 20px rgba(96, 165, 250, 0.28);
}

.voice-orb-panel--floating .siri-orb {
  box-shadow: none;
}

.voice-orb-panel--floating .siri-orb::before {
  box-shadow: none;
}

.siri-orb::before,
.siri-orb::after {
  content: "";
  display: block;
  grid-area: stack;
  width: 100%;
  height: 100%;
  border-radius: 50%;
}

.siri-orb::before {
  background:
    conic-gradient(from 140deg at 25% 70%, var(--c3), transparent 20% 80%, var(--c3)),
    conic-gradient(from 200deg at 45% 75%, var(--c2), transparent 30% 60%, var(--c2)),
    conic-gradient(from 60deg at 80% 20%, var(--c1), transparent 40% 60%, var(--c1)),
    conic-gradient(from 310deg at 15% 5%, var(--c2), transparent 10% 90%, var(--c2)),
    conic-gradient(from 220deg at 20% 80%, var(--c1), transparent 10% 90%, var(--c1)),
    conic-gradient(from 30deg at 85% 10%, var(--c3), transparent 20% 80%, var(--c3));
  box-shadow: inset var(--bg) 0 0 var(--shadow-spread) calc(var(--shadow-spread) * 0.2);
  filter: blur(var(--blur-amount)) contrast(var(--contrast-amount));
  animation: siri-orb-spin var(--animation-duration, 18s) linear infinite;
  transform-origin: center center;
}

.siri-orb::after {
  background-image: radial-gradient(
    circle at center,
    rgba(255, 255, 255, 0.45) var(--dot-size),
    transparent var(--dot-size)
  );
  background-size: calc(var(--dot-size) * 2) calc(var(--dot-size) * 2);
  opacity: 0.75;
  mix-blend-mode: soft-light;
}

@keyframes siri-orb-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.voice-orb-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 18px 22px 16px;
  min-width: 220px;
  max-width: 300px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(200, 200, 210, 0.85);
  box-shadow:
    0 8px 32px rgba(15, 23, 42, 0.18),
    0 0 0 1px rgba(255, 255, 255, 0.6) inset;
  color: #1d1d1f;
}

.voice-orb-panel--floating {
  background: transparent;
  border: none;
  outline: none;
  box-shadow: none;
  border-radius: 0;
  min-width: 0;
  padding: 8px 12px;
}

.voice-orb-panel--standalone {
  width: auto;
  max-width: none;
  min-height: 0;
  height: auto;
  justify-content: center;
  padding: 0;
}

.voice-orb-panel--floating .voice-orb-panel__status {
  color: rgba(255, 255, 255, 0.96);
  text-shadow:
    0 0 10px rgba(0, 0, 0, 0.75),
    0 1px 3px rgba(0, 0, 0, 0.85);
}

.voice-orb-panel--floating.voice-orb-panel--processing .voice-orb-panel__status {
  color: #fde68a;
}

.voice-orb-panel--floating.voice-orb-panel--complete .voice-orb-panel__status {
  color: #86efac;
}

.voice-orb-panel__orb-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px 0;
  min-height: 100px;
}

.voice-orb-panel--floating .voice-orb-panel__status {
  font-size: 15px;
}

.voice-orb-panel__status {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: #3a3a3c;
}

.voice-orb-panel__transcript {
  width: 100%;
  text-align: center;
  font-size: 13px;
  line-height: 1.5;
  color: #636366;
  min-height: 20px;
  max-height: 42px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}

.voice-orb-panel--active-text .voice-orb-panel__transcript {
  color: #1d1d1f;
  font-weight: 500;
}

.voice-orb-panel--processing .siri-orb {
  --c1: #fbbf24;
  --c2: #fb923c;
  --c3: #f97316;
}

.voice-orb-panel--processing:not(.voice-orb-panel--floating) .siri-orb {
  box-shadow: 0 0 24px rgba(251, 191, 36, 0.4);
}

.voice-orb-panel--processing .voice-orb-panel__status {
  color: #b45309;
}

.voice-orb-panel--complete .siri-orb {
  --c1: #4ade80;
  --c2: #34d399;
  --c3: #2dd4bf;
}

.voice-orb-panel--complete:not(.voice-orb-panel--floating) .siri-orb {
  box-shadow: 0 0 24px rgba(74, 222, 128, 0.35);
}

.voice-orb-panel--complete .voice-orb-panel__status {
  color: #15803d;
}

.voice-recording-overlay {
  position: fixed;
  top: 24px;
  right: 24px;
  bottom: auto;
  z-index: 999999;
  pointer-events: none;
  opacity: 0;
  scale: 0.92;
  transition: opacity 0.26s cubic-bezier(0.22, 1, 0.36, 1), scale 0.26s cubic-bezier(0.22, 1, 0.36, 1);
}

.voice-recording-overlay.visible {
  opacity: 1;
  scale: 1;
}

@media (prefers-color-scheme: dark) {
  .voice-orb-panel:not(.voice-orb-panel--floating) {
    background: rgba(44, 44, 46, 0.97);
    border-color: rgba(255, 255, 255, 0.12);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    color: #f5f5f7;
  }

  .voice-orb-panel:not(.voice-orb-panel--floating) .voice-orb-panel__status { color: #ebebf0; }
  .voice-orb-panel:not(.voice-orb-panel--floating) .voice-orb-panel__transcript { color: #aeaeb2; }
  .voice-orb-panel:not(.voice-orb-panel--floating).voice-orb-panel--active-text .voice-orb-panel__transcript { color: #f5f5f7; }
  .voice-orb-panel:not(.voice-orb-panel--floating).voice-orb-panel--processing .voice-orb-panel__status { color: #fbbf24; }
  .voice-orb-panel:not(.voice-orb-panel--floating).voice-orb-panel--complete .voice-orb-panel__status { color: #4ade80; }
}
`

/** @param {{ standalone?: boolean, floating?: boolean }} [opts] */
export function createVoiceHudElement(opts = {}) {
  const root = document.createElement('div')
  const floating = !!(opts.standalone || opts.floating)
  root.className = [
    'voice-orb-panel',
    opts.standalone ? 'voice-orb-panel--standalone' : '',
    floating ? 'voice-orb-panel--floating' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const orb = createSiriOrbElement(ORB_SIZE_PX)
  root.innerHTML = `
    <div class="voice-orb-panel__orb-wrap"></div>
    <div class="voice-orb-panel__status">聆听中</div>
    <div class="voice-orb-panel__transcript">正在聆听…</div>
  `
  root.querySelector('.voice-orb-panel__orb-wrap')?.appendChild(orb)
  return root
}

export class VoiceVisualizer {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root
    this.orbEl = /** @type {HTMLElement | null} */ (root.querySelector('.siri-orb'))
    this.statusEl = root.querySelector('.voice-orb-panel__status')
    this.transcriptEl = root.querySelector('.voice-orb-panel__transcript')
    /** @type {number[]} */
    this.levels = new Array(BAR_COUNT).fill(0)
    this.state = 'listening'
    this.running = false
    this._raf = 0
    this._energy = 0
    this._targetEnergy = 0
    /** @type {string | null} */
    this._pendingText = null
    /** @type {number[] | number | null} */
    this._pendingLevels = null
    this._lastAppliedText = null
  }

  _flushPendingInput() {
    if (this._pendingLevels != null) {
      this._applyLevels(this._pendingLevels)
      this._pendingLevels = null
    }
    if (this._pendingText != null) {
      const text = this._pendingText
      this._pendingText = null
      this._applyText(text)
    }
  }

  /** @param {number[] | number} levels */
  _applyLevels(levels) {
    if (typeof levels === 'number') {
      this._targetEnergy = Math.min(1, Math.max(0, levels))
      return
    }
    if (!Array.isArray(levels) || !levels.length) return
    let sum = 0
    const step = levels.length / BAR_COUNT
    for (let i = 0; i < BAR_COUNT; i++) {
      const idx = Math.min(levels.length - 1, Math.floor(i * step))
      const v = Math.min(1, Math.max(0, levels[idx]))
      this.levels[i] = v
      sum += v
    }
    this._targetEnergy = sum / BAR_COUNT
  }

  _tickOrbMotion() {
    const breath = this.state === 'listening' ? 0.08 : 0.04
    const aim = Math.max(this._targetEnergy, breath)
    this._energy += (aim - this._energy) * 0.18

    if (!this.orbEl) return
    const scale = 1 + this._energy * 0.14
    const baseDuration = this.state === 'processing' ? 24 : 18
    const duration = Math.max(7, baseDuration - this._energy * 11)
    this.orbEl.style.setProperty('--orb-scale', scale.toFixed(3))
    this.orbEl.style.setProperty('--animation-duration', `${duration}s`)
  }

  start() {
    if (this.running) return
    this.running = true
    const tick = () => {
      if (!this.running) return
      this._flushPendingInput()
      this._tickOrbMotion()
      this._raf = requestAnimationFrame(tick)
    }
    this._raf = requestAnimationFrame(tick)
  }

  stop() {
    this.running = false
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = 0
  }

  /** @param {number[] | number} levels */
  setLevels(levels) {
    this._pendingLevels = levels
  }

  /** @param {'listening' | 'processing' | 'complete'} state */
  setState(state) {
    this.state = state
    this.root.classList.remove('voice-orb-panel--processing', 'voice-orb-panel--complete')
    if (state === 'processing') {
      this.root.classList.add('voice-orb-panel--processing')
      if (this.statusEl) this.statusEl.textContent = '识别中'
    } else if (state === 'complete') {
      this.root.classList.add('voice-orb-panel--complete')
      if (this.statusEl) this.statusEl.textContent = '完成'
    } else if (this.statusEl) {
      this.statusEl.textContent = '聆听中'
    }
  }

  /** @param {string} text */
  setText(text) {
    this._pendingText = text
  }

  /** @param {string} text */
  _applyText(text) {
    const clean = String(text || '').trim()
    const display = clean || '正在聆听…'
    if (this._lastAppliedText === display) return
    this._lastAppliedText = display
    if (this.transcriptEl) {
      this.transcriptEl.textContent = display
      this.root.classList.toggle(
        'voice-orb-panel--active-text',
        !!clean && clean !== '正在聆听…',
      )
    }
  }

  reset() {
    this._pendingText = null
    this._pendingLevels = null
    this._lastAppliedText = null
    this._energy = 0
    this._targetEnergy = 0
    this.levels.fill(0)
    this.setState('listening')
    this._applyText('正在聆听…')
    if (this.orbEl) {
      this.orbEl.style.setProperty('--orb-scale', '1')
      this.orbEl.style.setProperty('--animation-duration', '18s')
    }
  }

  destroy() {
    this.stop()
  }
}

/**
 * 创建 Canvas 点云可视化实例（优先方案）。
 * 如果环境不支持 Canvas 或找不到 orb-wrap，则回退到 CSS VoiceVisualizer。
 * @param {HTMLElement} root
 * @returns {VoiceOrbCanvas | VoiceVisualizer}
 */
export function createVoiceVisualizer(root) {
  let canvas = root.querySelector('canvas.voice-orb-canvas')
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.className = 'voice-orb-canvas'
    canvas.style.cssText = 'width:96px;height:96px;display:block;'
    const wrap = root.querySelector('.voice-orb-panel__orb-wrap')
    if (wrap) {
      wrap.innerHTML = ''
      wrap.appendChild(canvas)
    } else {
      // 找不到 wrap，回退到 CSS orb
      return new VoiceVisualizer(root)
    }
  }
  try {
    const orb = new VoiceOrbCanvas(canvas)
    // 绑定外部 HUD 元素，让 setState/setText 能同步 status/transcript 文字
    orb.bindHud(root)
    return orb
  } catch {
    // Canvas 不可用，回退到 CSS orb
    return new VoiceVisualizer(root)
  }
}

/**
 * Canvas 点云可视化 — 移植自既有语音模块 voice-core.js 渲染层。
 * Fibonacci 球面采样 + 正弦噪声形变 + 8 状态色 + 画面节流。
 * 替代 CSS Siri Orb，接口与 VoiceVisualizer 兼容。
 *
 * 仅保留渲染层（不含 ASR/麦克风/WS）。
 * 外部通过 setLevels 注入音量、setState 切换视觉状态、setText 同步 transcript 文字。
 */

// ─── 球面采样（Fibonacci） ───
function fibSphere(n, radius) {
  const pts = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    pts.push({
      x: Math.cos(theta) * r * radius,
      y: y * radius,
      z: Math.sin(theta) * r * radius,
    })
  }
  return pts
}

const PTS_OUTER = fibSphere(3200, 1.0)
const PTS_INNER = fibSphere(1200, 0.88)

// 小尺寸抽稀缓存：球被媒体模式缩成小坞时，4400 个点的投影/排序/逐点绘制
// 大部分是浪费——按 canvas 的 CSS 尺寸隔 N 取 1。Fibonacci 采样均匀，等距抽稀
// 后依旧均匀，小尺寸下视觉无差别，成本随点数线性降。
const PTS_BY_STRIDE = new Map()
function ptsForStride(stride) {
  let pts = PTS_BY_STRIDE.get(stride)
  if (!pts) {
    pts =
      stride === 1
        ? { outer: PTS_OUTER, inner: PTS_INNER }
        : {
            outer: PTS_OUTER.filter((_, i) => i % stride === 0),
            inner: PTS_INNER.filter((_, i) => i % stride === 0),
          }
    PTS_BY_STRIDE.set(stride, pts)
  }
  return pts
}

// ─── 正弦噪声 ───
function sn(x, y, z, t) {
  return (
    Math.sin(x * 2.3 + t * 1.1) * Math.cos(y * 1.9 + t * 0.8) * 0.38 +
    Math.sin(y * 3.1 + t * 1.4) * Math.cos(z * 2.7 + t * 0.6) * 0.3 +
    Math.sin(z * 1.7 + t * 0.9) * Math.cos(x * 3.3 + t * 1.2) * 0.3 +
    Math.sin(x * 5.1 + y * 4.3 + t * 2.1) * 0.14
  )
}

function lerp(a, b, t) {
  return a + (b - a) * t
}
function lerpArr(a, b, t) {
  return a.map((v, i) => lerp(v, b[i], t))
}

// ─── 状态配置（从 legacy voice module 照搬） ───
const STATE_CFG = {
  idle: { amp: 0.003, spd: 0.1, r: [50, 68, 80], g: [50, 68, 80], b: [55, 73, 85] },
  listening: {
    amp: 0.055,
    spd: 0.75,
    r: [185, 215, 245],
    g: [185, 215, 245],
    b: [195, 225, 255],
  },
  recognizing: {
    amp: 0.55,
    spd: 4.5,
    r: [25, 75, 165],
    g: [95, 155, 230],
    b: [195, 230, 255],
  },
  done: { amp: 0.1, spd: 1.2, r: [30, 105, 65], g: [145, 200, 135], b: [45, 90, 60] },
  processing: {
    amp: 0.15,
    spd: 1.1,
    r: [100, 60, 200],
    g: [80, 60, 180],
    b: [220, 190, 255],
  },
  error: { amp: 0.1, spd: 0.7, r: [200, 240, 255], g: [20, 30, 40], b: [20, 30, 40] },
  event: { amp: 0.6, spd: 4.0, r: [255, 200, 50], g: [200, 160, 30], b: [50, 80, 150] },
  speaking: {
    amp: 0.09,
    spd: 1.0,
    r: [130, 95, 185],
    g: [105, 80, 170],
    b: [225, 200, 255],
  },
}

// EvoFlow 状态 → STATE_CFG key 映射
const STATE_MAP = {
  listening: 'listening',
  processing: 'processing',
  complete: 'done',
  idle: 'idle',
  speaking: 'speaking',
  recognizing: 'recognizing',
  error: 'error',
  done: 'done',
  event: 'event',
}

// 画面节流常量
const IDLE_FPS = 18
const SMALL_FPS_CAP = 30
const QUIET_AFTER_MS = 2500
const QUIET_VOL = 0.02

// done 状态自动恢复时间（ms）
const DONE_AUTO_REVERT_MS = 2000
// event 闪烁持续帧数
const EVENT_FLASH_FRAMES = 45

export class VoiceOrbCanvas {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')

    // canvas 的 CSS 短边，绘制帧的 resize 顺手写入（节流档位/抽稀档位都按它判）。
    // 初值取大，首帧按全量画，第一次 resize 后立刻校正。
    this._cssMinSize = Infinity

    // 渲染状态
    this._sk = 'idle'
    this._animState = {
      amp: STATE_CFG.idle.amp,
      spd: STATE_CFG.idle.spd,
      col: [STATE_CFG.idle.r, STATE_CFG.idle.g, STATE_CFG.idle.b],
      t: 0,
      rotY: 0,
      rotX: 0.25,
    }
    this._rafId = null
    this._eventFlashCount = 0
    this._doneTimer = null

    // 画面节流
    this._lastDrawTs = 0
    this._lastVoiceTs = 0
    this._lastVol = 0

    // TTS 分析器
    this._ttsData = null
    this._lastTTSVol = 0

    // 外部音量注入
    this._externalVol = null

    // 接口兼容字段（与 VoiceVisualizer 对齐）
    this.state = 'listening'
    this.running = false

    // 内部画布尺寸缓存
    this._W = 0
    this._H = 0
    this._cx = 0
    this._cy = 0
    this._scale = 0

    // transcript 文字元素（如果外部 HUD 里有）
    this._transcriptEl = null
    this._statusEl = null
    this._root = null
  }

  // ─── 内部：状态名映射 ───
  _mapState(efState) {
    return STATE_MAP[efState] || 'idle'
  }

  /**
   * 根据 CSS 尺寸 + DPR 设置 canvas.width/height，计算 cssMinSize。
   */
  _resizeCanvasToDisplay() {
    const canvas = this.canvas
    const rect = canvas.getBoundingClientRect()
    this._cssMinSize = Math.min(rect.width, rect.height)
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3))
    const nextW = Math.max(1, Math.round(rect.width * dpr))
    const nextH = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW
      canvas.height = nextH
    }
    this._W = nextW
    this._H = nextH
    this._cx = this._W / 2
    this._cy = this._H / 2
    this._scale = Math.min(this._W, this._H) * 0.34
  }

  /**
   * 画面节流档位：返回 0 = 不限（跟随显示器刷新率）。
   * 三档降帧：
   *   ① idle 且无外部音量注入 → 18fps
   *   ② calm(listening/idle) 但持续静音 → 18fps
   *   ③ CSS 短边 ≤100px → 上限 30fps + 点数抽稀 1/4
   */
  _targetDrawFps(ts) {
    let fps = 0
    const calm = this._sk === 'idle' || this._sk === 'listening'
    if (this._sk === 'idle' && this._externalVol == null && !this._ttsData) {
      fps = IDLE_FPS // ①
    } else if (calm && ts - this._lastVoiceTs > QUIET_AFTER_MS) {
      fps = IDLE_FPS // ②
    }
    if (this._cssMinSize <= 100) {
      fps = fps ? Math.min(fps, SMALL_FPS_CAP) : SMALL_FPS_CAP // ③
    }
    return fps
  }

  /**
   * 小坞抽稀档位：≤100px 取 1/4，≤160px 取 1/2，大尺寸全量
   */
  _strideForSize() {
    return this._cssMinSize <= 100 ? 4 : this._cssMinSize <= 160 ? 2 : 1
  }

  // ─── TTS 音量读取 ───
  _readTTSVol() {
    if (!this._ttsData) return 0
    try {
      this._ttsData.analyser.getByteTimeDomainData(this._ttsData.dataArray)
      let sum = 0
      for (const v of this._ttsData.dataArray) {
        const centered = (v - 128) / 128
        sum += centered * centered
      }
      const rms = Math.sqrt(sum / this._ttsData.dataArray.length)
      const level = Math.min(1, Math.max(0, rms * 3.2))
      this._lastTTSVol = lerp(this._lastTTSVol, level, 0.35)
      return this._lastTTSVol
    } catch {
      return 0
    }
  }

  // ─── 内部：触发 done 后自动恢复 ───
  _triggerDoneVisual() {
    this._sk = 'done'
    if (this._doneTimer) clearTimeout(this._doneTimer)
    this._doneTimer = setTimeout(() => {
      this._doneTimer = null
      if (this._sk === 'done') this._sk = 'listening'
    }, DONE_AUTO_REVERT_MS)
  }

  // ─── 渲染主循环 ───
  _drawFrame(now) {
    const ts = now ?? performance.now()
    const ttsVol = this._sk === 'speaking' ? this._readTTSVol() : 0

    // ── 每帧必跑：音量分析 + 状态机推进 ──
    const visualVol =
      this._externalVol != null
        ? this._externalVol
        : this._sk === 'speaking'
          ? ttsVol
          : this._lastVol

    if (visualVol > QUIET_VOL) {
      this._lastVoiceTs = ts
      // 有声时状态推进（仅在非锁定状态时切换）
      if (
        this._sk !== 'recognizing' &&
        this._sk !== 'event' &&
        this._sk !== 'speaking' &&
        this._sk !== 'done' &&
        this._sk !== 'processing'
      ) {
        this._sk = visualVol > 0.15 ? 'recognizing' : 'listening'
      }
    }

    // ── 画面节流 ──
    const fps = this._targetDrawFps(ts)
    if (fps && ts - this._lastDrawTs < 1000 / fps) {
      this._rafId = requestAnimationFrame((t) => this._drawFrame(t))
      return
    }
    this._lastDrawTs = ts
    this._resizeCanvasToDisplay()

    const cfg = STATE_CFG[this._sk] || STATE_CFG.idle
    const s = this._animState
    const ls = 0.025

    // lerp 动画状态过渡
    s.amp = lerp(s.amp, cfg.amp, ls * 8)
    s.spd = lerp(s.spd, cfg.spd, ls * 6)
    s.col = [
      lerpArr(s.col[0], cfg.r, ls * 1.5),
      lerpArr(s.col[1], cfg.g, ls * 1.5),
      lerpArr(s.col[2], cfg.b, ls * 1.5),
    ]

    // 有声时放大振幅/转速
    if (visualVol > QUIET_VOL) {
      s.amp = lerp(s.amp, 0.08 + visualVol * 1.2, 0.4)
      s.spd = lerp(s.spd, 1.0 + visualVol * 5.0, 0.2)
    }

    // event 闪烁自动恢复
    if (this._sk === 'event') {
      this._eventFlashCount--
      if (this._eventFlashCount <= 0) this._sk = 'listening'
    }

    s.t += 0.016 * s.spd
    s.rotY += 0.008
    s.rotX = 0.22 + Math.sin(s.t * 0.15) * 0.06

    const ctx = this.ctx
    ctx.clearRect(0, 0, this._W, this._H)

    const cY = Math.cos(s.rotY)
    const sY = Math.sin(s.rotY)
    const cX = Math.cos(s.rotX)
    const sX = Math.sin(s.rotX)
    const cx = this._cx
    const cy = this._cy
    const scale = this._scale

    const project = (orig) => {
      const d = 1.0 + sn(orig.x, orig.y, orig.z, s.t) * s.amp
      const px = orig.x * d
      const py = orig.y * d
      const pz = orig.z * d
      const rx = px * cY + pz * sY
      const ry0 = py
      const rz = -px * sY + pz * cY
      const ry = ry0 * cX - rz * sX
      const rz2 = ry0 * sX + rz * cX
      return { sx: cx + rx * scale, sy: cy - ry * scale, z: rz2 }
    }

    const { outer, inner } = ptsForStride(this._strideForSize())
    const allPts = []
    for (let i = 0; i < outer.length; i++) {
      const p = outer[i]
      const proj = project(p)
      proj.inner = false
      allPts.push(proj)
    }
    for (let i = 0; i < inner.length; i++) {
      const p = inner[i]
      const proj = project(p)
      proj.inner = true
      allPts.push(proj)
    }
    allPts.sort((a, b) => a.z - b.z)

    for (let i = 0; i < allPts.length; i++) {
      const pt = allPts[i]
      const depth = (pt.z + 1.5) / 3.0
      const r = Math.round(lerp(s.col[0][0], s.col[0][2], depth))
      const g = Math.round(lerp(s.col[1][0], s.col[1][2], depth))
      const b = Math.round(lerp(s.col[2][0], s.col[2][2], depth))
      const alpha = 0.25 + depth * 0.75
      const dotR = pt.inner
        ? 0.4 + depth * 0.5
        : 0.6 + depth * 0.8 + s.amp * 2
      ctx.beginPath()
      ctx.arc(pt.sx, pt.sy, dotR, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(2)})`
      ctx.fill()
    }

    this._rafId = requestAnimationFrame((t) => this._drawFrame(t))
  }

  // ═══════════════════════════════════════════════
  //  与 VoiceVisualizer 兼容的公开接口
  // ═══════════════════════════════════════════════

  /**
   * 接受 number[] 或 number，注入音量驱动球体形变。
   * @param {number[] | number} levels
   */
  setLevels(levels) {
    let vol = 0
    if (typeof levels === 'number') {
      vol = Math.min(1, Math.max(0, levels))
    } else if (Array.isArray(levels) && levels.length) {
      let sum = 0
      for (let i = 0; i < levels.length; i++) {
        sum += Math.min(1, Math.max(0, levels[i]))
      }
      vol = sum / levels.length
    }
    this._lastVol = vol
    // levels 注入也作为「外部音量」优先使用（覆盖 externalVol）
    this._externalVol = vol
  }

  /**
   * 切换视觉状态。
   * @param {'listening' | 'processing' | 'complete' | 'idle' | 'speaking' | 'recognizing' | 'error'} state
   */
  setState(state) {
    this.state = state
    const mapped = this._mapState(state)
    // complete → done，触发自动恢复计时
    if (mapped === 'done') {
      this._sk = 'done'
      if (this._doneTimer) clearTimeout(this._doneTimer)
      this._doneTimer = setTimeout(() => {
        this._doneTimer = null
        if (this._sk === 'done') this._sk = 'listening'
      }, DONE_AUTO_REVERT_MS)
    } else {
      this._sk = mapped
    }

    // event 状态：设置闪烁帧数
    if (mapped === 'event') {
      this._eventFlashCount = EVENT_FLASH_FRAMES
    }

    // 同步外部 HUD 的 status 文字（如果绑定了 root）
    if (this._statusEl) {
      const label =
        state === 'processing'
          ? '识别中'
          : state === 'complete'
            ? '完成'
            : state === 'error'
              ? '出错了'
              : state === 'speaking'
                ? '回答中'
                : '聆听中'
      this._statusEl.textContent = label
    }

    // 同步外部 HUD 的 class（与 VoiceVisualizer 对齐，让 CSS 样式仍生效）
    if (this._root) {
      this._root.classList.remove(
        'voice-orb-panel--processing',
        'voice-orb-panel--complete',
      )
      if (state === 'processing') {
        this._root.classList.add('voice-orb-panel--processing')
      } else if (state === 'complete') {
        this._root.classList.add('voice-orb-panel--complete')
      }
    }
  }

  /**
   * 供外部同步 transcript 文字。Canvas 组件本身不渲染文字，
   * 但如果绑定了外部 HUD 的 transcript 元素则同步更新。
   * @param {string} text
   */
  setText(text) {
    if (!this._transcriptEl) return
    const clean = String(text || '').trim()
    const display = clean || '正在聆听…'
    this._transcriptEl.textContent = display
    if (this._root) {
      this._root.classList.toggle(
        'voice-orb-panel--active-text',
        !!clean && clean !== '正在聆听…',
      )
    }
  }

  /** 启动 rAF 渲染循环 */
  start() {
    if (this.running) return
    this.running = true
    this._resizeCanvasToDisplay()
    this._rafId = requestAnimationFrame((t) => this._drawFrame(t))
  }

  /** 停止 rAF 渲染循环 */
  stop() {
    this.running = false
    if (this._rafId) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
  }

  /** 重置到 idle */
  reset() {
    if (this._doneTimer) {
      clearTimeout(this._doneTimer)
      this._doneTimer = null
    }
    this._sk = 'idle'
    this._eventFlashCount = 0
    this._lastVol = 0
    this._externalVol = null
    this._lastVoiceTs = 0
    this._animState.amp = STATE_CFG.idle.amp
    this._animState.spd = STATE_CFG.idle.spd
    this._animState.col = [STATE_CFG.idle.r, STATE_CFG.idle.g, STATE_CFG.idle.b]
    this.state = 'listening'
    // 同步 HUD 文字
    this.setText('正在聆听…')
    this.setState('listening')
  }

  /** 清理：停止循环 + 清定时器 */
  destroy() {
    this.stop()
    if (this._doneTimer) {
      clearTimeout(this._doneTimer)
      this._doneTimer = null
    }
  }

  // ═══════════════════════════════════════════════
  //  扩展接口
  // ═══════════════════════════════════════════════

  /**
   * 外部音量注入（悬浮球窗口用）。
   * 传 null 取消注入，回到 setLevels / TTS 音量逻辑。
   * @param {number | null} v
   */
  setExternalVol(v) {
    this._externalVol = v == null ? null : Number(v) || 0
  }

  /**
   * 接入 TTS 音量分析器，speaking 状态下用 TTS 音量驱动球体。
   * @param {AnalyserNode | null} analyser
   */
  setTTSAnalyser(analyser) {
    if (analyser) {
      this._ttsData = { analyser, dataArray: new Uint8Array(analyser.fftSize) }
      this._sk = 'speaking'
      return
    }
    this._ttsData = null
    this._lastTTSVol = 0
    if (this._sk === 'speaking') this._sk = 'idle'
  }

  /**
   * 绑定外部 HUD 元素（root + status + transcript），让 setState/setText
   * 能同步更新 HUD 的文字和 CSS class，与 VoiceVisualizer 行为一致。
   * @param {HTMLElement} root
   */
  bindHud(root) {
    this._root = root
    this._statusEl = root.querySelector('.voice-orb-panel__status')
    this._transcriptEl = root.querySelector('.voice-orb-panel__transcript')
  }
}

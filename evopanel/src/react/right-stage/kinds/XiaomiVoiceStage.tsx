/**
 * 小V 语音全屏：干净三块 —— 聆听状态 / 最新用户输入 / AI 回复；
 * 右上角「对话」区复用主对话 V4 时间线（同一套轮分组 / 流式 / 工具卡）。
 * 全屏由 lib/xw-voice-mode.ts 驱动。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { getState, subscribe } from '../../../components/global-assistant/assistant-store.js'
import {
  VOICE_CAPTURE_SESSION_BEGIN,
  VOICE_CAPTURE_SESSION_END,
  setPreferXiaomiVoice,
  subscribeXiaomiVoicePartial,
} from '../../../lib/background-voice-bridge.js'
import {
  stopAssistantVoicePlayback,
  VOICE_TRAY_STATE_EVENT,
  isConversationListeningActive,
} from '../../../lib/background-voice.js'
import {
  toggleXiaomiFramePipeline,
  isXiaomiFramePipelineActive,
  stopXiaomiFramePipeline,
  interruptXiaomiFrame,
} from '../../../lib/xiaomi-voice/index.js'
import { onSpeakingChange } from '../../../lib/speech-client.js'
import { subscribeVoiceLevels } from '../../../lib/voice-capture-service.js'
import { showRightStageBrowserUrl } from '../../../lib/right-stage/open-right-stage-browser.js'
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { notifyLayoutChromeChanged } from '../../../lib/layout-chrome.js'
import { isXwVoiceMode, subscribeXwVoiceMode } from '../../../lib/xw-voice-mode.js'
import { XiaomiV4Timeline } from '../../components/XiaomiV4Timeline.js'
import './xiaomi-voice-stage.css'

/** 舞台只暴露三态：跟流式/播报接口对齐，别再拆「待命/识别/占用」。 */
type StageState = 'listen' | 'think' | 'speak'

const STATE_LABEL: Record<StageState, string> = {
  listen: '聆听',
  think: '思考',
  speak: '播报',
}

/*
 * 状态色：值改指 CSS 令牌，明暗两套由样式表决定。
 * 直接写 hex 会在浅色主题下变成浅底浅字（10px 状态字几乎看不见）。
 */
const STATE_COLOR: Record<StageState, string> = {
  listen: 'var(--xws-state-listen, #4b6fa8)',
  think: 'var(--xws-state-think, #5a6f9a)',
  speak: 'var(--xws-state-speak, #5568a0)',
}

/** 点阵球默认配色（浅色主题蓝灰）；深色由 CSS 变量覆盖。 */
const DOT_MAIN = '#5b7aa8'
const DOT_COOL = '#6b8ab0'
const DOT_CORE = '#3d5a80'
const DOT_COOL_CORE = '#4a6a90'
const LEVEL_BINS = 32

/**
 * 读面板上的主题令牌（点阵球要跟随明暗，canvas 画不出来 CSS 变量）。
 * 令牌写在 .xws-root 上：--xws-dot / --xws-dot-core / --xws-dot-cool / --xws-dot-cool-core。
 */
function isHostDarkTheme(): boolean {
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  return root.dataset.theme === 'dark' || root.classList.contains('dark')
}

function readDotColors(el: Element | null): {
  main: string
  mainCore: string
  cool: string
  coolCore: string
  /** 浅色底点阵要更不透明，否则几乎看不见 */
  alphaBoost: number
} {
  const fallback = {
    main: DOT_MAIN,
    mainCore: DOT_CORE,
    cool: DOT_COOL,
    coolCore: DOT_COOL_CORE,
    alphaBoost: 1.35,
  }
  if (!el || typeof window === 'undefined') return fallback
  try {
    const cs = window.getComputedStyle(el)
    const pick = (name: string, fb: string) => String(cs.getPropertyValue(name) || '').trim() || fb
    const dark = isHostDarkTheme()
    return {
      main: pick('--xws-dot', fallback.main),
      mainCore: pick('--xws-dot-core', fallback.mainCore),
      cool: pick('--xws-dot-cool', fallback.cool),
      coolCore: pick('--xws-dot-cool-core', fallback.coolCore),
      alphaBoost: dark ? 1 : 1.45,
    }
  } catch {
    return fallback
  }
}

function extractUrl(reply: string): string {
  const m = String(reply || '').match(/https?:\/\/[^\s，。；、）)】\]"'）]+/i)
  return m ? m[0] : ''
}

export function XiaomiVoiceStage() {
  const [visible, setVisible] = useState(() => isXwVoiceMode())
  const [state, setState] = useState<StageState>('listen')
  const [transcript, setTranscript] = useState('')
  const [lastUser, setLastUser] = useState('')
  const [reply, setReply] = useState('')
  const [sessionKey, setSessionKey] = useState('')
  const [sessionActive, setSessionActive] = useState(false)
  /** 本轮语音全屏是否已发生过真实交互；刚打开待命时不挂右上角对话浮层。 */
  const [hasInteracted, setHasInteracted] = useState(false)
  /**
   * 右侧 right-stage 是否开着。关着时语音域 CSS 会铺满整窗（真正「放大」）；
   * 开着时语音域固定左栏宽。本组件用按钮直接 collapse/expand store，不退出语音模式。
   */
  const [rightStageOpen, setRightStageOpen] = useState(() => rightStageStore.isOpen)

  const liveRef = useRef({
    session: false,
    speaking: false,
    streaming: false,
    tray: '',
    continuousListen: false,
  })
  const stateSinceRef = useRef(0)
  const stateRef = useRef<StageState>('listen')
  const levelsRef = useRef<number[]>(new Array(LEVEL_BINS).fill(0))
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const parsedReplyRef = useRef('')
  const liveUserTextRef = useRef<HTMLParagraphElement | null>(null)
  const liveAiTextRef = useRef<HTMLParagraphElement | null>(null)

  useEffect(() => {
    stateRef.current = state
    stateSinceRef.current = Date.now()
    if (!visible) return
    // 舞台可见态变化 → 前端日志（聆听/播报/处理中… + 时间点）
    void import('../../../lib/xiaomi-voice/voice-file-log.js')
      .then(({ noteVoiceUiState }) => {
        noteVoiceUiState(state, { source: '语音舞台' })
      })
      .catch(() => {})
  }, [state, visible])

  const derive = useCallback(() => {
    const l = liveRef.current
    const tray = String(l.tray || '')
    // 只认三态，跟流式/播报接口：播报 > 思考(等模型/已发送) > 聆听
    let next: StageState = 'listen'
    if (l.speaking || tray === 'speaking') next = 'speak'
    else if (tray === 'processing' || tray === 'running' || l.streaming) next = 'think'
    setState((prev) => (prev === next ? prev : next))
  }, [])

  useEffect(
    () =>
      subscribeXwVoiceMode((on) => {
        setVisible(on)
        if (on) {
          setPreferXiaomiVoice(true)
          let tries = 0
          const tryStart = () => {
            tries += 1
            if (!isXwVoiceMode() || isXiaomiFramePipelineActive()) return
            void toggleXiaomiFramePipeline({
              onTrayState: (s: string) => {
                liveRef.current.tray = isXiaomiFramePipelineActive() ? s : ''
                derive()
              },
            }).then((ok) => {
              if (!ok && tries < 3 && isXwVoiceMode()) window.setTimeout(tryStart, 900)
            })
          }
          window.setTimeout(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(tryStart)
            })
          }, 560)
        } else {
          liveRef.current.tray = ''
          liveRef.current.continuousListen = false
          liveRef.current.speaking = false
          // 退出全屏：停 Frame + continuous（exitXwVoiceMode 也会调；这里双保险）
          void import('../../../lib/background-voice.js')
            .then((m) => m.shutdownXiaomiVoiceRuntime?.())
            .catch(() => {
              if (isXiaomiFramePipelineActive()) stopXiaomiFramePipeline()
            })
          setTranscript('')
          setLastUser('')
          setReply('')
          setHasInteracted(false)
          setState('listen')
        }
      }),
    [derive],
  )

  useEffect(() => {
    const sync = () => setRightStageOpen(rightStageStore.isOpen)
    sync()
    return rightStageStore.subscribe(sync)
  }, [])

  useEffect(() => {
    const onBegin = () => {
      liveRef.current.session = true
      setSessionActive(true)
      setTranscript(String(getState().draft || ''))
      derive()
    }
    const onEnd = (ev: Event) => {
      liveRef.current.session = false
      setSessionActive(false)
      const cancelled = Boolean((ev as CustomEvent<{ cancelled?: boolean }>)?.detail?.cancelled)
      if (!cancelled) {
        const draft = String(getState().draft || '').trim()
        if (draft) setLastUser(draft)
      }
      // 定稿后清掉听写草稿，中间区与右上角都改用已发送的 user 句
      setTranscript('')
      derive()
    }
    window.addEventListener(VOICE_CAPTURE_SESSION_BEGIN, onBegin as EventListener)
    window.addEventListener(VOICE_CAPTURE_SESSION_END, onEnd as EventListener)
    return () => {
      window.removeEventListener(VOICE_CAPTURE_SESSION_BEGIN, onBegin as EventListener)
      window.removeEventListener(VOICE_CAPTURE_SESSION_END, onEnd as EventListener)
    }
  }, [derive])

  useEffect(() => {
    const onTray = (ev: Event) => {
      const s = String((ev as CustomEvent<{ state?: string }>).detail?.state || '')
      // 正在播报时忽略 continuous 打来的「聆听/空闲」，避免舞台闪回聆听
      const speakingNow =
        liveRef.current.speaking ||
        liveRef.current.tray === 'speaking' ||
        stateRef.current === 'speak'
      if (speakingNow && (s === 'recording' || s === 'idle')) {
        return
      }
      liveRef.current.tray = s
      if (s === 'recording') {
        liveRef.current.continuousListen = true
        // 播报结束回到聆听：清听写草稿，保留 lastUser / reply（与右上角时间线一致）
        if (stateRef.current === 'speak' && !liveRef.current.streaming) {
          setTranscript('')
        }
      }
      if (s === 'idle') liveRef.current.continuousListen = false
      derive()
    }
    window.addEventListener(VOICE_TRAY_STATE_EVENT, onTray as EventListener)
    try {
      if (isConversationListeningActive()) {
        liveRef.current.continuousListen = true
        if (!liveRef.current.tray) liveRef.current.tray = 'recording'
        derive()
      }
    } catch {
      /* ignore */
    }
    return () => window.removeEventListener(VOICE_TRAY_STATE_EVENT, onTray as EventListener)
  }, [derive])

  useEffect(() => {
    const off = onSpeakingChange((v: boolean) => {
      liveRef.current.speaking = v
      derive()
    })
    return () => {
      off()
    }
  }, [derive])

  /* ASR partial 直推左侧「你」；右上角对话区由 V4 时间线自己跟随 */
  useEffect(() => {
    return subscribeXiaomiVoicePartial((text) => {
      const t = String(text || '')
      setTranscript(t)
      if (t.trim()) setLastUser(t)
      liveRef.current.continuousListen = true
      if (!liveRef.current.tray) liveRef.current.tray = 'recording'
      derive()
    })
  }, [derive])

  useEffect(() => {
    const sync = () => {
      const s = getState()
      liveRef.current.streaming = !!s.streaming
      // 右上角 V4 时间线要用同一个会话：sessionKey 变了要跟着换
      const sk = String(s.sessionKey || '').trim()
      setSessionKey((prev) => (prev === sk ? prev : sk))
      const listeningLive =
        liveRef.current.session ||
        liveRef.current.tray === 'recording' ||
        stateRef.current === 'listen'
      // 仅聆听中跟 draft；思考/播报时中间区与右上角都用已落库的 messages，避免 ASR 草稿抢字
      if (listeningLive && !s.streaming) {
        const d = String(s.draft || '')
        setTranscript(d)
        if (d.trim()) setLastUser(d)
      }
      const msgs = Array.isArray(s.messages) ? s.messages : []
      let liveReply = ''
      let liveUser = ''
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i] as { role?: string; text?: string; pending?: boolean }
        if (!liveReply && m?.role === 'assistant') {
          liveReply = String(m.text || '').trim()
          // 空 pending 气泡别把上一轮完整回复清掉（中间区会闪空，和右上角不同步）
          if (liveReply || !m.pending) {
            setReply(liveReply)
          }
          if (liveReply && liveReply !== parsedReplyRef.current) {
            parsedReplyRef.current = liveReply
            const url = extractUrl(liveReply)
            if (url) showRightStageBrowserUrl(url)
          }
          continue
        }
        if (m?.role === 'user') {
          liveUser = String(m.text || '').trim()
          break
        }
      }
      // 已发送的 user 句优先（与 V4 时间线同源）；听写草稿只在聆听时盖上去
      if (liveUser) setLastUser(liveUser)
      derive()
    }
    sync()
    const unsub = subscribe(sync)
    return () => {
      unsub()
    }
  }, [derive])

  useEffect(
    () =>
      subscribeVoiceLevels((levels: number[]) => {
        if (!Array.isArray(levels) || !levels.length) return
        const arr = levelsRef.current
        for (let i = 0; i < arr.length; i++) {
          const v = Number(levels[Math.floor((i / arr.length) * levels.length)])
          if (Number.isFinite(v)) arr[i] += (Math.max(0, Math.min(1, v)) - arr[i]) * 0.35
        }
      }),
    [],
  )

  /* 球面点阵（装饰） */
  useEffect(() => {
    if (!visible) return
    const canvas = canvasRef.current
    const box = canvas?.parentElement
    if (!canvas || !box) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let cancelled = false
    let raf = 0
    let dpr = Math.min(2, window.devicePixelRatio || 1)
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = box.clientWidth
      const h = box.clientHeight
      if (w > 0 && h > 0) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
      }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(box)
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
    const N = 360
    // 主题观察器在 bootTimer 之外创建，才能在 effect cleanup 里断开。
    let themeObserverRef: MutationObserver | null = null
    const bootTimer = window.setTimeout(() => {
      if (cancelled) return
      const pts: Array<{ x: number; y: number; z: number; sz: number; ph: number; cool: boolean; lv: number }> = []
      const GA = Math.PI * (3 - Math.sqrt(5))
      for (let i = 0; i < N; i++) {
        const y0 = 1 - (2 * (i + 0.5)) / N
        const r0 = Math.sqrt(Math.max(0, 1 - y0 * y0))
        const phi = i * GA
        pts.push({
          x: Math.cos(phi) * r0,
          y: y0,
          z: Math.sin(phi) * r0,
          sz: 0.8 + Math.random() * 0.9,
          ph: Math.random() * Math.PI * 2,
          cool: Math.random() < 0.16,
          lv: Math.floor(Math.random() * LEVEL_BINS),
        })
      }
      const sprites = new Map<string, HTMLCanvasElement>()
      // 点阵球配色跟随明暗：canvas 画不出 CSS 变量，这里从面板读取。
      let dotColors = readDotColors(box)
      const sprite = (color: string, coreColor: string) => {
        const key = `${color}|${coreColor}`
        let cv = sprites.get(key)
        if (!cv) {
          cv = document.createElement('canvas')
          cv.width = 12
          cv.height = 12
          const g = cv.getContext('2d')
          if (g) {
            const rg = g.createRadialGradient(6, 6, 0, 6, 6, 6)
            rg.addColorStop(0, coreColor)
            rg.addColorStop(0.35, color)
            rg.addColorStop(1, 'transparent')
            g.fillStyle = rg
            g.beginPath()
            g.arc(6, 6, 6, 0, Math.PI * 2)
            g.fill()
          }
          sprites.set(key, cv)
        }
        return cv
      }
      // 语音全屏开着时用户仍可能切主题 → 观察宿主 data-theme / class，
      // 变了就重读令牌并清空 sprite 缓存（canvas 里画死的颜色不会自动跟随 CSS）。
      const themeObserver = new MutationObserver(() => {
        const next = readDotColors(box)
        if (
          next.main === dotColors.main &&
          next.cool === dotColors.cool &&
          next.mainCore === dotColors.mainCore &&
          next.coolCore === dotColors.coolCore &&
          next.alphaBoost === dotColors.alphaBoost
        ) {
          return
        }
        dotColors = next
        sprites.clear()
      })
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme'],
      })
      themeObserverRef = themeObserver
      let energy = 0.06
      let mouth = 0
      let rotY = 0
      let rotX = -0.22
      let last = performance.now()
      const frame = (t: number) => {
        if (cancelled) return
        raf = requestAnimationFrame(frame)
        const dt = Math.min(50, t - (last || t))
        last = t
        const W = canvas.width
        const H = canvas.height
        if (!W || !H) return
        const st = stateRef.current
        const levels = levelsRef.current
        const motionScale = reduceMotion ? 0.35 : 1
        let target: number
        if (st === 'listen') {
          let sum = 0
          for (let i = 0; i < levels.length; i++) sum += levels[i]
          target = 0.3 + (sum / levels.length) * 0.8
        } else if (st === 'think') target = 0.32 + 0.12 * Math.sin(t * 0.004)
        else target = 0.28 + 0.06 * Math.abs(Math.sin(t * 0.0038)) // speak
        energy += (target - energy) * 0.07
        // 播报：慢呼吸起伏，不要旧的「嘴型」ripple（球面被撕开很难受）
        if (st === 'speak') {
          const breath = 0.5 + 0.5 * Math.sin(t * 0.0032)
          mouth += (breath - mouth) * 0.045
        } else mouth += (0 - mouth) * 0.12

        ctx.globalCompositeOperation = 'destination-out'
        ctx.fillStyle = st === 'speak' ? 'rgba(0,0,0,.28)' : 'rgba(0,0,0,.4)'
        ctx.fillRect(0, 0, W, H)
        ctx.globalCompositeOperation = 'source-over'

        const cx = W / 2
        const cy = H * 0.42
        const R = Math.min(W, H) * 0.22
        const rotSpd =
          st === 'think'
            ? 0.00058
            : st === 'speak'
              ? 0.00008
              : st === 'listen'
                ? 0.00014 + energy * 0.00014
                : 0.00005
        rotY += rotSpd * dt * motionScale
        const tiltBase =
          st === 'think'
            ? Math.sin(t * 0.0012) * 0.42 - 0.2
            : st === 'speak'
              ? Math.sin(t * 0.0004) * 0.06 - 0.2
              : Math.sin(t * 0.00032) * 0.16 - 0.22
        rotX += (tiltBase - rotX) * 0.05
        const cosY = Math.cos(rotY)
        const sinY = Math.sin(rotY)
        const cosX = Math.cos(rotX)
        const sinX = Math.sin(rotX)
        const F = 3.2
        const LX = -0.48
        const LY = -0.68
        const LZ = -0.55
        const spMain = sprite(dotColors.main, dotColors.mainCore)
        const spCool = sprite(dotColors.cool, dotColors.coolCore)
        // 播报：整体轻柔缩放，不做按纬度的嘴型变形
        const speakScale = st === 'speak' ? 1 + mouth * 0.035 : 1
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i]
          const theta = Math.acos(Math.max(-1, Math.min(1, p.y)))
          let r = 1
          if (st === 'speak') r = speakScale
          else if (st === 'listen') r += (levels[p.lv] || 0) * 0.06 + Math.sin(t * 0.005 + p.ph) * 0.012
          else if (st === 'think') r = 0.72 + Math.sin(theta * 3 + t * 0.003) * 0.05
          else r += Math.sin(t * 0.0012) * 0.025
          const rr = r * R
          const x1 = p.x * cosY + p.z * sinY
          const z1 = -p.x * sinY + p.z * cosY
          const y2 = p.y * cosX - z1 * sinX
          const z2 = p.y * sinX + z1 * cosX
          const bright = Math.max(0, x1 * LX + y2 * LY + z2 * LZ)
          const shade = 0.18 + 0.82 * bright
          const persp = F / (F + z2 * r)
          const X = cx + x1 * rr * persp
          const Y = cy + y2 * rr * persp
          const frontness = Math.max(0, Math.min(1, (persp - 0.72) / 0.8))
          const sz = p.sz * dpr * (0.72 + 0.42 * frontness) * (dotColors.alphaBoost > 1 ? 1.08 : 1)
          let al = (0.16 + 0.52 * frontness) * shade * dotColors.alphaBoost
          if (st === 'speak') al = Math.min(0.92, al + mouth * 0.06)
          else if (st === 'listen') al = Math.min(0.98, al + energy * 0.16)
          ctx.globalAlpha = Math.min(0.98, al)
          ctx.drawImage(p.cool ? spCool : spMain, X - sz, Y - sz, sz * 2, sz * 2)
        }
        ctx.globalAlpha = 1
      }
      raf = requestAnimationFrame(frame)
    }, 520)
    return () => {
      cancelled = true
      window.clearTimeout(bootTimer)
      cancelAnimationFrame(raf)
      ro.disconnect()
      themeObserverRef?.disconnect()
      themeObserverRef = null
    }
  }, [visible])

  const onTopbarDoubleClick = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('[data-tauri-no-drag],button')) return
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => void getCurrentWindow().toggleMaximize())
  }, [])

  const onInterrupt = useCallback(() => {
    if (stateRef.current !== 'speak' && !liveRef.current.speaking) return
    void interruptXiaomiFrame()
    try {
      stopAssistantVoicePlayback()
    } catch {
      /* ignore */
    }
  }, [])

  const showUser = useMemo(() => {
    // 聆听：听写草稿优先；思考/播报：用已发送句（与右上角 V4 一致）
    if (state === 'listen' && (sessionActive || transcript.trim())) {
      return transcript || lastUser
    }
    return lastUser
  }, [sessionActive, state, transcript, lastUser])

  /*
   * 右上角对话浮层：刚打开不显示；等用户真正开口 / AI 开始回再出现。
   * 一旦出现过就 latch；退出语音模式时清零。
   */
  useEffect(() => {
    if (!visible || hasInteracted) return
    const liveTurn =
      sessionActive ||
      Boolean(String(transcript || '').trim()) ||
      state === 'think' ||
      state === 'speak'
    if (liveTurn) setHasInteracted(true)
  }, [visible, hasInteracted, state, sessionActive, transcript])

  const stColor = STATE_COLOR[state]
  const stateWord = STATE_LABEL[state]
  const showRecent = hasInteracted
  /** 右侧关着 = 语音域已铺满整窗。 */
  const voiceExpanded = !rightStageOpen

  /* 长文在框内滚：流式/听写时贴底，始终看见最新一句 */
  useEffect(() => {
    const el = liveAiTextRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [reply])
  useEffect(() => {
    const el = liveUserTextRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [showUser])

  const toggleVoiceExpand = useCallback(() => {
    if (rightStageStore.isOpen) {
      // 放大：只收右侧栏，不退出语音模式（CSS 会让 .xw-voice-host 铺满）
      rightStageStore.collapse()
      notifyLayoutChromeChanged('xw-voice-expand')
    } else {
      rightStageStore.expand()
      notifyLayoutChromeChanged('xw-voice-shrink')
    }
  }, [])

  if (!visible) return null

  return (
    <div
      className={`xws-root xws-clean xws-${state} xw-voice-host${voiceExpanded ? ' is-voice-expanded' : ''}`}
      style={{ '--xws-state': stColor } as CSSProperties}
    >
      {/*
        WebView2 不吃父级 data-tauri-drag-region 继承：必须单独挂一条顶栏拖动带。
        语音全屏会藏掉 .react-chat-header，没有这条就没法拖窗。
      */}
      <div
        className="xws-drag-strip"
        data-tauri-drag-region=""
        title="拖动窗口 · 双击最大化"
        onDoubleClick={onTopbarDoubleClick}
      />
      <div className="xws-chrome-top" data-tauri-no-drag="">
        <button
          type="button"
          className="xws-exit"
          onClick={() => {
            void import('../../../lib/xiaomi-voice-close.js').then((m) =>
              m.closeXiaomiVoice({ reason: 'button' }),
            )
          }}
          aria-label="退出语音"
          title="退出语音"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="xws-expand"
          onClick={toggleVoiceExpand}
          aria-label={voiceExpanded ? '缩小语音区' : '放大语音区'}
          title={voiceExpanded ? '缩小（打开右侧面板）' : '放大（关闭右侧，语音铺满）'}
        >
          {voiceExpanded ? (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M3 9h4v4M13 7H9V3M7 9 3.5 12.5M9 7l3.5-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M3 6V3h3M13 6V3H10M3 10v3h3M13 10v3h-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      </div>

      {/*
        右上角「对话」区 = 主对话 V4 时间线。
        仅交互后挂载；语音域放大/缩小由左上「放大/缩小」控制右侧栏。
      */}
      {showRecent ? (
        <aside className="xws-recent xws-recent--timeline" data-tauri-no-drag="" aria-label="对话">
          <div className="xws-recent-body xws-recent-body--timeline">
            {sessionKey ? (
              <XiaomiV4Timeline sessionKey={sessionKey} surface="glass" embedded />
            ) : (
              <div className="xws-recent-empty">对话与工具会出现在这里</div>
            )}
          </div>
        </aside>
      ) : null}

      <div className="xws-stage" onClick={onInterrupt} title={state === 'speak' ? '点击打断' : undefined}>
        <canvas ref={canvasRef} className="xws-canvas" aria-hidden="true" />
      </div>

      <div className="xws-focus" data-tauri-no-drag="">
        <div className={`xws-status${state === 'listen' ? ' is-live' : ''}`} aria-live="polite">
          {state === 'listen' ? <span className="xws-state-dot" aria-hidden="true" /> : null}
          <span className="xws-status-word">{stateWord}</span>
        </div>
        <div className="xws-live-user">
          <p ref={liveUserTextRef} className="xws-live-text">
            {showUser || '…'}
          </p>
        </div>
        <div className="xws-live-ai">
          <p ref={liveAiTextRef} className="xws-live-text">
            {reply || (state === 'think' ? '…' : '')}
          </p>
        </div>
      </div>
    </div>
  )
}

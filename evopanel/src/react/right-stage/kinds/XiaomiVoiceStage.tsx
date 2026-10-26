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
import { isXwVoiceMode, subscribeXwVoiceMode } from '../../../lib/xw-voice-mode.js'
import { XiaomiV4Timeline } from '../../components/XiaomiV4Timeline.js'
import './xiaomi-voice-stage.css'

type StageState = 'idle' | 'listen' | 'parse' | 'think' | 'speak'

const STATE_LABEL: Record<StageState, string> = {
  idle: '待命',
  listen: '聆听',
  parse: '识别',
  think: '思考',
  speak: '播报',
}

/*
 * 状态色：值改指 CSS 令牌，明暗两套由样式表决定。
 * 直接写 hex 会在浅色主题下变成浅底浅字（10px 状态字几乎看不见）。
 */
const STATE_COLOR: Record<StageState, string> = {
  idle: 'var(--xws-state-idle, #9fb2c8)',
  listen: 'var(--xws-state-listen, #38bdf8)',
  parse: 'var(--xws-state-parse, #60a5fa)',
  think: 'var(--xws-state-think, #a78bfa)',
  // 播报：靛紫蓝（去掉刺眼绿）
  speak: 'var(--xws-state-speak, #818cf8)',
}

/** 点阵球默认配色（浅色主题）；深色主题由 CSS 变量覆盖。 */
const DOT_MAIN = '#334155'
const DOT_COOL = '#0284c7'
const DOT_CORE = '#1e293b'
const DOT_COOL_CORE = '#075985'
const LEVEL_BINS = 32

/**
 * 读面板上的主题令牌（点阵球要跟随明暗，canvas 画不出来 CSS 变量）。
 * 令牌写在 .xws-root 上：--xws-dot / --xws-dot-core / --xws-dot-cool / --xws-dot-cool-core。
 */
function readDotColors(el: Element | null): {
  main: string
  mainCore: string
  cool: string
  coolCore: string
} {
  const fallback = { main: DOT_MAIN, mainCore: DOT_CORE, cool: DOT_COOL, coolCore: DOT_COOL_CORE }
  if (!el || typeof window === 'undefined') return fallback
  try {
    const cs = window.getComputedStyle(el)
    const pick = (name: string, fb: string) => String(cs.getPropertyValue(name) || '').trim() || fb
    return {
      main: pick('--xws-dot', fallback.main),
      mainCore: pick('--xws-dot-core', fallback.mainCore),
      cool: pick('--xws-dot-cool', fallback.cool),
      coolCore: pick('--xws-dot-cool-core', fallback.coolCore),
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
  const [state, setState] = useState<StageState>('idle')
  const [transcript, setTranscript] = useState('')
  const [lastUser, setLastUser] = useState('')
  const [reply, setReply] = useState('')
  const [sessionKey, setSessionKey] = useState('')
  const [sessionActive, setSessionActive] = useState(false)
  const [parseHold, setParseHold] = useState(false)

  const liveRef = useRef({
    session: false,
    speaking: false,
    streaming: false,
    tray: '',
    continuousListen: false,
  })
  const parseHoldRef = useRef(false)
  const stateSinceRef = useRef(0)
  const stateRef = useRef<StageState>('idle')
  const levelsRef = useRef<number[]>(new Array(LEVEL_BINS).fill(0))
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const parsedReplyRef = useRef('')

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
    let continuous = false
    try {
      continuous = isConversationListeningActive()
    } catch {
      continuous = !!l.continuousListen
    }
    l.continuousListen = continuous
    // 优先级必须对齐 Pipecat 听感：播报 > 处理/思考 > 聆听
    // 旧逻辑把 continuous/recording 放在 processing 前 → 永远卡在「聆听」
    let next: StageState = 'idle'
    if (l.speaking || tray === 'speaking') next = 'speak'
    else if (tray === 'processing' || parseHoldRef.current) next = 'parse'
    else if (tray === 'running' || l.streaming) next = 'think'
    else if (l.session || tray === 'recording' || continuous) next = 'listen'
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
          setState('idle')
        }
      }),
    [derive],
  )

  useEffect(() => {
    let parseTimer = 0
    const onBegin = () => {
      parseHoldRef.current = false
      setParseHold(false)
      if (parseTimer) window.clearTimeout(parseTimer)
      liveRef.current.session = true
      setSessionActive(true)
      setTranscript(String(getState().draft || ''))
      derive()
    }
    const onEnd = (ev: Event) => {
      liveRef.current.session = false
      setSessionActive(false)
      const cancelled = Boolean((ev as CustomEvent<{ cancelled?: boolean }>)?.detail?.cancelled)
      if (cancelled) {
        parseHoldRef.current = false
        setParseHold(false)
      } else {
        setLastUser(String(getState().draft || ''))
        parseHoldRef.current = true
        setParseHold(true)
        parseTimer = window.setTimeout(() => {
          parseHoldRef.current = false
          setParseHold(false)
          derive()
        }, 1600)
      }
      derive()
    }
    window.addEventListener(VOICE_CAPTURE_SESSION_BEGIN, onBegin as EventListener)
    window.addEventListener(VOICE_CAPTURE_SESSION_END, onEnd as EventListener)
    return () => {
      if (parseTimer) window.clearTimeout(parseTimer)
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
        // 播报/空闲回到聆听可清空「你」；生成中禁止清——否则用户句闪一下就没
        const st = stateRef.current
        if (
          (st === 'speak' || st === 'idle') &&
          !liveRef.current.streaming &&
          !parseHoldRef.current
        ) {
          setTranscript('')
          // 保留 lastUser：右上角/本轮「你」要对着刚发出的那句
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
      let continuous = false
      try {
        continuous = isConversationListeningActive()
      } catch {
        continuous = !!liveRef.current.continuousListen
      }
      const listeningLive =
        liveRef.current.session ||
        continuous ||
        liveRef.current.tray === 'recording' ||
        stateRef.current === 'listen'
      if (listeningLive || parseHoldRef.current) {
        const d = String(s.draft || '')
        setTranscript(d)
        if (d.trim()) setLastUser(d)
      }
      const msgs = Array.isArray(s.messages) ? s.messages : []
      let liveReply = ''
      let liveUser = ''
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i] as { role?: string; text?: string }
        if (!liveReply && m?.role === 'assistant') {
          liveReply = String(m.text || '').trim()
          setReply(liveReply)
          if (liveReply && liveReply !== parsedReplyRef.current) {
            parsedReplyRef.current = liveReply
            const url = extractUrl(liveReply)
            if (url) showRightStageBrowserUrl(url)
          }
          continue
        }
        if (m?.role === 'user') {
          liveUser = String(m.text || '').trim()
          if (!liveReply) setReply('')
          break
        }
      }
      const draft = String(s.draft || '').trim()
      // 本轮用户句：听写中用 draft；否则用消息里紧挨助手前的那条 user
      const focusUser = draft || liveUser
      if (focusUser) setLastUser(focusUser)
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
          next.coolCore === dotColors.coolCore
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
        else if (st === 'speak') target = 0.38 + 0.2 * Math.abs(Math.sin(t * 0.014))
        else if (st === 'parse') target = 0.2
        else target = 0.06 + 0.02 * Math.sin(t * 0.0016)
        energy += (target - energy) * 0.09
        if (st === 'speak') {
          const ph = t * 0.01
          const syl = Math.max(0, Math.sin(ph) + Math.sin(ph * 2.3 + 1.7) * 0.5)
          mouth += (Math.min(1, syl) - mouth) * 0.32
        } else mouth += (0 - mouth) * 0.18

        ctx.globalCompositeOperation = 'destination-out'
        ctx.fillStyle = 'rgba(0,0,0,.4)'
        ctx.fillRect(0, 0, W, H)
        ctx.globalCompositeOperation = 'source-over'

        const cx = W / 2
        const cy = H * 0.42
        const R = Math.min(W, H) * 0.22
        const rotSpd =
          st === 'think' ? 0.00058 : st === 'speak' ? 0.0002 + mouth * 0.00016 : st === 'listen' ? 0.00014 + energy * 0.00014 : 0.00005
        rotY += rotSpd * dt * motionScale
        const tiltBase = st === 'think' ? Math.sin(t * 0.0012) * 0.42 - 0.2 : Math.sin(t * 0.00032) * 0.16 - 0.22
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
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i]
          const theta = Math.acos(Math.max(-1, Math.min(1, p.y)))
          let r = 1
          if (st === 'speak') r += Math.sin(theta * 5.2 - t * 0.009 + p.ph * 0.15) * mouth * 0.14
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
          const sz = p.sz * dpr * (0.72 + 0.42 * frontness)
          let al = (0.16 + 0.52 * frontness) * shade
          if (st === 'speak') al = Math.min(0.95, al + mouth * 0.15)
          else if (st === 'listen') al = Math.min(0.95, al + energy * 0.16)
          ctx.globalAlpha = al
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
    if (sessionActive || parseHold || state === 'listen' || state === 'parse') {
      return transcript || lastUser
    }
    return lastUser
  }, [sessionActive, parseHold, state, transcript, lastUser])

  const stColor = STATE_COLOR[state]
  const stateWord = STATE_LABEL[state]

  if (!visible) return null

  return (
    <div
      className={`xws-root xws-clean xws-${state} xw-voice-host`}
      style={{ '--xws-state': stColor } as CSSProperties}
      data-tauri-drag-region=""
      onDoubleClick={onTopbarDoubleClick}
    >
      <button
        type="button"
        className="xws-exit"
        data-tauri-no-drag=""
        onClick={() => {
          void import('../../../lib/xiaomi-voice-close.js').then((m) =>
            m.closeXiaomiVoice({ reason: 'button' }),
          )
        }}
        aria-label="退出语音"
        title="退出语音"
      >
        退出
      </button>

      {/*
        右上角「对话」区 = 主对话 V4 时间线（同一套轮分组 / 流式 / 工具卡）。
        皮肤走 glass：宿主明暗 + 玻璃底，浮在语音画面上。
      */}
      <aside className="xws-recent xws-recent--timeline" data-tauri-no-drag="" aria-label="对话">
        <div className="xws-recent-head">
          <span className="xws-recent-head-title">对话</span>
          <span className="xws-recent-head-state" data-state={state}>
            {stateWord}
          </span>
        </div>
        <div className="xws-recent-body xws-recent-body--timeline">
          {sessionKey ? (
            <XiaomiV4Timeline sessionKey={sessionKey} surface="glass" embedded />
          ) : (
            <div className="xws-recent-empty">对话与工具会出现在这里</div>
          )}
        </div>
      </aside>

      <div className="xws-stage" onClick={onInterrupt} title={state === 'speak' ? '点击打断' : undefined}>
        <canvas ref={canvasRef} className="xws-canvas" aria-hidden="true" />
      </div>

      <div className="xws-focus" data-tauri-no-drag="">
        <div className={`xws-status${state === 'listen' ? ' is-live' : ''}`} aria-live="polite">
          {state === 'listen' ? <span className="xws-state-dot" aria-hidden="true" /> : null}
          <span className="xws-status-word">{stateWord}</span>
        </div>
        <div className="xws-live-user">
          <span className="xws-live-label">你</span>
          <p className="xws-live-text">{showUser || '…'}</p>
        </div>
        <div className="xws-live-ai">
          <span className="xws-live-label">小V</span>
          <p className="xws-live-text">{reply || (state === 'think' || state === 'parse' ? '…' : '')}</p>
        </div>
      </div>
    </div>
  )
}

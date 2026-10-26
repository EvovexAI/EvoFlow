/**
 * 小V 语音域（语音全屏模式左栏）：纯黑点阵球 + 状态大字 + 消息条 + PTT。
 * 全屏模式由 lib/xw-voice-mode.ts 驱动：本组件常驻渲染在 main-body 内，
 * 仅在 html[data-xw-voice='1'] 时由 CSS 显示（避免与 right-stage 小V标签耦合）。
 * 「打开xx」类内容一律开 right-stage 标签页（复用标签系统），不再内嵌 iframe。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { getState, subscribe } from '../../../components/global-assistant/assistant-store.js'
import {
  VOICE_CAPTURE_SESSION_BEGIN,
  VOICE_CAPTURE_SESSION_END,
  setPreferXiaomiVoice,
} from '../../../lib/background-voice-bridge.js'
import {
  startVoicePtt,
  stopVoicePtt,
  toggleContinuousMode,
  isContinuousModeActive,
  stopAssistantVoicePlayback,
} from '../../../lib/background-voice.js'
import { onSpeakingChange } from '../../../lib/speech-client.js'
import { subscribeVoiceLevels } from '../../../lib/voice-capture-service.js'
import { showRightStageBrowserUrl } from '../../../lib/right-stage/open-right-stage-browser.js'
import { enterXwVoiceMode, exitXwVoiceMode, isXwVoiceMode, subscribeXwVoiceMode } from '../../../lib/xw-voice-mode.js'
import { toast } from '../../../components/toast.js'
import './xiaomi-voice-stage.css'

type StageState = 'idle' | 'listen' | 'parse' | 'think' | 'speak'

/** 左下状态大字（参考「艾薇正在说话」的临场文案） */
const STATE_TITLE: Record<StageState, { title: string; sub: string; en: string }> = {
  idle: { title: '小V 待命中', sub: '按住语音键说话，或开启免提连续对话', en: 'STANDBY' },
  listen: { title: '小V 正在聆听', sub: '请讲，我在听', en: 'LISTENING' },
  parse: { title: '小V 正在识别', sub: '整理你刚说的话', en: 'PARSING' },
  think: { title: '小V 正在思考', sub: '查名册、看进度、派任务…', en: 'THINKING' },
  speak: { title: '小V 正在播报', sub: '再次按下语音键即可打断', en: 'SPEAKING' },
}

const STATE_COLOR: Record<StageState, string> = {
  idle: '#9fb2c8',
  listen: '#22d3ee',
  parse: '#38bdf8',
  think: '#a78bfa',
  speak: '#34d399',
}

const DOT_MAIN = '#eaf4ff'
const DOT_COOL = '#9fd8ff'
const LEVEL_BINS = 32

type HistRow = { key: string; title: string; messageCount?: number }

/** 小V 回复里的第一个 URL → 直接开成 right-stage 浏览器标签 */
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
  const [handsfree, setHandsfree] = useState(() => {
    try {
      return isContinuousModeActive()
    } catch {
      return false
    }
  })
  const [elapsed, setElapsed] = useState('00:00')
  const [sessionActive, setSessionActive] = useState(false)
  const [parseHold, setParseHold] = useState(false)
  /* 历史对话（语音域自管，脱离小V标签渲染） */
  const [histOpen, setHistOpen] = useState(false)
  const [histLoading, setHistLoading] = useState(false)
  const [sessions, setSessions] = useState<HistRow[]>([])
  const [sessionKey, setSessionKey] = useState('')

  /** 语音链路实时量（不参与渲染，事件/回调内读写） */
  const liveRef = useRef({ session: false, speaking: false, streaming: false, tray: '' })
  const parseHoldRef = useRef(false)
  const heldRef = useRef(false)
  const stateSinceRef = useRef(0)
  const stateRef = useRef<StageState>('idle')
  const levelsRef = useRef<number[]>(new Array(LEVEL_BINS).fill(0))
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const waveRef = useRef<HTMLCanvasElement | null>(null)
  const parsedReplyRef = useRef('')

  useEffect(() => {
    stateRef.current = state
    stateSinceRef.current = Date.now()
  }, [state])

  const derive = useCallback(() => {
    const l = liveRef.current
    const tray = String(l.tray || '')
    let next: StageState = 'idle'
    if (l.session || tray === 'recording') next = 'listen'
    else if (l.speaking || tray === 'speaking') next = 'speak'
    else if (tray === 'processing') next = 'parse'
    else if (tray === 'running' || l.streaming) next = 'think'
    else if (parseHoldRef.current) next = 'parse'
    setState((prev) => (prev === next ? prev : next))
  }, [])

  /* ── 语音全屏模式联动：进入语音域自动免提常听；退出收麦（唤醒词耳朵常驻）。 ── */
  useEffect(
    () =>
      subscribeXwVoiceMode((on) => {
        setVisible(on)
        if (on) {
          setPreferXiaomiVoice(true)
          // ensureXiaomiVoiceReplyOn 由 enterXwVoiceMode 统一触发，这里不重复
          let tries = 0
          const tryStart = () => {
            tries += 1
            if (!isXwVoiceMode() || isContinuousModeActive()) return
            void toggleContinuousMode({
              onTrayState: (s: string) => {
                liveRef.current.tray = isContinuousModeActive() ? s : ''
                derive()
              },
            }).then((ok) => {
              if (ok) setHandsfree(true)
              else if (tries < 3 && isXwVoiceMode()) window.setTimeout(tryStart, 900)
            })
          }
          // 等右缘弧形展开完成后再开麦，减轻打开瞬间主线程争抢
          window.setTimeout(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(tryStart)
            })
          }, 560)
        } else {
          liveRef.current.tray = ''
          if (isContinuousModeActive()) {
            void toggleContinuousMode().then(() => setHandsfree(false))
          }
        }
      }),
    [derive],
  )

  /* ── 录音 session 事件 ── */
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

  /* ── TTS 播报状态 ── */
  useEffect(() => {
    const off = onSpeakingChange((v: boolean) => {
      liveRef.current.speaking = v
      derive()
    })
    return () => {
      off()
    }
  }, [derive])

  /* ── 会话 store：转写（draft）/ 回复（最后一条 assistant）/ streaming / 历史列表 ── */
  useEffect(() => {
    const sync = () => {
      const s = getState() as ReturnType<typeof getState> & {
        xiaomiSessions?: HistRow[]
        xiaomiSessionsLoading?: boolean
      }
      liveRef.current.streaming = !!s.streaming
      if (liveRef.current.session || parseHoldRef.current) {
        setTranscript(String(s.draft || ''))
      }
      setSessionKey(String(s.sessionKey || ''))
      setSessions(Array.isArray(s.xiaomiSessions) ? s.xiaomiSessions : [])
      setHistLoading(!!s.xiaomiSessionsLoading)
      const msgs = Array.isArray(s.messages) ? (s.messages as Array<{ role?: string; text?: string }>) : []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m?.role === 'assistant') {
          const text = String(m.text || '')
          setReply(text)
          /* 回复中的链接 → right-stage 浏览器标签（每条回复只触发一次） */
          if (text && text !== parsedReplyRef.current) {
            parsedReplyRef.current = text
            const url = extractUrl(text)
            if (url) showRightStageBrowserUrl(url)
          }
          break
        }
        if (m?.role === 'user') {
          setReply('')
          break
        }
      }
      derive()
    }
    sync()
    const unsub = subscribe(sync)
    return () => {
      unsub()
    }
  }, [derive])

  /* ── 麦克风电平 ── */
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

  /* ── 计时 ── */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const st = stateRef.current
      let next = '00:00'
      if (st === 'listen' || st === 'speak') {
        const sec = Math.max(0, Math.floor((Date.now() - (stateSinceRef.current || Date.now())) / 1000))
        next = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
      }
      setElapsed((prev) => (prev === next ? prev : next))
    }, 500)
    return () => window.clearInterval(timer)
  }, [])

  /* ── 球面点阵画布（依赖 visible：语音模式开启时才挂 canvas，退出即停帧） ── */
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

    /* 等右缘弧形展开（~480ms）后再跑点阵，避免与 clip-path 动画抢帧 */
    const N = 420
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
      const sprite = (color: string) => {
        let cv = sprites.get(color)
        if (!cv) {
          cv = document.createElement('canvas')
          cv.width = 12
          cv.height = 12
          const g = cv.getContext('2d')
          if (g) {
            const rg = g.createRadialGradient(6, 6, 0, 6, 6, 6)
            rg.addColorStop(0, '#ffffff')
            rg.addColorStop(0.35, color)
            rg.addColorStop(1, 'transparent')
            g.fillStyle = rg
            g.beginPath()
            g.arc(6, 6, 6, 0, Math.PI * 2)
            g.fill()
          }
          sprites.set(color, cv)
        }
        return cv
      }

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
        } else if (st === 'think') {
          target = 0.32 + 0.12 * Math.sin(t * 0.004)
        } else if (st === 'speak') {
          target = 0.38 + 0.2 * Math.abs(Math.sin(t * 0.014)) + 0.06 * Math.random()
        } else if (st === 'parse') {
          target = 0.2
        } else {
          target = 0.06 + 0.02 * Math.sin(t * 0.0016)
        }
        energy += (target - energy) * 0.09
        if (st === 'speak') {
          const ph = t * 0.01
          const syl = Math.max(
            0,
            Math.sin(ph) + Math.sin(ph * 2.3 + 1.7) * 0.5 + Math.sin(ph * 4.1 + 0.6) * 0.25 + Math.random() * 0.14,
          )
          mouth += (Math.min(1, syl) - mouth) * 0.32
        } else {
          mouth += (0 - mouth) * 0.18
        }

        ctx.globalCompositeOperation = 'destination-out'
        ctx.fillStyle = 'rgba(0,0,0,.4)'
        ctx.fillRect(0, 0, W, H)
        ctx.globalCompositeOperation = 'source-over'

        const cx = W / 2
        const cy = H / 2
        const R = Math.min(W, H) * 0.3
        const stColor = STATE_COLOR[st]

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

        const spMain = sprite(DOT_MAIN)
        const spCool = sprite(DOT_COOL)

        for (let i = 0; i < pts.length; i++) {
          const p = pts[i]
          const theta = Math.acos(Math.max(-1, Math.min(1, p.y)))
          let r = 1
          if (st === 'speak') {
            const wave = Math.sin(theta * 5.2 - t * 0.009 + p.ph * 0.15)
            r += wave * mouth * 0.14
          } else if (st === 'listen') {
            r += (levels[p.lv] || 0) * 0.06 + Math.sin(t * 0.005 + p.ph) * 0.012
          } else if (st === 'think') {
            r = 0.72 + Math.sin(theta * 3 + t * 0.003) * 0.05
          } else if (st === 'parse') {
            r += Math.sin(t * 0.007 + p.ph) * 0.022
          } else {
            r += Math.sin(t * 0.0012) * 0.025 + Math.sin(t * 0.0009 + p.ph) * 0.01
          }
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

        ctx.strokeStyle = stColor
        ctx.globalAlpha = 0.12 + energy * 0.15
        ctx.lineWidth = dpr
        ctx.beginPath()
        ctx.arc(cx, cy, R * 1.24, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = 1
      }
      raf = requestAnimationFrame(frame)
    }, 520)

    return () => {
      cancelled = true
      window.clearTimeout(bootTimer)
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [visible])

  /* ── 竖线声纹 ── */
  useEffect(() => {
    if (!visible) return
    const canvas = waveRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw)
      const rect = canvas.getBoundingClientRect()
      const w = Math.round(rect.width)
      const h = Math.round(rect.height)
      if (!w || !h) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const st = stateRef.current
      const stColor = STATE_COLOR[st]
      const bars = 18
      const bw = canvas.width / bars
      for (let i = 0; i < bars; i++) {
        let v: number
        if (st === 'listen') v = levelsRef.current[Math.floor((i / bars) * LEVEL_BINS)] || 0
        else if (st === 'speak') v = Math.abs(Math.sin(t * 0.01 + i * 0.7)) * (0.3 + 0.6 * Math.random() * 0.5 + 0.15)
        else if (st === 'think' || st === 'parse') v = 0.12 + 0.08 * Math.sin(t * 0.004 + i * 0.9)
        else v = 0.05 + 0.03 * Math.sin(t * 0.001 + i * 0.5)
        const barH = Math.max(2 * dpr, v * canvas.height)
        const x = i * bw + bw * 0.3
        ctx.globalAlpha = 0.85
        ctx.fillStyle = i === Math.floor(bars / 2) ? stColor : '#cfe3ff'
        ctx.fillRect(x, canvas.height / 2 - barH / 2, bw * 0.4, barH)
      }
      ctx.globalAlpha = 1
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [visible])

  /* ── 交互 ── */
  const onPttDown = useCallback((e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    heldRef.current = true
    setPreferXiaomiVoice(true)
    void startVoicePtt()
  }, [])
  const onPttUp = useCallback(() => {
    if (!heldRef.current) return
    heldRef.current = false
    stopVoicePtt()
  }, [])

  const onHandsfree = useCallback(async () => {
    setPreferXiaomiVoice(true)
    try {
      await toggleContinuousMode({
        onTrayState: (s: string) => {
          liveRef.current.tray = isContinuousModeActive() ? s : ''
          derive()
        },
      })
      setHandsfree(isContinuousModeActive())
    } catch (e) {
      setHandsfree(isContinuousModeActive())
      toast(String((e as Error)?.message || e || '开启免提失败'), 'warning')
    }
  }, [derive])

  /* 历史/新对话：直接走 assistant-session，与小V文字标签同源 */
  const onToggleHistory = useCallback(() => {
    const next = !histOpen
    setHistOpen(next)
    if (next) {
      void import('../../../components/global-assistant/assistant-session.js').then((m) => {
        void m.refreshXiaomiSessionList().catch(() => {})
      })
    }
  }, [histOpen])

  const onNewChat = useCallback(() => {
    void import('../../../components/global-assistant/assistant-session.js')
      .then((m) => m.startXiaomiNewChat())
      .then(() => {
        setHistOpen(false)
        toast('已新开对话', 'success')
      })
      .catch((e) => {
        toast(String((e as Error)?.message || e || '新开对话失败'), 'error')
      })
  }, [])

  const onSelectSession = useCallback((key: string) => {
    void import('../../../components/global-assistant/assistant-session.js')
      .then((m) => m.switchXiaomiSession(key))
      .then(() => {
        setHistOpen(false)
        toast('已切换会话', 'success')
      })
      .catch((e) => {
        toast(String((e as Error)?.message || e || '切换失败'), 'error')
      })
  }, [])

  const openTab = useCallback((url: string) => {
    if (!isXwVoiceMode()) enterXwVoiceMode()
    showRightStageBrowserUrl(url)
  }, [])

  /* Tauri 无边框窗口：语音域顶栏接管拖拽/双击最大化（原聊天 header 已隐藏） */
  const onTopbarDoubleClick = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('[data-tauri-no-drag],button')) return
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => void getCurrentWindow().toggleMaximize())
  }, [])

  const showUser = sessionActive || parseHold ? transcript : lastUser
  const meta = STATE_TITLE[state]
  const stColor = STATE_COLOR[state]

  if (!visible) return null

  // 整栏 + 顶栏均可拖窗。chromeFloorY 已忽略 height>120，不会挤扁右侧浏览器。
  return (
    <div
      className={`xws-root xws-${state} xw-voice-host`}
      style={{ '--xws-state': stColor } as CSSProperties}
      data-tauri-drag-region=""
      onDoubleClick={onTopbarDoubleClick}
    >
      {/* 顶栏显式 drag-region：空白/间隙拖窗；控件单独 no-drag */}
      <div
        className="xws-topbar"
        data-tauri-drag-region=""
        title="拖动窗口 · 双击最大化"
      >
        <div className="xws-modeswitch" role="group" aria-label="形态切换" data-tauri-no-drag="">
          <button type="button" className="xws-mode-btn" aria-pressed={false} onClick={() => exitXwVoiceMode()}>
            文字
          </button>
          <button type="button" className="xws-mode-btn is-active" aria-pressed={true}>
            语音
          </button>
        </div>
        <div
          className={`xws-topbar-actions xws-chrome-hover${histOpen ? ' is-menu-open' : ''}`}
          data-tauri-no-drag=""
        >
          <div className={`xws-hist${histOpen ? ' is-open' : ''}`}>
            <button
              type="button"
              className="xws-topbtn"
              onClick={() => onToggleHistory()}
              title="历史对话"
              aria-expanded={histOpen}
              aria-label="历史对话"
            >
              ⏱
            </button>
            {histOpen ? (
              <div className="xws-hist-menu" role="menu">
                <div className="xws-hist-head">历史对话</div>
                {histLoading ? (
                  <div className="xws-hist-empty">加载中…</div>
                ) : sessions.length ? (
                  sessions.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      role="menuitem"
                      className={`xws-hist-item${s.key === sessionKey ? ' is-active' : ''}`}
                      onClick={() => onSelectSession(s.key)}
                    >
                      <span className="xws-hist-title">{s.title || '未命名'}</span>
                      {s.messageCount ? <span className="xws-hist-meta">{s.messageCount} 条</span> : null}
                    </button>
                  ))
                ) : (
                  <div className="xws-hist-empty">暂无历史对话</div>
                )}
              </div>
            ) : null}
          </div>
          <button type="button" className="xws-topbtn" onClick={() => onNewChat()} title="新开对话" aria-label="新开对话">
            ＋
          </button>
        </div>
      </div>

      <div className="xws-stage">
        <canvas ref={canvasRef} className="xws-canvas" aria-hidden="true" />
        <div className="xws-statepill">
          <span className="xws-state-word">{meta.en}</span>
          <span className="xws-state-timer">{elapsed}</span>
        </div>
        <div className="xws-openhint xws-chrome-hover" data-tauri-no-drag="">
          <span className="xws-openhint-title">内容区在右侧标签页打开</span>
          <span className="xws-openhint-actions">
            <button type="button" className="xws-content-chip" onClick={() => openTab('https://www.bilibili.com')}>
              打开 bilibili
            </button>
            <button type="button" className="xws-content-chip" onClick={() => openTab('https://github.com/trending')}>
              GitHub Trending
            </button>
          </span>
        </div>
      </div>
      <div className="xws-caption">
        <div className="xws-caption-title" style={{ color: stColor } as CSSProperties}>
          {meta.title}
        </div>
        <div className="xws-caption-row">
          <canvas ref={waveRef} className="xws-wave" aria-hidden="true" />
          <span className="xws-caption-sub">{meta.sub}</span>
        </div>
      </div>
      <div className="xws-msgs" aria-live="polite" data-tauri-no-drag="">
        {showUser ? (
          <div className="xws-msg u">
            <span className="xws-msg-role">你</span>
            <span className="xws-msg-text">{showUser}</span>
          </div>
        ) : null}
        {reply ? (
          <div className="xws-msg a">
            <span className="xws-msg-role">小V</span>
            <span className="xws-msg-text">{reply}</span>
          </div>
        ) : null}
        {!showUser && !reply ? <div className="xws-msg-empty">对话内容将在这里出现</div> : null}
      </div>
      <footer className="xws-deck" data-tauri-no-drag="">
        <button
          type="button"
          className={`xws-sidebtn xws-chrome-hover${handsfree ? ' is-on' : ''}`}
          aria-pressed={handsfree}
          aria-label="免提连续对话"
          title="免提连续对话"
          onClick={() => void onHandsfree()}
        >
          ∞
        </button>
        <button
          type="button"
          className="xws-ptt"
          aria-label={state === 'speak' ? '按住说话（当前播报中按下即打断）' : '按住说话'}
          onPointerDown={onPttDown}
          onPointerUp={onPttUp}
          onPointerCancel={onPttUp}
          onPointerLeave={onPttUp}
        >
          <span className="xws-ptt-ring" aria-hidden="true" />
          {state === 'speak' ? (
            <svg className="xws-ptt-ic" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          ) : (
            <svg className="xws-ptt-ic" viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
              <path
                d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="xws-sidebtn xws-chrome-hover"
          aria-label="停止播报"
          title="停止播报"
          onClick={() => void stopAssistantVoicePlayback()}
        >
          ♪
        </button>
      </footer>
      <div className="xws-hint xws-chrome-hover">
        按住 <b>语音键</b> 说话 · 播报中再次按下即可<b>打断</b>
      </div>
    </div>
  )
}

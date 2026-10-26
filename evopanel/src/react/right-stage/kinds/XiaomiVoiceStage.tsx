/**
 * 小V 语音全屏：干净三块 —— 聆听状态 / 最新用户输入 / AI 回复；
 * 右上角文字区展示最近几轮对话。全屏由 lib/xw-voice-mode.ts 驱动。
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
import { buildActivityItems } from './xiaomi-voice-activity.js'
import './xiaomi-voice-stage.css'

type StageState = 'idle' | 'listen' | 'parse' | 'think' | 'speak'

type ActivityItem = {
  key: string
  kind: 'user' | 'assistant' | 'tool' | 'pulse' | 'tool_more'
  roleLabel: string
  text: string
  toolStatus?: 'running' | 'ok' | 'error'
}

const STATE_LABEL: Record<StageState, string> = {
  idle: '待命',
  listen: '聆听',
  parse: '识别',
  think: '思考',
  speak: '播报',
}

const STATE_COLOR: Record<StageState, string> = {
  idle: '#9fb2c8',
  listen: '#38bdf8',
  parse: '#60a5fa',
  think: '#a78bfa',
  // 播报：靛紫蓝（去掉刺眼绿）
  speak: '#818cf8',
}

const DOT_MAIN = '#eaf4ff'
const DOT_COOL = '#9fd8ff'
const LEVEL_BINS = 32

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
  const [activity, setActivity] = useState<ActivityItem[]>([])
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
  const activityBodyRef = useRef<HTMLDivElement | null>(null)
  const activityStickBottomRef = useRef(true)
  const levelsRef = useRef<number[]>(new Array(LEVEL_BINS).fill(0))
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const recentBodyRef = useRef<HTMLDivElement | null>(null)
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

  /* ASR partial 直推左侧「你」+ 活动轨最下实时跟随 */
  useEffect(() => {
    return subscribeXiaomiVoicePartial((text) => {
      const t = String(text || '')
      setTranscript(t)
      if (t.trim()) setLastUser(t)
      liveRef.current.continuousListen = true
      if (!liveRef.current.tray) liveRef.current.tray = 'recording'
      derive()
      // lastUser 下一帧才进 state；这里直接用 partial 刷轨，避免等 store
      const s = getState()
      const msgs = Array.isArray(s.messages) ? s.messages : []
      let liveReply = ''
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i] as { role?: string; text?: string }
        if (m?.role === 'assistant') {
          liveReply = String(m.text || '').trim()
          break
        }
        if (m?.role === 'user') break
      }
      setActivity(
        buildActivityItems(msgs as Parameters<typeof buildActivityItems>[0], {
          liveUser: t.trim() || undefined,
          liveAssistant: liveReply,
          streaming: !!s.streaming,
          stageState: stateRef.current,
        }) as ActivityItem[],
      )
    })
  }, [derive])

  const refreshActivity = useCallback(() => {
    const s = getState()
    const msgs = Array.isArray(s.messages) ? s.messages : []
    let liveReply = ''
    let liveUser = ''
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i] as { role?: string; text?: string }
      if (!liveReply && m?.role === 'assistant') {
        liveReply = String(m.text || '').trim()
        continue
      }
      if (m?.role === 'user') {
        liveUser = String(m.text || '').trim()
        break
      }
    }
    const draft = String(s.draft || '').trim()
    // 轨内实时跟随：听写 draft / 流式助手句挂在最下，不再 skip 掉
    const focusUser = draft || liveUser || String(lastUser || '').trim()
    setActivity(
      buildActivityItems(msgs as Parameters<typeof buildActivityItems>[0], {
        liveUser: focusUser,
        liveAssistant: liveReply || String(reply || '').trim(),
        streaming: !!s.streaming,
        stageState: stateRef.current,
      }) as ActivityItem[],
    )
  }, [lastUser, reply])

  useEffect(() => {
    const sync = () => {
      const s = getState()
      liveRef.current.streaming = !!s.streaming
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
      refreshActivity()
      derive()
    }
    sync()
    const unsub = subscribe(sync)
    return () => {
      unsub()
    }
  }, [derive, refreshActivity])

  // 舞台状态变化时也刷轨（思考脉冲不依赖 store 推送）
  useEffect(() => {
    refreshActivity()
  }, [state, refreshActivity])

  // 活动轨：最新在最下；默认贴底跟随，用户上滚后暂停，靠近底部再恢复
  useEffect(() => {
    if (!activityStickBottomRef.current) return
    const el = activityBodyRef.current
    if (!el) return
    const stick = () => {
      el.scrollTop = el.scrollHeight
    }
    stick()
    // 等文本换行 / 工具行插入后再贴一次
    const raf = requestAnimationFrame(() => {
      stick()
      requestAnimationFrame(stick)
    })
    return () => cancelAnimationFrame(raf)
  }, [activity])

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

      <aside className="xws-recent" data-tauri-no-drag="" aria-label="活动">
        <div className="xws-recent-head">活动</div>
        <div
          className="xws-recent-body"
          ref={activityBodyRef}
          onScroll={() => {
            const el = activityBodyRef.current
            if (!el) return
            const gap = el.scrollHeight - el.scrollTop - el.clientHeight
            activityStickBottomRef.current = gap < 48
          }}
        >
          {activity.length ? (
            activity.map((item) => (
              <div
                key={item.key}
                className={`xws-recent-line is-${item.kind}${
                  item.toolStatus ? ` is-tool-${item.toolStatus}` : ''
                }`}
              >
                <span className="xws-recent-role">
                  {item.kind === 'tool' || item.kind === 'tool_more' ? (
                    <span
                      className={`xws-tool-dot is-${item.toolStatus || 'ok'}`}
                      aria-hidden="true"
                    />
                  ) : item.kind === 'pulse' ? (
                    <span className="xws-tool-dot is-running" aria-hidden="true" />
                  ) : null}
                  {item.roleLabel}
                </span>
                <span className="xws-recent-text">{item.text}</span>
              </div>
            ))
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

/**
 * 小V 语音全屏：干净三块 —— 聆听状态 / 最新用户输入 / AI 回复；
 * 右上角「对话」区走统一桥 V4SessionPaneBridge（与主聊 / 侧栏员工同一套）。
 * 全屏由 lib/xw-voice-mode.ts 驱动；surface=glass 仅皮肤差异。
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
import { showRightStageBrowserUrl } from '../../../lib/right-stage/open-right-stage-browser.js'
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { notifyLayoutChromeChanged } from '../../../lib/layout-chrome.js'
import {
  isXwVoiceEnterAnimating,
  isXwVoiceMode,
  subscribeXwVoiceMode,
  XW_VOICE_ENTER_ANIM_MS,
} from '../../../lib/xw-voice-mode.js'
import { XiaomiV4Timeline } from '../../components/XiaomiV4Timeline.js'
import { VoicePlaybackDiagnostics } from '../../components/VoicePlaybackDiagnostics.js'
import { XiaoxiStagePet, type PetMode } from '../../components/XiaoxiStagePet.js'
import './xiaomi-voice-stage.css'

/** 舞台只暴露三态：跟流式/播报接口对齐，别再拆「待命/识别/占用」。 */
type StageState = 'listen' | 'think' | 'speak'

/**
 * 右上角对话浮层：
 * - open（默认）：无标题栏，只露最新 2～3 行正文；悬停后再出「对话」头栏 + 完整时间线
 * - hidden：收成「对话」角标（悬停后点隐藏）
 */
type RecentPanelSize = 'open' | 'hidden'

const STATE_LABEL: Record<StageState, string> = {
  listen: '聆听',
  // 勿写成「思考」：会和设置里「关思考」(模型推理) 撞名；本态只是等模型出字。
  think: '处理中',
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
  /** 右上角对话浮层：open=悬停展开；hidden=角标。 */
  const [recentSize, setRecentSize] = useState<RecentPanelSize>('open')
  /**
   * 右侧 right-stage 是否开着。关着时语音域 CSS 会铺满整窗（真正「放大」）；
   * 开着时语音域固定左栏宽。本组件用按钮直接 collapse/expand store，不退出语音模式。
   */
  const [rightStageOpen, setRightStageOpen] = useState(() => rightStageStore.isOpen)
  /** P2 播报台账诊断面板 */
  const [ledgerOpen, setLedgerOpen] = useState(false)

  const liveRef = useRef({
    session: false,
    speaking: false,
    streaming: false,
    tray: '',
    continuousListen: false,
  })
  const stateSinceRef = useRef(0)
  const stateRef = useRef<StageState>('listen')
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

  useEffect(() => {
    let frameStartTimer = 0
    let tries = 0
    const tryStart = () => {
      tries += 1
      // starting 中也要跳过：否则重派发会并行 start → 掐死共享 WS
      void import('../../../lib/xiaomi-voice/pipeline-client.js').then((pipe) => {
        if (!isXwVoiceMode()) return
        if (isXiaomiFramePipelineActive() || pipe.isXiaomiFramePipelineStarting?.()) return
        void toggleXiaomiFramePipeline({
          onTrayState: (s: string) => {
            liveRef.current.tray = isXiaomiFramePipelineActive() ? s : ''
            derive()
          },
        }).then((ok) => {
          if (!ok && tries < 3 && isXwVoiceMode()) window.setTimeout(tryStart, 900)
        })
      })
    }
    const scheduleFrameStart = () => {
      if (frameStartTimer) {
        window.clearTimeout(frameStartTimer)
        frameStartTimer = 0
      }
      setPreferXiaomiVoice(true)
      const kick = () => {
        if (!isXwVoiceMode()) return
        void import('../../../lib/xiaomi-voice/voice-file-log.js')
          .then((m) => m.noteWakeMilestone?.('stage_try_start_frame'))
          .catch(() => {})
        tryStart()
      }
      // 仅弧形展开中 defer；已在语音态重进立即开 Frame
      if (isXwVoiceEnterAnimating()) {
        frameStartTimer = window.setTimeout(kick, XW_VOICE_ENTER_ANIM_MS + 24)
      } else {
        kick()
      }
    }
    // 组件常在 enter 事件之后才挂上：mount 时若已是语音态，主动开 Frame
    if (isXwVoiceMode()) scheduleFrameStart()
    const unsub = subscribeXwVoiceMode((on) => {
      setVisible(on)
      if (on) {
        scheduleFrameStart()
      } else {
        if (frameStartTimer) {
          window.clearTimeout(frameStartTimer)
          frameStartTimer = 0
        }
        liveRef.current.tray = ''
        liveRef.current.continuousListen = false
        liveRef.current.speaking = false
        void import('../../../lib/background-voice.js')
          .then((m) => m.shutdownXiaomiVoiceRuntime?.())
          .catch(() => {
            if (isXiaomiFramePipelineActive()) stopXiaomiFramePipeline()
          })
        setTranscript('')
        setLastUser('')
        setReply('')
        setHasInteracted(false)
        setRecentSize('open')
        setState('listen')
      }
    })
    return () => {
      if (frameStartTimer) window.clearTimeout(frameStartTimer)
      unsub()
    }
  }, [derive])

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
      if (s === 'speaking' || s === 'processing') {
        // 发送进思考 / 开播：中间「你」区空出来，勿继续挂上轮用户句
        setTranscript('')
        setLastUser('')
      }
      if (s === 'recording') {
        liveRef.current.continuousListen = true
        // 播报结束回到聆听：听写草稿应已空（开播时清过）；勿回灌 lastUser
        if (stateRef.current === 'speak' && !liveRef.current.streaming) {
          setTranscript('')
          setLastUser('')
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
      if (v) {
        // 本地真正开播：清掉上一轮用户输入，舞台只留 AI 播报区
        setTranscript('')
        setLastUser('')
      }
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
      // 思考/播报中忽略迟到 partial，避免把已清掉的上一轮用户句又灌回来（叠加）
      const holdCaption =
        liveRef.current.speaking ||
        liveRef.current.tray === 'speaking' ||
        liveRef.current.tray === 'processing' ||
        stateRef.current === 'speak' ||
        stateRef.current === 'think'
      if (holdCaption) {
        if (!t.trim()) {
          setTranscript('')
          setLastUser('')
        }
        return
      }
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
      // 已发送的 user 句：思考期可回填中间「你」区；播报中勿回灌（开播已清，等本轮输出）
      const speakingNow =
        liveRef.current.speaking ||
        liveRef.current.tray === 'speaking' ||
        stateRef.current === 'speak'
      if (liveUser && !speakingNow) setLastUser(liveUser)
      derive()
    }
    sync()
    const unsub = subscribe(sync)
    return () => {
      unsub()
    }
  }, [derive])

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
    // 聆听：只显示当前听写（空=等开口）；勿回退 lastUser，否则上一轮用户句清不掉
    // 思考：暂留已发送句，方便对照「我在等什么」
    // 播报：必须空 —— 上一轮用户输入应已清掉，中间区等本轮 AI 输出
    if (state === 'listen') return transcript
    if (state === 'speak') return ''
    return lastUser
  }, [state, transcript, lastUser])

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
  const stateWord = state === 'listen' && !hasInteracted ? '工作中' : STATE_LABEL[state]
  /* 舞台中心的形象：还没开始对话时小V在敲代码干活；对话三态映射到表情/口型 */
  const petMode: PetMode =
    state === 'listen'
      ? hasInteracted
        ? 'listening'
        : 'coding'
      : state === 'think'
        ? 'thinking'
        : 'answering'
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
        <button
          type="button"
          className={`xws-ledger${ledgerOpen ? ' is-on' : ''}`}
          onClick={() => setLedgerOpen((v) => !v)}
          aria-label="播报台账"
          title="播报台账：按 TRACE 看每句合成/播放状态"
          aria-pressed={ledgerOpen}
        >
          台账
        </button>
      </div>

      <VoicePlaybackDiagnostics open={ledgerOpen} onClose={() => setLedgerOpen(false)} />

      {/*
        右上角「对话」区 = V4 时间线。
        默认矮窗只露最新 2～3 行；悬停/聚焦拉高看全；标题栏可隐藏成角标。
      */}
      {showRecent ? (
        recentSize === 'hidden' ? (
          <button
            type="button"
            className="xws-recent-chip"
            data-tauri-no-drag=""
            onClick={() => setRecentSize('open')}
            aria-label="显示对话"
            title="显示对话"
          >
            对话
          </button>
        ) : (
          <aside
            className="xws-recent xws-recent--timeline"
            data-tauri-no-drag=""
            aria-label="对话"
          >
            <header className="xws-recent-head">
              <span className="xws-recent-title">对话</span>
              <div className="xws-recent-actions">
                <button
                  type="button"
                  className="xws-recent-btn"
                  onClick={() => setRecentSize('hidden')}
                  aria-label="隐藏对话"
                  title="隐藏"
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            </header>
            <div className="xws-recent-body xws-recent-body--timeline">
              {sessionKey ? (
                <XiaomiV4Timeline sessionKey={sessionKey} surface="glass" embedded />
              ) : (
                <div className="xws-recent-empty">对话与工具会出现在这里</div>
              )}
            </div>
          </aside>
        )
      ) : null}

      <div className="xws-stage" onClick={onInterrupt} title={state === 'speak' ? '点击打断' : undefined}>
        <XiaoxiStagePet mode={petMode} />
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

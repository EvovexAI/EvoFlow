/**
 * AI员工聊天室 — 全屏舞台 UI（接 Global Assistant 会议状态）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  ChevronUp,
  Crown,
  LayoutGrid,
  LogOut,
  Mic,
  Mic2,
  MicOff,
  Pencil,
  Send,
  Settings,
  Sparkles,
  Square,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react'
import RoundtablePortrait from './RoundtablePortrait'
import OrbitEffects from './ai-roundtable/OrbitEffects'
import RoundtableAiLogo from './ai-roundtable/RoundtableAiLogo'
import RoundTableSurface from './ai-roundtable/RoundTableSurface'
import SpeakingWaveform from './ai-roundtable/SpeakingWaveform'
import { useRoundtableVoiceInput } from './ai-roundtable/useRoundtableVoiceInput'
import type { AgentAvatarAgent } from '../lib/agent-avatar'
import {
  getMeetingTtsUtterance,
  subscribeMeetingTtsUtterance,
} from '../../lib/meeting-tts.js'
import '../../style/ai-roundtable.css'

export type ParticipantStatus =
  | 'idle'
  | 'waiting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'agree'
  | 'disagree'
  | 'done'
  | 'error'

/** 座位视觉主状态（驱动外圈 / 声波 / 标签） */
export type SeatVisualStatus = 'idle' | 'thinking' | 'listening' | 'speaking'

export type RoomParticipant = {
  agent_code: string
  role_name?: string
}

export type RoomMessage = {
  id?: string
  role: 'user' | 'agent' | 'system'
  agent_code?: string
  role_name?: string
  text?: string
  state?: string
  streaming?: boolean
  error?: boolean
}

export type RoomAgent = AgentAvatarAgent & {
  role_name?: string
  status?: string
  [key: string]: unknown
}

export type AIRoundtableRoomProps = {
  participants: RoomParticipant[]
  agents?: RoomAgent[]
  messages: RoomMessage[]
  topicDraft: string
  currentTopic: string
  activeSpeaker: string
  /** 点名目标（可多选） */
  mentionTargets: string[]
  sending: boolean
  polling: boolean
  creatorMode: boolean
  transcriptCollapsed: boolean
  /** 会议室 TTS 静音（顶栏音量键） */
  ttsMuted?: boolean
  /** 可选：本轮共识（无数据时不展示，不造假） */
  consensus?: string[]
  onTopicChange: (value: string) => void
  onSend: (topic: string) => void
  onMention: (agentCodes: string[], topic: string) => void
  onStop: () => void
  onSelectParticipant: (agentCode: string) => void
  onClearMention: () => void
  onCollapse: () => void
  onClose: () => void
  onToggleCreator: () => void
  onToggleTranscript: () => void
  onToggleTts?: () => void
}

const STATUS_LABEL: Record<ParticipantStatus, string> = {
  idle: '已入席',
  waiting: '等待中',
  listening: '倾听中',
  thinking: '思考中',
  speaking: '正在发言',
  agree: '+1',
  disagree: '不同意',
  done: '已发言',
  error: '异常',
}

const MODE_CHIPS = [
  { id: 'deep', label: '深度分析', prefix: '[深度分析]' },
  { id: 'brain', label: '头脑风暴', prefix: '[头脑风暴]' },
  { id: 'plan', label: '方案制定', prefix: '[方案制定]' },
  { id: 'user', label: '用户视角', prefix: '[用户视角]' },
] as const

const MODE_PREFIX_RE = /^\[[^\]]+\]\s*/

/** 座位略压桌沿外侧：左右拉开、整体略下移填底部空位（底部仍留给主持人） */
function seatLayout(count: number): { x: number; y: number; depth: number }[] {
  const n = Math.max(0, count)
  if (n <= 0) return []
  const cx = 50
  const cy = 53
  // 横向拉宽、纵向略加高，避免左右挤成一团、底下太空
  const rx = 43.5
  const ry = 33
  // 底部开口略收，让两侧座位往下延伸
  const gap = Math.PI / 2.9
  const span = 2 * Math.PI - gap
  const start = Math.PI + gap / 2
  if (n === 1) return [{ x: cx, y: cy - ry, depth: 1 }]
  return Array.from({ length: n }, (_, i) => {
    const a = start + (i / (n - 1)) * span
    const y = Number((cy - ry * Math.cos(a)).toFixed(2))
    const depth = y < 42 ? 1.04 : y > 62 ? 0.95 : 1
    return {
      x: Number((cx + rx * Math.sin(a)).toFixed(2)),
      y,
      depth,
    }
  })
}

/** 右侧列表时间（无服务端字段时用稳定伪时钟，避免每帧跳动） */
function msgClock(m: RoomMessage, idx: number) {
  const seed = String(m.id || `${m.agent_code || m.role}-${idx}`)
  let n = 0
  for (let i = 0; i < seed.length; i++) n = (n * 33 + seed.charCodeAt(i)) >>> 0
  const mins = 36 + (n % 24)
  const h = 20 + Math.floor(mins / 60)
  const mi = mins % 60
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}

function sameAgent(a?: string | null, b?: string | null) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
}

type SeatBubbleState = {
  code: string
  text: string
  /** 消息身份，避免新旧发言串台 */
  token: string
}

function liveAgentMessage(messages: RoomMessage[]): RoomMessage | undefined {
  return messages.find(
    (m) => m.role === 'agent' && (m.state === 'working' || m.streaming),
  )
}

function participantStatus(
  messages: RoomMessage[],
  agentCode: string,
  busy: boolean,
  activeSpeaker = '',
): ParticipantStatus {
  const working = messages.find(
    (m) =>
      m.role === 'agent' &&
      sameAgent(m.agent_code, agentCode) &&
      (m.state === 'working' || m.streaming),
  )
  if (working) {
    if (!String(working.text || '').trim()) return 'thinking'
    return 'speaking'
  }
  if (activeSpeaker && sameAgent(activeSpeaker, agentCode)) return 'speaking'
  const done = messages.find(
    (m) =>
      m.role === 'agent' &&
      sameAgent(m.agent_code, agentCode) &&
      (m.state === 'completed' || m.state === 'failed' || m.state === 'canceled'),
  )
  if (done) {
    if (done.error) return 'error'
    const t = String(done.text || '')
    if (/不同意|反对|质疑|不太认同/.test(t) && !/同意|赞同|支持/.test(t.slice(0, 24))) return 'disagree'
    if (/同意|赞同|支持|认同|\+1/.test(t.slice(0, 48))) return 'agree'
    return 'done'
  }
  if (busy && activeSpeaker && !sameAgent(activeSpeaker, agentCode)) return 'listening'
  if (busy) return 'waiting'
  return 'idle'
}

function seatVisualStatus(status: ParticipantStatus): SeatVisualStatus {
  if (status === 'speaking') return 'speaking'
  if (status === 'thinking') return 'thinking'
  if (status === 'listening' || status === 'waiting') return 'listening'
  return 'idle'
}

function toAvatarAgent(agent: RoomAgent | undefined, code: string, name: string): AgentAvatarAgent {
  return {
    ...(agent || {}),
    agent_code: agent?.agent_code || code,
    agent_name: String(agent?.agent_name || name || code),
    avatar: agent?.avatar,
    avatar_meta: agent?.avatar_meta,
    has_avatar_file: agent?.has_avatar_file,
    avatar_rev: agent?.avatar_rev,
  }
}

export default function AIRoundtableRoom(props: AIRoundtableRoomProps) {
  const {
    participants,
    agents = [],
    messages,
    topicDraft,
    currentTopic,
    activeSpeaker,
    mentionTargets = [],
    sending,
    polling,
    creatorMode,
    transcriptCollapsed,
    consensus,
    onTopicChange,
    onSend,
    onMention,
    onStop,
    onSelectParticipant,
    onClearMention,
    onClose,
    onToggleCreator,
    onToggleTranscript,
    onToggleTts,
    ttsMuted = true,
  } = props

  const [draft, setDraft] = useState(topicDraft)
  const [modeId, setModeId] = useState<string>('')
  const [consoleFocused, setConsoleFocused] = useState(false)
  useEffect(() => {
    setDraft(topicDraft)
    const matched = MODE_CHIPS.find((c) => topicDraft.trimStart().startsWith(c.prefix))
    setModeId(matched?.id || '')
  }, [topicDraft])
  const hasDraft = !!draft.trim()

  const busy = sending || polling
  const collapsed = transcriptCollapsed || creatorMode
  const hadRound = messages.some((m) => m.role === 'user')
  const topicDisplay = (currentTopic || draft || '输入一个话题，开始 AI员工聊天').replace(
    /\s+/g,
    ' ',
  )
  const round = String(Math.max(1, messages.filter((m) => m.role === 'user').length || 0)).padStart(
    2,
    '0',
  )

  const pool = useMemo(() => {
    if (participants.length) return participants
    return agents
      .filter((a) => String(a.status || '') === 'active' && String(a.agent_code || '') !== 'xiaomi')
      .map((a) => ({ agent_code: String(a.agent_code || ''), role_name: a.role_name }))
      .filter((p) => p.agent_code)
  }, [participants, agents])

  const slots = useMemo(() => seatLayout(pool.length), [pool.length])
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const applyModeChip = (chip: (typeof MODE_CHIPS)[number]) => {
    const body = draft.replace(MODE_PREFIX_RE, '').trimStart()
    if (modeId === chip.id) {
      setModeId('')
      setDraft(body)
      onTopicChange(body)
      return
    }
    const next = body ? `${chip.prefix} ${body}` : `${chip.prefix} `
    setModeId(chip.id)
    setDraft(next)
    onTopicChange(next)
    inputRef.current?.focus()
  }

  const focusComposer = () => {
    inputRef.current?.focus()
  }

  useEffect(() => {
    const el = logRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, activeSpeaker])

  /**
   * 座位气泡严格跟 TTS 口播同步：
   * - 开始播报 → 立刻显示该人气泡内容
   * - 播报结束 → 立刻收起（下一位同理）
   * 下一位若已回复可先预取语音，但要等轮到他播报才出气泡。
   */
  const [ttsUtterance, setTtsUtterance] = useState(() => getMeetingTtsUtterance())
  useEffect(() => subscribeMeetingTtsUtterance(setTtsUtterance), [])

  const seatBubble: SeatBubbleState | null = useMemo(() => {
    if (!ttsUtterance?.code || !ttsUtterance?.text) return null
    return {
      code: String(ttsUtterance.code),
      text: String(ttsUtterance.text),
      token: String(ttsUtterance.key || `${ttsUtterance.code}-tts`),
    }
  }, [ttsUtterance])

  // 口播优先：有人在 TTS 说话时，舞台焦点跟播报走（即使下一位已在思考）
  const speakerCode = useMemo(() => {
    if (ttsUtterance?.code) return String(ttsUtterance.code)
    if (activeSpeaker) return activeSpeaker
    return liveAgentMessage(messages)?.agent_code || ''
  }, [ttsUtterance, activeSpeaker, messages])

  const live = busy || !!speakerCode || !!ttsUtterance
  const liveMsg = liveAgentMessage(messages)
  const speakerThinking =
    !ttsUtterance && !!liveMsg && !String(liveMsg.text || '').trim()

  const mentionCodes = useMemo(
    () =>
      (Array.isArray(mentionTargets) ? mentionTargets : [])
        .map((c) => String(c || '').trim())
        .filter(Boolean),
    [mentionTargets],
  )
  const mentionNames = useMemo(
    () =>
      mentionCodes.map(
        (code) => pool.find((p) => sameAgent(p.agent_code, code))?.role_name || code,
      ),
    [mentionCodes, pool],
  )
  const mentionLabel =
    mentionNames.length <= 3
      ? mentionNames.join('、')
      : `${mentionNames.slice(0, 3).join('、')} 等 ${mentionNames.length} 人`
  const hasMention = mentionCodes.length > 0

  const agentMap = useMemo(() => {
    const map = new Map<string, RoomAgent>()
    for (const a of agents) {
      const code = String(a.agent_code || '').trim().toLowerCase()
      if (code) map.set(code, a)
    }
    return map
  }, [agents])

  const lookupAgent = (code?: string | null) => {
    const key = String(code || '').trim().toLowerCase()
    return key ? agentMap.get(key) : undefined
  }

  const hostAgent = lookupAgent('xiaomi')

  const showConsensus = Array.isArray(consensus) && consensus.length > 0

  const rootClass = [
    'ai-rt',
    creatorMode ? 'is-creator' : '',
    collapsed ? 'is-transcript-collapsed' : '',
    speakerCode ? 'has-speaker' : '',
    live ? 'is-live' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const submitTopic = useCallback(
    (raw: string) => {
      const topic = String(raw || '').trim()
      if (!topic || busy) return
      // 立刻清空本地输入；不要等 store 回传，避免发送后还留在框里
      setDraft('')
      setModeId('')
      onTopicChange('')
      if (hasMention) onMention(mentionCodes, topic)
      else onSend(topic)
    },
    [busy, hasMention, mentionCodes, onMention, onSend, onTopicChange],
  )

  const submit = () => submitTopic(draft)

  const onMentionClick = () => {
    if (busy) return
    // 未选人：提示先点座位（以前只 focus，看起来像没反应）
    if (!hasMention) {
      focusComposer()
      void import('../../components/toast.js').then(({ toast }) => {
        toast('请先点击圆桌上的角色（可多选），再输入问题并点名', 'info')
      })
      return
    }
    const topic = draft.trim()
    if (!topic) {
      focusComposer()
      void import('../../components/toast.js').then(({ toast }) => {
        toast(`已点名 ${mentionCodes.length} 人：${mentionLabel}，请输入要问的内容`, 'info')
      })
      return
    }
    // 已选人 + 有内容：直接发起点名发言
    submitTopic(topic)
  }

  const {
    speechEnabled,
    voiceRecording,
    voiceBusy,
    toggleMic,
    micTitle,
  } = useRoundtableVoiceInput({
    busy,
    draft,
    setDraft,
    onTopicChange,
    onVoiceSubmit: submitTopic,
  })

  return (
    <div className={rootClass} role="dialog" aria-modal="true" aria-label="AI员工聊天室">
      <div className="ai-rt__bg" aria-hidden="true">
        <div className="ai-rt__bg-stars" />
      </div>

      <header className="ai-rt__top">
        <div className="ai-rt__brand">
          <RoundtableAiLogo className="ai-rt__brand-mark" size={58} />
          <div>
            <div className="ai-rt__brand-title-row">
              <h1 className="ai-rt__brand-title">AI员工聊天室</h1>
              <span className="ai-rt__pill">
                <span className={`ai-rt__dot${live ? ' ai-rt__dot--live' : ''}`} />
                {pool.length ? `${pool.length} 位 AI 已入席` : '等待入席'}
                {live ? ' · 讨论中' : ''}
              </span>
            </div>
            <div className="ai-rt__brand-sub">
              {busy
                ? '多角色实时讨论进行中'
                : hasMention
                  ? `已点名 ${mentionCodes.length} 人：${mentionLabel} · 可继续点选`
                  : `点击座位可多选点名 · 第 ${round} 轮`}
            </div>
          </div>
        </div>

        <div className="ai-rt__top-controls">
          <div className="ai-rt__pill-group" role="toolbar" aria-label="会议室控制">
            <button
              type="button"
              className={`ai-rt__pill-btn${!ttsMuted ? ' is-active' : ''}`}
              title={ttsMuted ? '开启语音播报' : '静音语音播报'}
              aria-pressed={!ttsMuted}
              onClick={() => onToggleTts?.()}
            >
              {ttsMuted ? (
                <VolumeX size={18} strokeWidth={1.75} />
              ) : (
                <Volume2 size={18} strokeWidth={1.75} />
              )}
            </button>
            <span className="ai-rt__pill-divider" aria-hidden="true" />
            <button
              type="button"
              className={`ai-rt__pill-btn${!collapsed ? ' is-active' : ''}`}
              title={collapsed ? '展开实时讨论' : '折叠实时讨论'}
              disabled={creatorMode}
              aria-pressed={!collapsed}
              onClick={onToggleTranscript}
            >
              <LayoutGrid size={18} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              className={`ai-rt__pill-btn${creatorMode ? ' is-active' : ''}`}
              title={creatorMode ? '退出录屏模式' : '设置 / 录屏模式'}
              aria-pressed={creatorMode}
              onClick={onToggleCreator}
            >
              <Settings size={18} strokeWidth={1.75} />
            </button>
          </div>
          <button
            type="button"
            className="ai-rt__exit-pill"
            title="退出"
            onClick={onClose}
          >
            <LogOut size={17} strokeWidth={1.75} />
            <span>退出</span>
          </button>
        </div>
      </header>

      <main className="ai-rt__main">
        <section className="ai-rt__stage-col">
          <div className="ai-rt__topic">
            <span className="ai-rt__topic-dots ai-rt__topic-dots--left" aria-hidden="true" />
            <span className="ai-rt__topic-dots ai-rt__topic-dots--right" aria-hidden="true" />
            <span className="ai-rt__topic-floor-glow" aria-hidden="true" />
            <svg
              className="ai-rt__topic-arc"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <ellipse
                cx="92"
                cy="50"
                rx="22"
                ry="48"
                fill="none"
                stroke="url(#ai-rt-topic-arc)"
                strokeWidth="1.2"
              />
              <defs>
                <linearGradient id="ai-rt-topic-arc" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#45d7ff" stopOpacity="0.15" />
                  <stop offset="45%" stopColor="#665cff" stopOpacity="0.85" />
                  <stop offset="100%" stopColor="#45d7ff" stopOpacity="0.2" />
                </linearGradient>
              </defs>
            </svg>
            <div className="ai-rt__topic-kicker">
              <span className="ai-rt__topic-kicker-line" />
              当前话题
              <span className="ai-rt__topic-kicker-line" />
            </div>
            <div className="ai-rt__topic-row">
              <div className="ai-rt__topic-text" title={topicDisplay}>
                {topicDisplay}
              </div>
            </div>
            <button
              type="button"
              className="ai-rt__topic-edit"
              title="编辑话题"
              onClick={focusComposer}
            >
              <Pencil size={14} />
            </button>
          </div>

          <div className="ai-rt__stage">
            {/* 底图与座位同一坐标系：侧栏开合时圆桌与人一起动 */}
            <div className="ai-rt__stage-bg" aria-hidden="true" />
            <OrbitEffects />
            <RoundTableSurface round={round} live={live} showCenter />

            {pool.map((p, i) => {
              const status = participantStatus(messages, p.agent_code, busy, speakerCode)
              const visual = seatVisualStatus(status)
              const selected = mentionCodes.some((code) => sameAgent(code, p.agent_code))
              const onFloor = sameAgent(p.agent_code, speakerCode)
              const bubbleMine = !!seatBubble && sameAgent(p.agent_code, seatBubble.code)
              // 口播气泡展示全文（勿再截成几十个字）；过长由 CSS 滚动
              const ownText =
                bubbleMine && seatBubble?.text
                  ? String(seatBubble.text || '')
                      .replace(/\s+/g, ' ')
                      .trim()
                  : ''
              // 后半句青色高亮（对齐参考气泡）
              const highlightAt = ownText
                ? Math.min(
                    Math.max(8, Math.floor(ownText.length * 0.42)),
                    Math.max(0, ownText.length - 4),
                  )
                : -1
              const showBubble = bubbleMine && !!ownText
              const thinking = !onFloor && visual === 'thinking'
              // 有气泡的座位不要 dim，否则边框/字会被压暗看不清
              const dim = !!speakerCode && !onFloor && !showBubble
              const slot = slots[i] || { x: 50, y: 20, depth: 1 }
              // 右半座位：声浪/气泡翻到左侧，避免出屏
              const flipSide = slot.x > 50
              const name = p.role_name || p.agent_code
              const agent = lookupAgent(p.agent_code)
              const statusText = onFloor
                ? speakerThinking
                  ? '思考中'
                  : '正在发言'
                : selected && !thinking
                  ? '已点名'
                  : STATUS_LABEL[status] || STATUS_LABEL.idle
              return (
                <div
                  key={p.agent_code}
                  className={[
                    'ai-rt__node',
                    `is-${onFloor ? 'speaking' : visual}`,
                    onFloor ? 'is-speaking' : '',
                    showBubble ? 'has-bubble' : '',
                    selected ? 'is-selected' : '',
                    dim ? 'is-dimmed' : '',
                    busy ? '' : 'is-clickable',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ left: `${slot.x}%`, top: `${slot.y}%` }}
                  title={busy ? name : `点击多选点名：${name}`}
                  onClick={() => {
                    if (!busy) onSelectParticipant(p.agent_code)
                  }}
                >
                  <div className="ai-rt__node-inner">
                    {!busy ? (
                      <span className="ai-rt__tip">{selected ? '取消点名' : '加入点名'}</span>
                    ) : null}
                    <div className="ai-rt__avatar-unit">
                      <div
                        className={`ai-rt__avatar-wrap is-circle${onFloor ? ' is-ring' : ''}`}
                      >
                        {onFloor ? (
                          <div className="ai-rt__avatar-ring" aria-hidden="true" />
                        ) : (
                          <span className="ai-rt__avatar-glow" aria-hidden="true" />
                        )}
                        <RoundtablePortrait
                          agent={toAvatarAgent(agent, p.agent_code, name)}
                          agentCode={p.agent_code}
                          name={name}
                          size={58}
                          speaking={onFloor}
                          variant="circle"
                        />
                        {onFloor && !showBubble ? (
                          <div
                            className={`ai-rt__node-wave${flipSide ? ' is-left' : ''}`}
                          >
                            {/* 思考中：头像旁声浪律动；有气泡时声浪改到气泡顶栏 */}
                            <SpeakingWaveform variant="node" active />
                          </div>
                        ) : null}
                        {showBubble ? (
                          <div
                            className={`ai-rt__seat-bubble${flipSide ? ' is-left' : ''}`}
                            key={seatBubble?.token || p.agent_code}
                          >
                            <div className="ai-rt__seat-bubble-head">
                              <div className="ai-rt__seat-bubble-who">
                                <Mic2 size={13} strokeWidth={2.25} aria-hidden="true" />
                                <strong>{name}</strong>
                              </div>
                              <div className="ai-rt__seat-bubble-wave">
                                <SpeakingWaveform compact bars={8} active />
                              </div>
                            </div>
                            <div className="ai-rt__seat-bubble-text">
                              {ownText.slice(0, highlightAt)}
                              <span className="speech-highlight">
                                {ownText.slice(highlightAt)}
                              </span>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <div className="ai-rt__role-card">{name}</div>
                      <div
                        className={[
                          'ai-rt__status-pill',
                          onFloor
                            ? speakerThinking
                              ? 'is-thinking'
                              : 'is-speaking'
                            : `is-${visual}`,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {onFloor && !speakerThinking ? (
                          <span className="ai-rt__status-live-dot" aria-hidden="true" />
                        ) : null}
                        {statusText}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}

            <div className="ai-rt__host">
              <div className="ai-rt__host-inner">
                <div className="ai-rt__host-glow" />
                <RoundtablePortrait
                  agent={toAvatarAgent(hostAgent, 'xiaomi', '主持人')}
                  agentCode="xiaomi"
                  name="主持人"
                  size={88}
                  host
                />
                <div className="ai-rt__host-badge">
                  <Crown size={12} strokeWidth={2.25} aria-hidden="true" />
                  <span className="ai-rt__host-you">YOU</span>
                  <span className="ai-rt__host-sep" aria-hidden="true">
                    /
                  </span>
                  <span className="ai-rt__host-role">主持人</span>
                </div>
              </div>
            </div>
          </div>

          <div className="ai-rt__console">
            <div
              className={[
                'ai-rt__console-shell',
                consoleFocused ? 'is-focused' : '',
                hasDraft ? 'has-text' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className="ai-rt__console-row">
                <span className="ai-rt__console-icon" aria-hidden="true">
                  <Sparkles size={20} />
                </span>
                <textarea
                  ref={inputRef}
                  className="ai-rt__input"
                  rows={1}
                  value={draft}
                  placeholder={
                    hasMention
                      ? `向已点名的 ${mentionCodes.length} 位追问…`
                      : `提出一个问题，让 ${pool.length || 9} 位 AI 开始讨论…`
                  }
                  onFocus={() => setConsoleFocused(true)}
                  onBlur={() => setConsoleFocused(false)}
                  onChange={(e) => {
                    const v = e.target.value
                    setDraft(v)
                    onTopicChange(v)
                    const matched = MODE_CHIPS.find((c) => v.trimStart().startsWith(c.prefix))
                    setModeId(matched?.id || '')
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      submit()
                    }
                  }}
                />
                <button
                  type="button"
                  className={[
                    'ai-rt__mic-btn',
                    voiceRecording ? 'is-recording' : '',
                    voiceBusy ? 'is-busy' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  title={micTitle}
                  aria-label="语音输入"
                  aria-pressed={voiceRecording}
                  disabled={busy || voiceBusy || !speechEnabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={toggleMic}
                >
                  {speechEnabled ? (
                    voiceRecording ? <MicOff size={18} strokeWidth={2} /> : <Mic size={18} strokeWidth={2} />
                  ) : (
                    <MicOff size={18} strokeWidth={2} />
                  )}
                </button>
                {busy ? (
                  <button type="button" className="ai-rt__cta is-stop" onClick={onStop}>
                    <Square size={14} />
                    停止讨论
                  </button>
                ) : (
                  <button type="button" className="ai-rt__cta" onClick={submit}>
                    {hasMention
                      ? mentionCodes.length > 1
                        ? `请 ${mentionCodes.length} 人发言`
                        : '请 TA 发言'
                      : hadRound
                        ? '继续追问'
                        : '开始讨论'}
                    <Send size={15} className="ai-rt__cta-arrow" aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="ai-rt__secondary">
                {MODE_CHIPS.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    className={`ai-rt__mode-chip${modeId === chip.id ? ' is-active' : ''}`}
                    disabled={busy}
                    onClick={() => applyModeChip(chip)}
                  >
                    {chip.label}
                  </button>
                ))}
                {hasMention ? (
                  <button
                    type="button"
                    className="ai-rt__chip"
                    onClick={() => {
                      const topic = draft.trim()
                      if (!topic || busy) return
                      setDraft('')
                      setModeId('')
                      onTopicChange('')
                      onSend(topic)
                    }}
                    disabled={busy}
                  >
                    改全员
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`ai-rt__mention-btn${hasMention ? ' is-active' : ''}`}
                  title={
                    hasMention
                      ? draft.trim()
                        ? `请 ${mentionLabel} 依次发言`
                        : `已点名 ${mentionCodes.length} 人，输入问题后点击发起`
                      : '点击座位可多选角色，再输入问题并点名'
                  }
                  disabled={busy}
                  onClick={onMentionClick}
                >
                  <Users size={14} />
                  {hasMention
                    ? draft.trim()
                      ? mentionCodes.length > 1
                        ? `请 ${mentionCodes.length} 人发言`
                        : `请 ${mentionLabel} 发言`
                      : `已点名 ${mentionCodes.length} 人`
                    : '点名发言'}
                  <ChevronRight size={14} />
                </button>
                {hasMention ? (
                  <button
                    type="button"
                    className="ai-rt__chip"
                    title="清空点名"
                    disabled={busy}
                    onClick={onClearMention}
                  >
                    取消点名
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        <aside className="ai-rt__side">
          <div className="ai-rt__side-head">
            <div className="ai-rt__side-title">
              实时讨论
              {live ? (
                <span className="ai-rt__live">
                  <span className="ai-rt__dot ai-rt__dot--live" />
                  Live
                </span>
              ) : (
                <span className="ai-rt__ready">
                  <span className="ai-rt__dot ai-rt__dot--ready" />
                  Ready
                </span>
              )}
            </div>
            <button
              type="button"
              className="ai-rt__side-collapse"
              title="折叠"
              onClick={onToggleTranscript}
            >
              <ChevronUp size={18} />
            </button>
          </div>

          <div className="ai-rt__log" ref={logRef}>
            {!messages.length ? (
              <div className="ai-rt__empty-state">
                <div className="ai-rt__empty-beam" />
                <div className="ai-rt__empty-glow" />
                <div className="ai-rt__empty-orb">
                  <Sparkles size={24} />
                </div>
                <div className="ai-rt__empty-title">等待发言</div>
                <p className="ai-rt__empty-desc">
                  开始讨论后，
                  <br />
                  {pool.length || 9} 位 AI 的观点会实时出现在这里
                </p>
                <button
                  type="button"
                  className="ai-rt__empty-cta"
                  onClick={() => inputRef.current?.focus()}
                >
                  发起第一个话题
                </button>
              </div>
            ) : (
              messages.map((m, idx) => {
                const clock = msgClock(m, idx)
                if (m.role === 'system') {
                  return (
                    <div key={m.id || `sys-${idx}`} className="ai-rt__msg is-sys">
                      {m.text}
                    </div>
                  )
                }
                if (m.role === 'user') {
                  return (
                    <div key={m.id || `user-${idx}`} className="ai-rt__msg is-host">
                      <div className="ai-rt__msg-avatar">
                        <RoundtablePortrait
                          agent={toAvatarAgent(hostAgent, 'xiaomi', '主持人')}
                          agentCode="xiaomi"
                          name="主持人"
                          size={40}
                          host
                        />
                      </div>
                      <div className="ai-rt__msg-main">
                        <div className="ai-rt__msg-meta">
                          <span className="ai-rt__msg-name">主持人</span>
                          <span className="ai-rt__msg-time">{clock}</span>
                        </div>
                        <div className="ai-rt__msg-text">{m.text}</div>
                      </div>
                    </div>
                  )
                }
                const pending = m.state === 'working' || m.streaming
                const speaking =
                  pending && (!speakerCode || sameAgent(m.agent_code, speakerCode))
                const code = m.agent_code || ''
                const name = m.role_name || code
                const agent = lookupAgent(code)
                const avatarSize = speaking ? 44 : 40
                const body = String(m.text || '').trim()
                return (
                  <div
                    key={m.id || `agent-${idx}`}
                    className={[
                      'ai-rt__msg',
                      speaking ? 'is-live' : 'is-done',
                      m.error ? 'is-err' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <div className={`ai-rt__msg-avatar${speaking ? ' is-active' : ''}`}>
                      <RoundtablePortrait
                        agent={toAvatarAgent(agent, code, name)}
                        agentCode={code}
                        name={name}
                        size={avatarSize}
                        speaking={speaking}
                      />
                    </div>
                    <div className="ai-rt__msg-main">
                      <div className="ai-rt__msg-meta">
                        <div className="ai-rt__msg-who">
                          <span className="ai-rt__msg-name">{name}</span>
                          <span className="ai-rt__msg-time">{clock}</span>
                        </div>
                        {speaking ? (
                          <div className="ai-rt__msg-wave" aria-hidden="true">
                            <SpeakingWaveform compact bars={8} active />
                          </div>
                        ) : null}
                      </div>
                      {body || pending ? (
                        <div className="ai-rt__msg-text">
                          {body || (pending ? '…' : '')}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {showConsensus ? (
            <div className="ai-rt__consensus">
              <div className="ai-rt__consensus-head">
                <span className="ai-rt__consensus-check">
                  <Check size={12} strokeWidth={3} />
                </span>
                <span className="ai-rt__consensus-title">本轮共识</span>
                <span className="ai-rt__consensus-count">{consensus!.length} 条</span>
              </div>
              <ul className="ai-rt__consensus-list">
                {consensus!.map((item) => (
                  <li key={item}>
                    <span className="ai-rt__consensus-item-check" aria-hidden="true">
                      <Check size={11} strokeWidth={3} />
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="ai-rt__participants">
            <div className="ai-rt__participants-head">
              <span className="ai-rt__participants-title">参会员工</span>
              <span className="ai-rt__participants-count">{pool.length} 人</span>
            </div>
            <div className="ai-rt__participants-list">
              {pool.map((p) => {
                const code = p.agent_code
                const name = p.role_name || code
                const agent = lookupAgent(code)
                const status = participantStatus(messages, code, busy, speakerCode)
                const isSpeaking = sameAgent(code, speakerCode)
                const isSelected = mentionCodes.some((c) => sameAgent(c, code))
                return (
                  <div
                    key={code}
                    className={[
                      'ai-rt__participant-item',
                      isSpeaking ? 'is-speaking' : '',
                      isSelected ? 'is-selected' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => {
                      if (!busy) onSelectParticipant(code)
                    }}
                  >
                    <div className="ai-rt__participant-avatar">
                      <RoundtablePortrait
                        agent={toAvatarAgent(agent, code, name)}
                        agentCode={code}
                        name={name}
                        size={32}
                        speaking={isSpeaking}
                      />
                      <span className={`ai-rt__participant-status-dot ai-rt__dot--${status}`} />
                    </div>
                    <div className="ai-rt__participant-info">
                      <div className="ai-rt__participant-name">{name}</div>
                      <div className="ai-rt__participant-role">
                        {STATUS_LABEL[status] || '已入席'}
                      </div>
                    </div>
                    {isSelected ? (
                      <div className="ai-rt__participant-check">
                        <Check size={14} strokeWidth={2.5} />
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        </aside>
      </main>
    </div>
  )
}

/**
 * 部门群聊：侧栏时间线 + @ 点名（员工 sticky 全工具会话 / 多轮衔接）+ 定稿落盘 + 嵌套 @ 自动接力。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Loader2, Send, X } from 'lucide-react'
import { api, getGatewayBaseUrl } from '../../lib/tauri-api.js'
import {
  ensureMeReady,
  getCachedMe,
  sessionLabel,
  userAvatarUrl,
} from '../../lib/account-session.js'
import { toast } from '../../components/toast.js'
import {
  deptMemberWorkSessionKey,
  loadLatestDeptMemberReply,
  runDeptMemberWorkTurn,
} from '../lib/dept-member-work-session.js'
import { deptChatSessionKey } from '../lib/dept-chat-session.js'
import {
  isDeptGroupStewardCode,
  resolveDeptGroupWakeTargets,
  withDeptGroupSteward,
} from '../lib/dept-group-steward.js'
import {
  extractMentionGoal,
  findMentionSpans,
  parseMentions,
  stripLeadingMentions,
} from '../lib/dept-group-mentions.js'
import {
  DeptGroupWakeQueue,
  isWakeBusyError,
  type WakeJobSnapshot,
} from '../lib/dept-group-wake-queue.js'
import {
  diffWakeJobTransitions,
  loadDeptGroupAuditTrail,
  persistDeptGroupWakeEvent,
  wakeEventsToJobSnapshots,
} from '../lib/dept-group-audit.js'
import {
  deptGroupWakeChainKey,
  isTrivialGroupNestGoal,
  shouldAutoNestWake,
} from '../lib/dept-group-nest-policy.js'
import {
  mergeWakeJobSnapshots,
  resolveMentionDispatchStatus,
} from '../lib/dept-group-dispatch-status.js'
import {
  clearDeptGroupLiveMap,
  DEPT_GROUP_INSERT_MENTION_EVENT,
  deptMemberLiveLabel,
  getDeptMemberLivePhase,
  setDeptGroupLiveMap,
  type DeptGroupInsertMentionDetail,
  type DeptGroupLiveMap,
} from '../lib/dept-group-live.js'
import {
  finalizeDeptGroupMessage,
  migrateLocalDeptChatIfNeeded,
  upsertDeptGroupMessage,
  workSessionKeyForSpeaker,
  type DeptGroupTimelineMsg,
} from '../lib/dept-group-transcript.js'
import {
  isPersonOnDuty,
  personDutyLabel,
  type HomeCmdDept,
  type HomeCmdPerson,
} from './HomeOrgCommandBoard.js'
import { EmployeeStageAvatar } from './EmployeeStageAvatar.js'
import { DeptAvatar } from './DeptAvatar.js'

export type GroupChatMsg = {
  id: string
  kind: 'user' | 'agent' | 'system'
  agentCode?: string
  agentName?: string
  text: string
  ts: number
  mentions?: string[]
  streaming?: boolean
  /** 由谁在群里 @ 过来的（嵌套接力） */
  fromAgentName?: string
  error?: boolean
  workSessionKey?: string
  wakeJobId?: string
}

type ThreadLine = {
  id: string
  role: string
  text: string
  ts: number
}

const MAX_NEST_DEPTH = 2

function formatClock(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const hh = `${d.getHours()}`.padStart(2, '0')
  const mm = `${d.getMinutes()}`.padStart(2, '0')
  return `${hh}:${mm}`
}

/** 派发过程提示 / 空操作说明：主区不当作消息展示 */
function isNoiseSystemMsg(msg: GroupChatMsg): boolean {
  if (msg.kind !== 'system' || msg.error) return false
  const t = msg.text || ''
  return /正在派发|已记入群记录|用 @成员名/.test(t)
}

/** 与左下角 shell-account 同源：登录用户头像 */
function SelfChatAvatar({
  me,
  gatewayBase,
  name,
}: {
  me: unknown
  gatewayBase: string
  name: string
}) {
  const url = userAvatarUrl(me, gatewayBase)
  if (url) {
    return (
      <span className="dept-im__avatar dept-im__avatar--self" title={name} aria-hidden>
        <img src={url} alt="" />
      </span>
    )
  }
  return (
    <span className="dept-im__avatar dept-im__avatar--self dept-im__avatar--self-icon" title={name} aria-hidden>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75">
        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </span>
  )
}

/**
 * 群聊按微信纯文本显示：去掉工具噪音，并剥掉常见 Markdown 标记
 *（模型偶发仍输出 # / ** / 表格时，界面也不渲染成「文档腔」）。
 */
function formatBodyText(raw: string): string {
  let t = String(raw || '')
  t = t.replace(/\[工具:[^\]]*\][^\n]*/g, '')
  t = t.replace(/^\s*（发言失败）\s*/gm, '')
  t = t.replace(/^\s*⚠️\s*/gm, '')
  // fenced code → 保留内文
  t = t.replace(/```[\w-]*\r?\n?([\s\S]*?)```/g, (_, body: string) => String(body || '').trim())
  t = t.replace(/```+/g, '')
  // 标题 / 引用
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  t = t.replace(/^\s{0,3}>\s?/gm, '')
  // 表格行：去掉管道，压成空格句
  t = t.replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, '')
  t = t.replace(/^\s*\|(.+)\|\s*$/gm, (_, cells: string) =>
    String(cells || '')
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
      .join('  '),
  )
  // 粗体 / 斜体 / 行内代码（保留文字；不用 lookbehind，兼容旧引擎）
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
  t = t.replace(/__([^_]+)__/g, '$1')
  t = t.replace(/\*([^*\n]+)\*/g, '$1')
  t = t.replace(/_([^_\n]+)_/g, '$1')
  t = t.replace(/`([^`]+)`/g, '$1')
  // 链接 [文](url) → 文
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  // 列表符号
  t = t.replace(/^\s*[-*+]\s+/gm, '')
  t = t.replace(/^\s*\d+\.\s+/gm, '')
  // 分隔线
  t = t.replace(/^\s*-{3,}\s*$/gm, '')
  t = t.replace(/^\s*\*{3,}\s*$/gm, '')
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

function extractTextFromMessage(m: any): string {
  if (!m || typeof m !== 'object') return ''
  const direct = String(m.text || m.content_text || m.body || '').trim()
  if (direct) return direct
  const content = m.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (p && typeof p === 'object') return String(p.text || p.content || '')
        return ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  if (content && typeof content === 'object') {
    return String(content.text || content.content || '').trim()
  }
  return ''
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 微信式 @：轻字重 + 小头像夹在 @ 与名字之间，不用重色块。
 * 形如：@〔头像〕技术总监
 */
function renderTextWithMentions(
  text: string,
  members: HomeCmdPerson[],
  className = 'dept-im__mention',
): ReactNode {
  const raw = String(text || '')
  if (!raw) return raw
  const spans = findMentionSpans(raw, members)
  if (!spans.length) return raw
  const nodes: ReactNode[] = []
  let last = 0
  let i = 0
  for (const sp of spans) {
    if (sp.start > last) nodes.push(raw.slice(last, sp.start))
    const person =
      (sp.person && members.find((m) => m.agent_code === sp.person!.agent_code)) || null
    const name = person?.role_name || sp.token.replace(/^@/, '')
    nodes.push(
      <span key={`at-${i++}`} className={className} title={person ? `@${name}` : sp.token}>
        <span className="dept-im__mention-at">@</span>
        {person ? (
          <EmployeeStageAvatar
            agentCode={person.agent_code}
            title={person.role_name}
            size={14}
            className="dept-im__mention-avatar"
          />
        ) : null}
        <span className="dept-im__mention-name">{name}</span>
      </span>,
    )
    last = sp.end
  }
  if (last < raw.length) nodes.push(raw.slice(last))
  return nodes.length ? nodes : raw
}

/** 该 @ 消息之后，时间线上是否已有此人定稿回复（重挂无队列时兜底「已回」） */
function hasLaterAgentReply(
  msgs: GroupChatMsg[],
  sourceMsgId: string | undefined,
  agentCode: string,
): boolean {
  const code = String(agentCode || '').trim()
  const sid = String(sourceMsgId || '').trim()
  if (!code || !sid || !msgs?.length) return false
  const idx = msgs.findIndex((m) => m.id === sid)
  if (idx < 0) return false
  for (let i = idx + 1; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.kind !== 'agent') continue
    if (String(m.agentCode || '').trim() !== code) continue
    if (m.streaming) continue
    const body = String(m.text || '').trim()
    if (!body || /排队|正忙|重试|正在回复|未能回复/.test(body)) continue
    return true
  }
  return false
}

/** 气泡下挂派工条：谁被 @、队列态（排队/回答中/已回） */
function MentionDispatchStrip({
  text,
  members,
  wakeJobs,
  sourceMsgId,
  msgs,
}: {
  text: string
  members: HomeCmdPerson[]
  wakeJobs: WakeJobSnapshot[]
  sourceMsgId?: string
  msgs: GroupChatMsg[]
}) {
  const hits = parseMentions(text, members)
  if (!hits.length) return null
  return (
    <div className="dept-im__dispatch" aria-label="已点名成员">
      {hits.map((h) => {
        const goal = extractMentionGoal(text, h).replace(/\s+/g, ' ').trim()
        const preview = goal.length > 36 ? `${goal.slice(0, 36)}…` : goal
        const resolved = resolveMentionDispatchStatus({
          wakeJobs,
          agentCode: h.agent_code,
          sourceMsgId,
          hasLaterReply: hasLaterAgentReply(msgs, sourceMsgId, h.agent_code),
        })
        const st = resolved.status
        return (
          <span
            key={h.agent_code}
            className={`dept-im__dispatch-chip${st ? ` is-${st}` : resolved.miss ? ' is-miss' : ''}`}
            title={preview || undefined}
          >
            <span className="dept-im__dispatch-arrow" aria-hidden>
              →
            </span>
            <EmployeeStageAvatar agentCode={h.agent_code} title={h.role_name} size={14} />
            <span className="dept-im__dispatch-who">@{h.role_name}</span>
            <span
              className={`dept-im__dispatch-status${resolved.miss ? ' is-miss' : ''}`}
            >
              {resolved.label}
            </span>
            {preview ? <span className="dept-im__dispatch-goal">{preview}</span> : null}
          </span>
        )
      })}
    </div>
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const WEEKDAY_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** 微信居中时间：同日 HH:mm；昨日/近周带星期；更早补月日 */
function formatChatTime(ts: number): string {
  const d = new Date(Number(ts) || Date.now())
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const clock = `${hh}:${mm}`

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayDiff = Math.round((startOfToday - startOfMsg) / 86400000)

  if (dayDiff === 0) return clock
  if (dayDiff === 1) return `昨天 ${clock}`
  if (dayDiff > 1 && dayDiff < 7) return `${WEEKDAY_ZH[d.getDay()]} ${clock}`
  const mo = d.getMonth() + 1
  const day = d.getDate()
  if (d.getFullYear() === now.getFullYear()) return `${mo}月${day}日 ${clock}`
  return `${d.getFullYear()}年${mo}月${day}日 ${clock}`
}

/** 与上条间隔 ≥5 分钟才插居中时间（微信习惯） */
function shouldShowTimeSep(prevTs: number | null | undefined, ts: number): boolean {
  if (prevTs == null || !Number.isFinite(prevTs)) return true
  return Math.abs(Number(ts) - Number(prevTs)) >= 5 * 60 * 1000
}

export type HomeDeptGroupChatProps = {
  dept: HomeCmdDept
  onClose: () => void
  onOpenEmployeePage: (code: string) => void
  /** aside=首页指挥台侧栏；main=V4 主对话区 */
  variant?: 'aside' | 'main'
  /** 主壳 sessionKey（部门群为 dept:{id}:chat），给右栏 employeeProcess 钉作用域 */
  shellSessionKey?: string
}

export function HomeDeptGroupChat({
  dept,
  onClose,
  onOpenEmployeePage,
  variant = 'aside',
  shellSessionKey,
}: HomeDeptGroupChatProps) {
  const members = dept.members
  /** 含小V：@ 选人 / 侧栏芯片；员工表本身没有群管家 */
  const roster = useMemo(
    () => withDeptGroupSteward(members, dept.name),
    [members, dept.name],
  )
  const [msgs, setMsgs] = useState<GroupChatMsg[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionHi, setMentionHi] = useState(0)
  const [threadCode, setThreadCode] = useState<string | null>(null)
  const [threadLines, setThreadLines] = useState<ThreadLine[]>([])
  const [threadLoading, setThreadLoading] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const stickBottomRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mentionListRef = useRef<HTMLUListElement>(null)
  const membersRef = useRef(members)
  const rosterRef = useRef(roster)
  const deptNameRef = useRef(dept.name)
  const msgsRef = useRef<GroupChatMsg[]>([])
  const aliveRef = useRef(true)
  const wakeQueueRef = useRef<DeptGroupWakeQueue | null>(null)
  const bubbleByJobRef = useRef(new Map<string, string>())
  const threadReqRef = useRef(0)
  const [wakeJobs, setWakeJobs] = useState<WakeJobSnapshot[]>([])
  /** 重挂后从审计事件回灌，避免历史 @ 全显示「未入队」 */
  const [auditWakeJobs, setAuditWakeJobs] = useState<WakeJobSnapshot[]>([])
  const stripWakeJobs = useMemo(
    () => mergeWakeJobSnapshots(wakeJobs, auditWakeJobs),
    [wakeJobs, auditWakeJobs],
  )
  /** 成员资料卡：点头像弹身份信息（过程/对话/编辑收进卡内动作） */
  const [profile, setProfile] = useState<{ person: HomeCmdPerson; x: number; y: number } | null>(null)
  /** 与左下角账号芯片同源：displayName / 头像 */
  const [selfMe, setSelfMe] = useState<unknown>(() => getCachedMe())
  const [selfGatewayBase, setSelfGatewayBase] = useState('')
  const selfName = useMemo(() => {
    const label = String(sessionLabel(selfMe) || '').trim()
    if (!label || label === '同步中…' || label === '未加载') return '我'
    return label
  }, [selfMe])

  membersRef.current = members
  rosterRef.current = roster
  deptNameRef.current = dept.name
  msgsRef.current = msgs

  useEffect(() => {
    let cancelled = false
    void ensureMeReady()
      .then((me) => {
        if (!cancelled && me) setSelfMe(me)
      })
      .catch(() => {})
    void getGatewayBaseUrl()
      .then((base) => {
        if (!cancelled) setSelfGatewayBase(String(base || '').trim())
      })
      .catch(() => {})
    const onAccount = (ev: Event) => {
      const detail = (ev as CustomEvent).detail
      if (detail) setSelfMe(detail)
      else setSelfMe(getCachedMe())
    }
    window.addEventListener('evoflow:account-changed', onAccount as EventListener)
    return () => {
      cancelled = true
      window.removeEventListener('evoflow:account-changed', onAccount as EventListener)
    }
  }, [])

  const persistMsg = useCallback(
    (msg: GroupChatMsg, streamState?: 'streaming' | 'final' | 'error') => {
      const state =
        streamState ||
        (msg.error ? 'error' : msg.streaming ? 'streaming' : 'final')
      // 流式中间态只留内存；空占位 / 定稿 / 错误才写库
      if (state === 'streaming' && !msg.text) {
        void upsertDeptGroupMessage(msg as DeptGroupTimelineMsg, {
          deptId: dept.id,
          deptName: dept.name,
          streamState: 'streaming',
        }).catch((err) => {
          console.warn('[dept-group] persist streaming placeholder failed', msg.id, err)
        })
        return
      }
      if (state === 'streaming') {
        // 重挂抢救路径：允许把已有流式正文写穿，避免只剩空占位
        void upsertDeptGroupMessage(msg as DeptGroupTimelineMsg, {
          deptId: dept.id,
          deptName: dept.name,
          streamState: 'streaming',
        }).catch((err) => {
          console.warn('[dept-group] persist streaming body failed', msg.id, err)
        })
        return
      }
      void finalizeDeptGroupMessage(msg as DeptGroupTimelineMsg, {
        deptId: dept.id,
        deptName: dept.name,
      }).catch((err) => {
        console.warn('[dept-group] persist finalize failed', msg.id, err)
      })
    },
    [dept.id, dept.name],
  )
  const persistMsgRef = useRef(persistMsg)
  persistMsgRef.current = persistMsg

  useEffect(() => {
    aliveRef.current = true
    bubbleByJobRef.current = new Map()
    stickBottomRef.current = true
    setWakeJobs([])
    setAuditWakeJobs([])
    setMsgs([])
    setDraft('')
    setThreadCode(null)
    setThreadLines([])
    const deptId = dept.id
    const deptName = dept.name
    let cancelled = false
    void migrateLocalDeptChatIfNeeded({ deptId, deptName })
      .then(async (rows) => {
        if (cancelled || !aliveRef.current) return
        // 空 streaming / 「回复未完成」：从员工 sticky 会话回填；已有正文的 streaming 残骸直接定稿
        const recovered = await Promise.all(
          (rows as GroupChatMsg[]).map(async (m) => {
            if (m.kind !== 'agent') return m
            const text = String(m.text || '').trim()
            const empty = !text || text === '（回复未完成）'
            // 重挂后库里仍标 streaming、但已有完整正文 → 清掉假「回复中」
            if (m.streaming && !empty && !/排队|正忙|重试|正在回复/.test(text)) {
              const next = { ...m, streaming: false, error: false }
              persistMsgRef.current(next)
              return next
            }
            if (!empty || !m.workSessionKey) return m
            if (!(m.streaming || m.error)) return m
            const reply = formatBodyText(await loadLatestDeptMemberReply(m.workSessionKey))
            if (!reply) return m
            const next = { ...m, text: reply, streaming: false, error: false }
            persistMsgRef.current(next)
            return next
          }),
        )
        if (cancelled || !aliveRef.current) return
        // 历史回填不整表覆盖：加载窗口内本地已 append 的气泡（用户消息/流式占位）
        // 保留在尾部，避免被更早发起的 DB 读结果抹掉、后续 delta 全部 no-op
        setMsgs((prev) => {
          if (!prev.length) return recovered
          const localIds = new Set(prev.map((m) => m.id))
          const backfill = recovered.filter((m) => !localIds.has(m.id))
          return [...backfill, ...prev]
        })
      })
      .catch(() => {
        /* keep empty */
      })
    void loadDeptGroupAuditTrail(deptId, { limit: 200, deptName })
      .then((trail) => {
        if (cancelled || !aliveRef.current) return
        setAuditWakeJobs(wakeEventsToJobSnapshots(trail.wakeEvents || []))
      })
      .catch(() => {
        /* 无审计也不挡聊天 */
      })
    return () => {
      cancelled = true
      aliveRef.current = false
      // 叫醒队列由下方 effect 独占 dispose，这里勿再 dispose，
      // 否则 dept.name / 父级重渲染会把进行中的点名打成「已取消」。
    }
    // 只跟部门 id：name 刷新不得清空时间线 / 打断点名
  }, [dept.id])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    // 只有用户本来就在底部附近才跟随新消息；流式期间向上翻历史不被拽回
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      stickBottomRef.current = gap < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = listRef.current
    if (!el || !stickBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [msgs])

  const threadPerson = useMemo(
    () => roster.find((m) => m.agent_code === threadCode) || null,
    [roster, threadCode],
  )

  const mentionCandidates = useMemo(() => {
    const q = mentionFilter.trim().toLowerCase()
    // 无关键字 = 全员（含小V），不必靠打字匹配才能选
    if (!q) return roster
    const filtered = roster.filter(
      (m) =>
        m.role_name.toLowerCase().includes(q) ||
        m.agent_code.toLowerCase().includes(q),
    )
    return filtered.length ? filtered : roster
  }, [roster, mentionFilter])

  useEffect(() => {
    if (!mentionOpen) return
    setMentionHi(0)
  }, [mentionOpen, mentionFilter, mentionCandidates.length])

  useEffect(() => {
    if (!mentionOpen) return
    const root = mentionListRef.current
    if (!root) return
    const el = root.querySelector<HTMLElement>('[data-mention-hi="1"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [mentionOpen, mentionHi])

  const patchMsg = useCallback(
    (id: string, patch: Partial<GroupChatMsg>) => {
      setMsgs((prev) => {
        const next = prev.map((m) => (m.id === id ? { ...m, ...patch } : m))
        const hit = next.find((m) => m.id === id)
        if (hit) {
          const becameFinal =
            (patch.streaming === false || patch.error === true) &&
            (hit.error || !hit.streaming)
          if (becameFinal) persistMsg(hit)
        }
        return next
      })
    },
    [persistMsg],
  )

  const appendMsg = useCallback(
    (msg: GroupChatMsg) => {
      setMsgs((prev) => [...prev, msg])
      persistMsg(msg)
    },
    [persistMsg],
  )

  /** 无实时流时：把完整正文打字机刷进气泡 */
  const streamBodyIntoBubble = useCallback(
    async (bubbleId: string, fullRaw: string) => {
      const full = formatBodyText(fullRaw) || '（无正文）'
      if (!aliveRef.current) return full
      const chunk = Math.max(2, Math.ceil(full.length / 48))
      for (let i = chunk; i < full.length; i += chunk) {
        if (!aliveRef.current) return full
        patchMsg(bubbleId, { text: full.slice(0, i), streaming: true })
        await sleep(28)
      }
      if (!aliveRef.current) return full
      patchMsg(bubbleId, { text: full, streaming: false, error: false })
      return full
    },
    [patchMsg],
  )

  /** 主区：点成员打开 V4 右栏员工过程面板（跟岗会话 = 群 @ sticky key；不是往输入框塞 @） */
  const openEmployeeProcess = useCallback(
    (person: HomeCmdPerson | { agent_code: string; role_name?: string }) => {
      const code = String(person.agent_code || '').trim()
      if (!code) return
      const roleName =
        String((person as HomeCmdPerson).role_name || '').trim() || code
      const ownerSk =
        String(shellSessionKey || '').trim() || deptChatSessionKey(dept.id)
      const employeeSk = deptMemberWorkSessionKey(dept.id, code)
      const liveBusy = getDeptMemberLivePhase(dept.id, code) !== 'idle'
      setThreadCode(code)
      void import('../../lib/right-stage/open-employee-process-stage.js').then((m) => {
        m.openEmployeeProcessInRightStage(
          {
            taskId: `live:${code}`,
            agentCode: code,
            roleName,
            title: roleName,
            busy: liveBusy || !!(person as HomeCmdPerson).busy,
            employeeSessionKey: employeeSk || undefined,
          },
          {
            sessionKey: ownerSk || undefined,
            layout: 'wide',
          },
        )
      })
    },
    [dept.id, shellSessionKey],
  )

  /** 点头像/名字 → 资料卡；roster 里没有的（如流式新面孔）兜底合成一份 */
  const openProfile = useCallback(
    (
      person: HomeCmdPerson | { agent_code: string; role_name?: string; busy?: boolean },
      x: number,
      y: number,
    ) => {
      const code = String(person.agent_code || '').trim()
      if (!code) return
      const known = rosterRef.current.find((m) => m.agent_code === code)
      const p: HomeCmdPerson =
        known || {
          agent_code: code,
          role_name: String(person.role_name || '').trim() || code,
          department: '',
          reports_to: '',
          status: '',
          busy: !!person.busy,
          summary: '',
        }
      setProfile({ person: p, x, y })
    },
    [],
  )

  useEffect(() => {
    if (!profile) return
    const onKey = (e: Event) => {
      if ((e as globalThis.KeyboardEvent).key === 'Escape') setProfile(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [profile])

  const loadThread = useCallback(
    async (code: string) => {
      // 主对话区改走 V4 右栏，不再塞内嵌详情轨
      if (variant === 'main') {
        const person =
          rosterRef.current.find((m) => m.agent_code === code) ||
          membersRef.current.find((m) => m.agent_code === code) || {
            agent_code: code,
            role_name: code,
          }
        openEmployeeProcess(person)
        return
      }
      // 请求序号守卫：连点两人时，慢的旧响应不得覆盖新对话
      const req = ++threadReqRef.current
      setThreadCode(code)
      setThreadLoading(true)
      try {
        const sk = deptMemberWorkSessionKey(dept.id, code)
        const res = sk
          ? await api.chatHistory(sk, 60)
          : await api.proactiveGetMessages(code, { limit: 60 })
        if (req !== threadReqRef.current) return
        const rows = Array.isArray(res?.messages)
          ? res.messages
          : Array.isArray(res)
            ? res
            : []
        const lines: ThreadLine[] = rows
          .map((m: any, i: number) => {
            const text = formatBodyText(extractTextFromMessage(m))
            if (!text) return null
            const role = String(m.role || m.speaker || 'assistant').toLowerCase()
            const tsRaw = m.timestamp || m.created_at || m.ts
            const ts = typeof tsRaw === 'number' ? tsRaw : Date.parse(String(tsRaw || '')) || Date.now()
            return {
              id: String(m.id || m.message_id || `${code}-${i}-${ts}`),
              role,
              text,
              ts,
            }
          })
          .filter(Boolean) as ThreadLine[]
        setThreadLines(lines)
      } catch (e: unknown) {
        if (req !== threadReqRef.current) return
        const msg = String((e as { message?: string })?.message || e || '加载失败')
        setThreadLines([
          {
            id: `err-${Date.now()}`,
            role: 'system',
            text: `无法加载对话：${msg}`,
            ts: Date.now(),
          },
        ])
      } finally {
        if (req === threadReqRef.current) setThreadLoading(false)
      }
    },
    [dept.id, openEmployeeProcess, variant],
  )

  /**
   * 队列执行器：sticky 会话 → 流式气泡 → 嵌套 @ 入队（按人串行，多人并行）。
   */
  const runWakeJob = useCallback(
    async (input: {
      jobId: string
      attempt: number
      agentCode: string
      roleName: string
      goal: string
      depth: number
      fromAgentName?: string
      stewardMode?: boolean
      contextSummary?: string
      sourceMsgId?: string
      signal: { aborted: boolean }
    }) => {
      const person: HomeCmdPerson =
        rosterRef.current.find((m) => m.agent_code === input.agentCode) ||
        membersRef.current.find((m) => m.agent_code === input.agentCode) || {
          agent_code: input.agentCode,
          role_name: input.roleName,
          department: dept.name,
          reports_to: '',
          status: 'active',
          busy: false,
          summary: '',
        }
      const workSessionKey = workSessionKeyForSpeaker(dept.id, person.agent_code)
      let bubbleId = bubbleByJobRef.current.get(input.jobId)
      if (!bubbleId) {
        bubbleId = `agent-${person.agent_code}-${Date.now()}`
        bubbleByJobRef.current.set(input.jobId, bubbleId)
        appendMsg({
          id: bubbleId,
          kind: 'agent',
          agentCode: person.agent_code,
          agentName: person.role_name,
          text: input.attempt > 1 ? '排队后重试…' : '',
          ts: Date.now(),
          streaming: true,
          fromAgentName: input.fromAgentName,
          workSessionKey,
          wakeJobId: input.jobId,
        })
      } else {
        patchMsg(bubbleId, {
          text: input.attempt > 1 ? '正忙，排队重试中…' : '',
          streaming: true,
          error: false,
          workSessionKey,
          wakeJobId: input.jobId,
        })
      }

      try {
        let live = false
        const turn = await runDeptMemberWorkTurn({
          deptId: dept.id,
          deptName: dept.name,
          agentCode: person.agent_code,
          roleName: person.role_name,
          text: input.goal,
          groupContext: input.contextSummary || '',
          fromAgentName: input.fromAgentName,
          stewardMode: !!input.stewardMode,
          roster: input.stewardMode
            ? membersRef.current.map((m) => ({
                agent_code: m.agent_code,
                role_name: m.role_name,
              }))
            : undefined,
          signal: input.signal,
          onDelta: (t) => {
            // 即使 UI 已 aborted，仍把增量写库，避免重挂后只剩空占位
            const body = formatBodyText(t)
            if (!body) return
            live = true
            if (aliveRef.current && !input.signal.aborted) {
              patchMsg(bubbleId!, { text: body, streaming: true, error: false })
            } else {
              persistMsgRef.current(
                {
                  id: bubbleId!,
                  kind: 'agent',
                  agentCode: person.agent_code,
                  agentName: person.role_name,
                  text: body,
                  ts: Date.now(),
                  streaming: true,
                  fromAgentName: input.fromAgentName,
                  workSessionKey,
                  wakeJobId: input.jobId,
                },
                'streaming',
              )
            }
          },
        })
        let reply = formatBodyText(turn.text)
        if (!reply && workSessionKey) {
          reply = formatBodyText(await loadLatestDeptMemberReply(workSessionKey))
        }
        // 组件重挂 / 队列 dispose：有正文就定稿落盘，不要吞成「已取消」
        if (!aliveRef.current || input.signal.aborted) {
          if (reply) {
            persistMsgRef.current({
              id: bubbleId!,
              kind: 'agent',
              agentCode: person.agent_code,
              agentName: person.role_name,
              text: reply,
              ts: Date.now(),
              streaming: false,
              fromAgentName: input.fromAgentName,
              workSessionKey,
              wakeJobId: input.jobId,
            })
            if (aliveRef.current) {
              patchMsg(bubbleId, { text: reply, streaming: false, error: false })
            }
          }
          return {}
        }
        if (!reply) {
          patchMsg(bubbleId, {
            text: '（对方没有返回正文）',
            streaming: false,
            error: true,
          })
          return { error: '空回复' }
        }
        const finalText = live
          ? (patchMsg(bubbleId, { text: reply, streaming: false, error: false }), reply)
          : await streamBodyIntoBubble(bubbleId, reply)

        if (input.depth >= MAX_NEST_DEPTH) return {}
        // 本轮只是打招呼/回一声：即便模型硬 @ 派活，也不自动接力（防总监借报到开单）
        if (input.depth >= 1 && isTrivialGroupNestGoal(input.goal)) return {}
        // 嵌套接力只叫醒部门员工，避免 @小V 自循环
        const nestRoster = membersRef.current.filter(
          (m) => !isDeptGroupStewardCode(m.agent_code),
        )
        const nestedFromAt = parseMentions(finalText, nestRoster).filter(
          (x) => x.agent_code !== person.agent_code && !isDeptGroupStewardCode(x.agent_code),
        )
        const woken = new Set<string>()
        const nested: Array<{ person: HomeCmdPerson; goal: string }> = []
        for (const next of nestedFromAt) {
          const goal =
            extractMentionGoal(finalText, next) ||
            `「${person.role_name}」在群里 @ 了你，请直接在群里回复。`
          // 成员互相「你也打个招呼」不再自动叫醒；管家首轮分流 (depth=0) 仍可 @ 多人
          if (!shouldAutoNestWake({ fromDepth: input.depth, goal })) continue
          woken.add(next.agent_code)
          nested.push({ person: next, goal })
        }
        for (const h of turn.handoffs || []) {
          if (!h.agentCode || h.agentCode === person.agent_code || woken.has(h.agentCode)) {
            continue
          }
          if (isDeptGroupStewardCode(h.agentCode)) continue
          const next = nestRoster.find((m) => m.agent_code === h.agentCode)
          if (!next) continue
          const goal =
            String(h.content || '').trim() ||
            `「${person.role_name}」经任务流转派给你，请在群里接手并回复。`
          if (!shouldAutoNestWake({ fromDepth: input.depth, goal })) continue
          woken.add(h.agentCode)
          nested.push({ person: next, goal })
          if (!new RegExp(`@${escapeReg(next.role_name)}`, 'i').test(finalText)) {
            appendMsg({
              id: `sys-handoff-${next.agent_code}-${Date.now()}`,
              kind: 'system',
              text: `${person.role_name} 已流转给 @${next.role_name}${
                h.content ? `：${h.content.slice(0, 120)}` : ''
              }`,
              ts: Date.now(),
              mentions: [next.agent_code],
            })
          }
        }
        const q = wakeQueueRef.current
        if (!q || !nested.length) return {}
        const ctx = `【${person.role_name}】：${finalText.slice(0, 400)}`
        // 同一轮用户消息下，每人最多叫醒一次（root|->code），防相互 @ 死循环
        // chain 用本轮用户根消息防环；sourceMsgId 用当前气泡——派工条挂在谁说的 @ 上就对谁
        const rootId = String(input.sourceMsgId || bubbleId || '').trim()
        const mentionMsgId = String(bubbleId || rootId).trim()
        // 只入队、不 await：否则父任务会一直 running，名单上「回复中」卡到所有下级说完
        for (const item of nested) {
          void q
            .enqueue({
              agentCode: item.person.agent_code,
              roleName: item.person.role_name,
              goal: item.goal,
              depth: input.depth + 1,
              fromAgentName: person.role_name,
              contextSummary: ctx,
              sourceMsgId: mentionMsgId,
              chainKey: deptGroupWakeChainKey(rootId || bubbleId, item.person.agent_code, {
                fromAgentCode: person.agent_code,
                goal: item.goal,
              }),
            })
            .catch(() => {
              /* 队列/防环失败时下级自己有气泡错误态 */
            })
        }
        return {}
      } catch (e: unknown) {
        if (!aliveRef.current || input.signal.aborted) return {}
        if (isWakeBusyError(e)) {
          patchMsg(bubbleId, {
            text: `「${person.role_name}」正忙，已加入排队…`,
            streaming: true,
            error: false,
          })
          return { busy: true, error: String((e as { message?: string })?.message || e) }
        }
        const msg = String((e as { message?: string })?.message || e || '点名失败')
        patchMsg(bubbleId, {
          text: `未能回复：${msg}`,
          streaming: false,
          error: true,
        })
        toast(`点名失败：${msg}`, 'error')
        return { error: msg }
      }
    },
    [appendMsg, dept.id, dept.name, patchMsg, streamBodyIntoBubble],
  )

  const runWakeJobRef = useRef(runWakeJob)
  runWakeJobRef.current = runWakeJob

  useEffect(() => {
    const wakeSigByJob = new Map<string, string>()
    const q = new DeptGroupWakeQueue({
      run: (input) => runWakeJobRef.current(input),
      onChange: (jobs) => {
        // 审计：queued/running/done/failed 变迁落盘（运维「群聊」页可读）。
        // 必须先于 aliveRef 拦截：dispose 产生的「已取消」终态也落盘，
        // 否则审计页成员永远卡在排队中/回复中。
        const changed = diffWakeJobTransitions(wakeSigByJob, jobs)
        for (const j of changed) {
          void persistDeptGroupWakeEvent({
            deptId: dept.id,
            deptName: deptNameRef.current,
            jobId: j.id,
            agentCode: j.agentCode,
            roleName: j.roleName,
            status: j.status,
            attempts: j.attempts,
            goal: j.goal,
            error: j.error,
            sourceMsgId: j.sourceMsgId,
            ts: j.updatedAt || Date.now(),
          }).catch((err) => {
            console.warn('[dept-group] persist wake event failed', j.id, err)
          })
        }
        if (!aliveRef.current) return
        setWakeJobs(jobs)
        for (const j of jobs) {
          if (j.status !== 'failed') continue
          const bid = bubbleByJobRef.current.get(j.id)
          if (!bid) continue
          setMsgs((prev) => {
            let finalized: GroupChatMsg | null = null
            const next = prev.map((m) => {
              if (m.id !== bid) return m
              if (!m.streaming && m.text && !/排队|正忙|重试/.test(m.text)) return m
              finalized = {
                ...m,
                text: `「${j.roleName}」持续忙碌，稍后再 @。${j.error ? `（${j.error}）` : ''}`,
                streaming: false,
                error: true,
              }
              return finalized
            })
            if (finalized) persistMsgRef.current(finalized)
            return next
          })
        }
      },
    })
    wakeQueueRef.current = q
    return () => {
      q.dispose()
      if (wakeQueueRef.current === q) wakeQueueRef.current = null
    }
    // 只跟部门 id：persistMsg/name 变化不得重建队列，否则进行中点名会被 dispose→「已取消」
  }, [dept.id])

  const enqueueWake = useCallback(
    (opts: {
      person: HomeCmdPerson
      goal: string
      depth: number
      contextSummary?: string
      fromAgentName?: string
      stewardMode?: boolean
      sourceMsgId?: string
      chainKey?: string
    }) => {
      const q = wakeQueueRef.current
      if (!q) return Promise.reject(new Error('叫醒队列未就绪'))
      return q.enqueue({
        agentCode: opts.person.agent_code,
        roleName: opts.person.role_name,
        goal: opts.goal,
        depth: opts.depth,
        contextSummary: opts.contextSummary,
        fromAgentName: opts.fromAgentName,
        stewardMode: opts.stewardMode,
        sourceMsgId: opts.sourceMsgId,
        chainKey: opts.chainKey,
      })
    },
    [],
  )

  const insertMention = useCallback(
    (person: HomeCmdPerson) => {
      const ta = inputRef.current
      const token = `@${person.role_name} `
      if (!ta) {
        setDraft((d) => `${d}${token}`)
        setMentionOpen(false)
        setMentionFilter('')
        return
      }
      const start = ta.selectionStart ?? draft.length
      const before = draft.slice(0, start)
      const after = draft.slice(start)
      const at = before.lastIndexOf('@')
      const next =
        at >= 0 && !/\s/.test(before.slice(at + 1))
          ? `${before.slice(0, at)}${token}${after}`
          : `${before}${token}${after}`
      setDraft(next)
      setMentionOpen(false)
      setMentionFilter('')
      requestAnimationFrame(() => {
        ta.focus()
        const pos = (at >= 0 ? at : start) + token.length
        ta.setSelectionRange(pos, pos)
      })
    },
    [draft],
  )

  /* 摘要名单「@点名」事件 → 插入本区输入框 */
  useEffect(() => {
    const onInsert = (ev: Event) => {
      const detail = (ev as CustomEvent<DeptGroupInsertMentionDetail>).detail
      if (!detail) return
      if (String(detail.deptId || '').trim() !== String(dept.id || '').trim()) return
      const code = String(detail.agentCode || '').trim()
      if (!code) return
      const person =
        rosterRef.current.find((m) => m.agent_code === code) ||
        ({
          agent_code: code,
          role_name: String(detail.roleName || '').trim() || code,
          department: '',
          reports_to: '',
          status: '',
          busy: false,
          summary: '',
        } as HomeCmdPerson)
      insertMention(person)
    }
    window.addEventListener(DEPT_GROUP_INSERT_MENTION_EVENT, onInsert as EventListener)
    return () => {
      window.removeEventListener(DEPT_GROUP_INSERT_MENTION_EVENT, onInsert as EventListener)
    }
  }, [dept.id, insertMention])

  /* 把排队/回复中同步给摘要名单：以气泡 streaming 为准，避免父任务等嵌套时假「回复中」 */
  useEffect(() => {
    const map: DeptGroupLiveMap = {}
    const streamingByJob = new Map<string, boolean>()
    const streamingCodes = new Set<string>()
    for (const m of msgs) {
      if (m.kind !== 'agent') continue
      const code = String(m.agentCode || '').trim()
      if (!code) continue
      if (m.wakeJobId) streamingByJob.set(m.wakeJobId, !!m.streaming)
      if (m.streaming) {
        streamingCodes.add(code)
        map[code] = 'running'
      }
    }
    for (const j of wakeJobs) {
      const code = String(j.agentCode || '').trim()
      if (!code) continue
      if (j.status === 'queued') {
        if (map[code] !== 'running') map[code] = 'queued'
        continue
      }
      if (j.status !== 'running') continue
      // 该 job 气泡已定稿 → 本人不再算回复中（嵌套接力另有自己的 job）
      if (streamingByJob.has(j.id) && streamingByJob.get(j.id) === false) continue
      if (streamingCodes.has(code) || !streamingByJob.has(j.id)) {
        map[code] = 'running'
      }
    }
    setDeptGroupLiveMap(dept.id, map)
  }, [dept.id, wakeJobs, msgs])

  useEffect(() => {
    const id = dept.id
    return () => {
      clearDeptGroupLiveMap(id)
    }
  }, [dept.id])

  const onDraftChange = (value: string) => {
    setDraft(value)
    const ta = inputRef.current
    const caret = ta?.selectionStart ?? value.length
    const before = value.slice(0, caret)
    const m = before.match(/@([^\s@]*)$/)
    if (m) {
      setMentionOpen(true)
      setMentionFilter(m[1] || '')
    } else {
      setMentionOpen(false)
      setMentionFilter('')
    }
  }

  const handleSend = async () => {
    const text = draft.trim()
    if (!text || sending) return
    const mentioned = parseMentions(text, roster)
    const goal = stripLeadingMentions(text, mentioned)
    const { targets, viaSteward } = resolveDeptGroupWakeTargets(mentioned, dept.name)
    const now = Date.now()
    const userMsgId = `user-${now}`
    appendMsg({
      id: userMsgId,
      kind: 'user',
      text,
      ts: now,
      mentions: mentioned.map((m) => m.agent_code),
    })
    setDraft('')
    setMentionOpen(false)
    setSending(true)

    try {
      // 群近期发言作首轮提示；每人 sticky 会话自带多轮 harness 历史
      const recentCtx = msgsRef.current
        .filter((m) => m.kind !== 'system' && !m.streaming && String(m.text || '').trim())
        .slice(-8)
        .map((m) => {
          const who =
            m.kind === 'user' ? '用户' : String(m.agentName || m.agentCode || '成员')
          return `${who}：${String(m.text || '').trim().slice(0, 240)}`
        })
        .join('\n')
      // 未 @ → 小V；@ 多人 → 各人入队（同人串行、异人并行；忙则重试）。
      // 入队即解锁：不 await 整轮回复，否则输入框被锁到所有目标说完（busy 退避可拖几分钟）。
      // 回复进度看时间线气泡与派工条。
      void Promise.all(
        targets.map((person) =>
          enqueueWake({
            person,
            goal: viaSteward
              ? text
              : extractMentionGoal(text, person) || goal || text,
            contextSummary: recentCtx,
            depth: 0,
            stewardMode: viaSteward,
            sourceMsgId: userMsgId,
            // 首轮也占坑：后面成员再 @ 同一人会被 nestSeen 丢掉
            chainKey: deptGroupWakeChainKey(userMsgId, person.agent_code),
          }).catch((e: unknown) => {
            const msg = String((e as { message?: string })?.message || e || '失败')
            appendMsg({
              id: `sys-err-${Date.now()}-${person.agent_code}`,
              kind: 'system',
              text: `点名 @${person.role_name} 失败：${msg}`,
              ts: Date.now(),
              error: true,
            })
            toast(`点名失败：${msg}`, 'error')
          }),
        ),
      ).catch(() => {
        /* 各目标已自行提示 */
      })
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文 IME 组合中：Enter 是选词/上屏确认，不是发送；候选导航同样不触发
    if (e.nativeEvent.isComposing || (e.nativeEvent as { keyCode?: number }).keyCode === 229) return
    if (mentionOpen && mentionCandidates.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setMentionHi((i) => (i + 1) % mentionCandidates.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setMentionHi((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        const pick = mentionCandidates[mentionHi] || mentionCandidates[0]
        if (pick) insertMention(pick)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        const pick = mentionCandidates[mentionHi] || mentionCandidates[0]
        if (pick) insertMention(pick)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setMentionOpen(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
      return
    }
  }

  const onClickMsg = (msg: GroupChatMsg) => {
    const code = msg.agentCode || (msg.mentions && msg.mentions[0]) || ''
    if (!code) return
    void loadThread(code)
  }

  const isMain = variant === 'main'

  /* 主区：随内容增高，不低于 V4 壳起步高度 */
  useEffect(() => {
    if (!isMain) return
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, 56)}px`
  }, [draft, isMain])

  return (
    <div
      className={`evo-home-cmd__gc-wrap${!isMain && threadPerson ? ' has-thread' : ''}${
        isMain ? ' evo-home-cmd__gc-wrap--main' : ''
      }`}
    >
      <div
        className={
          isMain
            ? 'dept-im'
            : `evo-home-cmd__detail evo-home-cmd__detail--${dept.accent} evo-home-cmd__gc`
        }
        aria-label={`${dept.name} 群聊`}
      >
        {isMain ? (
          <header className="dept-im__head dept-im__head--dept">
            <DeptAvatar avatar={dept.avatar} name={dept.name} size={36} title={dept.name} />
            <div className="dept-im__titles">
              <div className="dept-im__title-row">
                <h3 className="dept-im__title">{dept.name}</h3>
                {roster.length ? (
                  <span className="evo-home-cmd__gc-badge">{roster.length} 人</span>
                ) : null}
              </div>
              <p className="dept-im__sub">
                {dept.head_role_name ? `负责人 ${dept.head_role_name}` : '部门群聊'}
              </p>
            </div>
          </header>
        ) : (
          <>
            <header className="evo-home-cmd__detail-head">
              <div className="evo-home-cmd__detail-titles">
                <div className="evo-home-cmd__detail-title-row">
                  <DeptAvatar
                    avatar={dept.avatar}
                    name={dept.name}
                    size={36}
                    title={dept.name}
                    className="evo-home-cmd__detail-dept-avatar"
                  />
                  <h3 className="evo-home-cmd__detail-title">
                    {dept.name}
                    {roster.length ? (
                      <span className="evo-home-cmd__gc-badge">{roster.length} 人</span>
                    ) : null}
                  </h3>
                </div>
              </div>
              <button type="button" className="evo-home-cmd__detail-close" aria-label="关闭" onClick={onClose}>
                <X className="evo-home-ic" />
              </button>
            </header>
            <div className="evo-home-cmd__gc-members" aria-label="成员">
              {roster.map((m) => {
                const steward = isDeptGroupStewardCode(m.agent_code)
                const onDuty = steward ? true : isPersonOnDuty(m)
                return (
                  <button
                    key={m.agent_code}
                    type="button"
                    className={`evo-home-cmd__gc-chip${threadCode === m.agent_code ? ' is-active' : ''}${
                      m.busy ? ' is-busy' : ''
                    }${onDuty ? ' is-on-duty' : ' is-off-duty'}${steward ? ' is-steward' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      // 双击开线程时 DOM 会先派发两次 click，第二跳不再插 @
                      if (e.detail >= 2) return
                      insertMention(m)
                    }}
                    onDoubleClick={() => void loadThread(m.agent_code)}
                    title={`${m.role_name} · ${steward ? '群管家' : personDutyLabel(m)}`}
                  >
                    <span
                      className="evo-home-cmd__gc-chip-avatar"
                      title={`${m.role_name} · 资料`}
                      onClick={(e) => {
                        e.stopPropagation()
                        openProfile(m, e.clientX, e.clientY)
                      }}
                    >
                      <EmployeeStageAvatar
                        agentCode={m.agent_code}
                        title={m.role_name}
                        size={22}
                        busy={!!m.busy}
                      />
                    </span>
                    <span className="evo-home-cmd__gc-chip-name">{m.role_name}</span>
                    <span className="evo-home-cmd__gc-chip-state">
                      {steward ? '群管家' : personDutyLabel(m)}
                    </span>
                  </button>
                )
              })}
              {!roster.length ? <span className="evo-home-cmd__gc-empty-hint">暂无成员</span> : null}
            </div>
          </>
        )}

        {isMain && wakeJobs.some((j) => j.status === 'queued' || j.status === 'running') ? (
          <div className="dept-im__wake-rail" aria-label="本轮待回复">
            <span className="dept-im__wake-rail-label">本轮待回复</span>
            {wakeJobs
              .filter((j) => j.status === 'queued' || j.status === 'running')
              .map((j) => (
                <button
                  key={j.id}
                  type="button"
                  className={`dept-im__wake-rail-chip is-${j.status}`}
                  title={j.goal || j.roleName}
                  onClick={() => {
                    if (j.agentCode) {
                      openEmployeeProcess({
                        agent_code: j.agentCode,
                        role_name: j.roleName || j.agentCode,
                      })
                    }
                  }}
                >
                  <EmployeeStageAvatar
                    agentCode={j.agentCode}
                    title={j.roleName}
                    size={16}
                    busy={j.status === 'running'}
                  />
                  <span className="dept-im__wake-rail-who">{j.roleName || j.agentCode}</span>
                  <span className="dept-im__wake-rail-st">
                    {j.status === 'running' ? '回复中' : '排队中'}
                  </span>
                </button>
              ))}
          </div>
        ) : null}

        <div className="evo-home-cmd__gc-timeline" ref={listRef} role="log" aria-live="polite">
          {!msgs.length ? (
            <div className="evo-home-cmd__gc-empty">
              {isMain
                ? `直接说事，小V会回复、帮你解决问题；或 @${dept.head_role_name || members[0]?.role_name || '技术总监'} 点名`
                : `直接说事交给小V，或 @${dept.head_role_name || members[0]?.role_name || '技术总监'} 点名`}
            </div>
          ) : (
            msgs
              .filter((msg) => !(isMain && isNoiseSystemMsg(msg)))
              .flatMap((msg, idx, list) => {
                const who =
                  msg.kind === 'user'
                    ? selfName
                    : msg.kind === 'system'
                      ? '系统'
                      : msg.fromAgentName
                        ? `${msg.agentName || msg.agentCode} ← ${msg.fromAgentName}`
                        : msg.agentName || msg.agentCode || '成员'
                const clickable = !!(msg.agentCode || msg.mentions?.length)
                const prevTs = idx > 0 ? list[idx - 1]?.ts : null
                const timeLabel =
                  isMain && shouldShowTimeSep(prevTs, msg.ts) ? formatChatTime(msg.ts) : ''
                const timeNode = timeLabel ? (
                  <div key={`t-${msg.id}`} className="dept-im__time-sep" role="separator">
                    {timeLabel}
                  </div>
                ) : null

                if (isMain && msg.kind === 'system') {
                  return [
                    timeNode,
                    <div key={msg.id} className="dept-im__sys-sep" role="status">
                      {msg.text}
                    </div>,
                  ].filter(Boolean)
                }

                if (isMain && msg.kind !== 'system') {
                  const agentName = msg.agentName || msg.agentCode || '成员'
                  return [
                    timeNode,
                    <div
                      key={msg.id}
                      className={`dept-im__row dept-im__row--${msg.kind}${msg.streaming ? ' is-streaming' : ''}${
                        msg.error ? ' is-error' : ''
                      }`}
                    >
                      {msg.kind === 'agent' && msg.agentCode ? (
                        <button
                          type="button"
                          className="dept-im__avatar-btn"
                          title={`${agentName} · 资料`}
                          aria-label={`查看 ${agentName} 资料`}
                          onClick={(e) => {
                            e.stopPropagation()
                            openProfile(
                              {
                                agent_code: msg.agentCode!,
                                role_name: agentName,
                                busy: !!msg.streaming,
                              },
                              e.clientX,
                              e.clientY,
                            )
                          }}
                        >
                          <EmployeeStageAvatar
                            agentCode={msg.agentCode}
                            title={agentName}
                            size={36}
                            busy={!!msg.streaming}
                          />
                        </button>
                      ) : null}
                      <div className="dept-im__stack">
                        {/* 微信式：仅成员显示名字；自己气泡不写昵称 */}
                        {msg.kind === 'agent' ? (
                          <div className="dept-im__head-line">
                            {msg.agentCode ? (
                              <span
                                className="dept-im__head-name is-clickable"
                                title={`${agentName} · 资料`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openProfile(
                                    { agent_code: msg.agentCode!, role_name: agentName },
                                    e.clientX,
                                    e.clientY,
                                  )
                                }}
                              >
                                {agentName}
                              </span>
                            ) : (
                              <span className="dept-im__head-name">{agentName}</span>
                            )}
                            {msg.streaming ? (
                              <span className="dept-im__head-state">回复中</span>
                            ) : null}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          className={`dept-im__bubble dept-im__bubble--${msg.kind}${
                            clickable ? ' is-clickable' : ''
                          }`}
                          onClick={() => onClickMsg(msg)}
                          disabled={!clickable}
                          aria-label={
                            msg.kind === 'agent'
                              ? `${who}${msg.streaming ? ' · 回复中' : ''}`
                              : undefined
                          }
                        >
                          <div className="dept-im__bubble-text">
                            {msg.streaming && !msg.text ? (
                              <span className="evo-home-cmd__gc-thinking">正在回复…</span>
                            ) : (
                              renderTextWithMentions(msg.text, roster)
                            )}
                            {msg.streaming && msg.text ? (
                              <span className="evo-home-cmd__gc-caret" aria-hidden />
                            ) : null}
                          </div>
                        </button>
                        {!msg.streaming && msg.text ? (
                          <MentionDispatchStrip
                            text={msg.text}
                            members={roster}
                            wakeJobs={stripWakeJobs}
                            sourceMsgId={msg.id}
                            msgs={msgs}
                          />
                        ) : null}
                      </div>
                      {msg.kind === 'user' ? (
                        <SelfChatAvatar
                          me={selfMe}
                          gatewayBase={selfGatewayBase}
                          name={selfName}
                        />
                      ) : null}
                    </div>,
                  ].filter(Boolean)
                }

                return (
                  <button
                    key={msg.id}
                    type="button"
                    className={`evo-home-cmd__gc-msg evo-home-cmd__gc-msg--${msg.kind}${
                      clickable ? ' is-clickable' : ''
                    }${msg.streaming ? ' is-streaming' : ''}${msg.error ? ' is-error' : ''}`}
                    onClick={() => onClickMsg(msg)}
                    disabled={!clickable}
                  >
                    {msg.kind === 'user' ? null : (
                      <div className="evo-home-cmd__gc-msg-meta">
                        <span className="evo-home-cmd__gc-msg-who">
                          {who}
                          {msg.streaming ? ' · 回复中' : ''}
                        </span>
                      </div>
                    )}
                    <div className="evo-home-cmd__gc-msg-text">
                      {msg.streaming && !msg.text ? (
                        <span className="evo-home-cmd__gc-thinking">正在回复…</span>
                      ) : (
                        renderTextWithMentions(msg.text, roster, 'evo-home-cmd__gc-mention')
                      )}
                      {msg.streaming && msg.text ? (
                        <span className="evo-home-cmd__gc-caret" aria-hidden />
                      ) : null}
                    </div>
                    {!msg.streaming && msg.text ? (
                      <MentionDispatchStrip
                        text={msg.text}
                        members={roster}
                        wakeJobs={stripWakeJobs}
                        sourceMsgId={msg.id}
                        msgs={msgs}
                      />
                    ) : null}
                  </button>
                )
              })
          )}
        </div>

        <div
          className={
            isMain
              ? 'dept-im__composer react-chat-composer'
              : 'evo-home-cmd__gc-composer'
          }
        >
          {mentionOpen && mentionCandidates.length ? (
            <ul
              ref={mentionListRef}
              className="evo-home-cmd__gc-mention-list"
              role="listbox"
              aria-label="选择要 @ 的成员"
            >
              {mentionCandidates.map((m, idx) => (
                <li
                  key={m.agent_code}
                  role="option"
                  aria-selected={idx === mentionHi}
                  data-mention-hi={idx === mentionHi ? '1' : undefined}
                >
                  <button
                    type="button"
                    className={idx === mentionHi ? 'is-hi' : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setMentionHi(idx)}
                    onClick={() => insertMention(m)}
                  >
                    <EmployeeStageAvatar agentCode={m.agent_code} title={m.role_name} size={22} />
                    <span className="evo-home-cmd__gc-mention-name">{m.role_name}</span>
                    <small className="evo-home-cmd__gc-mention-duty">{personDutyLabel(m)}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {isMain ? (
            /* 主区：复用 V4 composer 壳层视觉；发送仍走群聊 @ 叫醒，不接 AG-UI ChatComposer */
            <div className="react-chat-composer-shell">
              <div className="react-chat-input-wrap">
                <textarea
                  ref={inputRef}
                  className="react-chat-input"
                  rows={2}
                  value={draft}
                  placeholder="直接说事，小V会回复；或 @成员点名…"
                  onChange={(e) => onDraftChange(e.target.value)}
                  onKeyDown={onKeyDown}
                  disabled={sending}
                />
              </div>
              <div className="react-chat-composer-toolbar">
                <div className="react-chat-composer-leading">
                  <span className="dept-im__composer-hint">@ 点名成员，各自回复</span>
                </div>
                <div className="react-chat-composer-trailing">
                  <button
                    type="button"
                    className="react-chat-icon-send-btn"
                    onClick={() => void handleSend()}
                    disabled={!draft.trim() || sending}
                    title={sending ? '派发中…' : '发送（Enter）'}
                    aria-label="发送"
                  >
                    {sending ? (
                      <Loader2 className="evo-home-ic evo-home-cmd__gc-spin" />
                    ) : (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        width="18"
                        height="18"
                        aria-hidden="true"
                      >
                        <path d="M12 19V5" />
                        <path d="M5 12l7-7 7 7" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="evo-home-cmd__gc-composer-box">
              <textarea
                ref={inputRef}
                className="evo-home-cmd__gc-input"
                rows={2}
                value={draft}
                placeholder="直接说事交给小V，或 @ 选人…"
                onChange={(e) => onDraftChange(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={sending}
              />
              <button
                type="button"
                className="evo-home-cmd__gc-send"
                onClick={() => void handleSend()}
                disabled={!draft.trim() || sending}
                aria-label="发送"
              >
                {sending ? (
                  <Loader2 className="evo-home-ic evo-home-cmd__gc-spin" />
                ) : (
                  <Send className="evo-home-ic" />
                )}
                发送
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 主区成员名单迁到右上角摘要「群聊」tab，不再占侧轨 */}
      {!isMain && threadPerson ? (
        <aside className="evo-home-cmd__detail evo-home-cmd__gc-thread" aria-label={`${threadPerson.role_name} 对话`}>
          <header className="evo-home-cmd__detail-head">
            <div className="evo-home-cmd__detail-titles">
              <div className="evo-home-cmd__detail-title-row">
                <h3 className="evo-home-cmd__detail-title">{threadPerson.role_name}</h3>
                <span className="evo-home-cmd__detail-online">
                  <span
                    className={`evo-home-cmd__status${isPersonOnDuty(threadPerson) ? ' is-on' : ' is-off'}`}
                  />
                  {personDutyLabel(threadPerson)}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="evo-home-cmd__detail-close"
              aria-label="关闭对话"
              onClick={() => {
                setThreadCode(null)
                setThreadLines([])
              }}
            >
              <X className="evo-home-ic" />
            </button>
          </header>
          <div className="evo-home-cmd__gc-thread-body">
            {threadLoading ? (
              <div className="evo-home-cmd__gc-empty">加载对话中…</div>
            ) : !threadLines.length ? (
              <div className="evo-home-cmd__gc-empty">暂无对话记录。</div>
            ) : (
              threadLines.map((line) => (
                <div
                  key={line.id}
                  className={`evo-home-cmd__gc-thread-line evo-home-cmd__gc-thread-line--${line.role}`}
                >
                  <div className="evo-home-cmd__gc-msg-meta">
                    <span className="evo-home-cmd__gc-msg-who">
                      {line.role === 'user' || line.role === 'human'
                        ? '用户/派工'
                        : line.role === 'system'
                          ? '系统'
                          : threadPerson.role_name}
                    </span>
                    <span className="evo-home-cmd__gc-msg-time">{formatClock(line.ts)}</span>
                  </div>
                  <div className="evo-home-cmd__gc-msg-text">{line.text}</div>
                </div>
              ))
            )}
          </div>
          <button
            type="button"
            className="evo-home-cmd__detail-btn"
            onClick={() => onOpenEmployeePage(threadPerson.agent_code)}
          >
            打开员工页跟进 →
          </button>
        </aside>
      ) : null}

      {/* 成员资料卡：头像/名字点击 → 身份信息；过程、@、编辑收进卡内动作 */}
      {profile ? (
        <div className="dept-im__profile-mask" onMouseDown={() => setProfile(null)}>
          <div
            className="dept-im__profile"
            style={{
              left: Math.max(8, Math.min(profile.x + 8, window.innerWidth - 296)),
              top: Math.max(8, Math.min(profile.y + 8, window.innerHeight - 288)),
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="dept-im__profile-head">
              <EmployeeStageAvatar
                agentCode={profile.person.agent_code}
                title={profile.person.role_name}
                size={44}
                busy={!!profile.person.busy}
              />
              <div className="dept-im__profile-titles">
                <div className="dept-im__profile-name">
                  {profile.person.role_name}
                  {isDeptGroupStewardCode(profile.person.agent_code) ? (
                    <span className="dept-im__profile-badge">群管家</span>
                  ) : null}
                </div>
                <div className="dept-im__profile-state">
                  <span
                    className={`dept-im__profile-dot${
                      profile.person.busy ||
                      getDeptMemberLivePhase(dept.id, profile.person.agent_code) !== 'idle'
                        ? ' is-busy'
                        : ''
                    }`}
                    aria-hidden
                  />
                  {deptMemberLiveLabel(
                    getDeptMemberLivePhase(dept.id, profile.person.agent_code),
                  ) ||
                    (profile.person.busy ? '忙碌' : personDutyLabel(profile.person))}
                  {profile.person.department ? (
                    <span className="dept-im__profile-dept">{profile.person.department}</span>
                  ) : null}
                </div>
              </div>
            </header>
            {profile.person.summary ? (
              <p className="dept-im__profile-summary">{profile.person.summary}</p>
            ) : null}
            <footer className="dept-im__profile-actions">
              <button
                type="button"
                className="dept-im__profile-btn"
                onClick={() => {
                  setProfile(null)
                  openEmployeeProcess(profile.person)
                }}
              >
                {getDeptMemberLivePhase(dept.id, profile.person.agent_code) !== 'idle'
                  ? '查看实时过程'
                  : '实时过程'}
              </button>
              <button
                type="button"
                className="dept-im__profile-btn"
                onClick={() => {
                  setProfile(null)
                  insertMention(profile.person)
                }}
              >
                @点名
              </button>
              <button
                type="button"
                className="dept-im__profile-btn"
                onClick={() => {
                  setProfile(null)
                  onOpenEmployeePage(profile.person.agent_code)
                }}
              >
                查看资料
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  )
}

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
import { api } from '../../lib/tauri-api.js'
import { toast } from '../../components/toast.js'
import {
  deptMemberWorkSessionKey,
  runDeptMemberWorkTurn,
} from '../lib/dept-member-work-session.js'
import { deptChatSessionKey } from '../lib/dept-chat-session.js'
import { resolveDeptGroupWakeTargets } from '../lib/dept-group-steward.js'
import {
  extractMentionGoal,
  findMentionSpans,
  hasUnresolvedAtMentions,
  parseMentions,
  stripLeadingMentions,
} from '../lib/dept-group-mentions.js'
import {
  DeptGroupWakeQueue,
  isWakeBusyError,
  type WakeJobSnapshot,
} from '../lib/dept-group-wake-queue.js'
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

function wakeStatusLabel(status: WakeJobSnapshot['status'] | undefined): string {
  if (status === 'queued') return '排队中'
  if (status === 'running') return '回答中'
  if (status === 'done') return '已回'
  if (status === 'failed') return '失败'
  return ''
}

/** 一条消息里点了 ≥2 人时，气泡下挂轻量派工条（任务摘要 + 叫醒状态） */
function MentionDispatchStrip({
  text,
  members,
  wakeJobs,
  sourceMsgId,
}: {
  text: string
  members: HomeCmdPerson[]
  wakeJobs: WakeJobSnapshot[]
  sourceMsgId?: string
}) {
  const hits = parseMentions(text, members)
  if (hits.length < 2) return null
  return (
    <div className="dept-im__dispatch" aria-label="已点名成员">
      {hits.map((h) => {
        const goal = extractMentionGoal(text, h).replace(/\s+/g, ' ').trim()
        const preview = goal.length > 36 ? `${goal.slice(0, 36)}…` : goal
        const job =
          [...wakeJobs]
            .reverse()
            .find(
              (j) =>
                j.agentCode === h.agent_code &&
                (!sourceMsgId || !j.sourceMsgId || j.sourceMsgId === sourceMsgId),
            ) || null
        const st = job?.status
        const stLabel = wakeStatusLabel(st)
        return (
          <span
            key={h.agent_code}
            className={`dept-im__dispatch-chip${st ? ` is-${st}` : ''}`}
            title={job?.error || undefined}
          >
            <span className="dept-im__dispatch-arrow" aria-hidden>
              →
            </span>
            <EmployeeStageAvatar agentCode={h.agent_code} title={h.role_name} size={14} />
            <span className="dept-im__dispatch-who">@{h.role_name}</span>
            {stLabel ? <span className="dept-im__dispatch-status">{stLabel}</span> : null}
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

/** 微信群气泡旁时间：同日 HH:mm，跨日补月日 */
function formatChatTime(ts: number): string {
  const d = new Date(Number(ts) || Date.now())
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return `${hh}:${mm}`
  const mo = d.getMonth() + 1
  const day = d.getDate()
  return `${mo}/${day} ${hh}:${mm}`
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
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mentionListRef = useRef<HTMLUListElement>(null)
  const membersRef = useRef(members)
  const msgsRef = useRef<GroupChatMsg[]>([])
  const aliveRef = useRef(true)
  const wakeQueueRef = useRef<DeptGroupWakeQueue | null>(null)
  const bubbleByJobRef = useRef(new Map<string, string>())
  const [wakeJobs, setWakeJobs] = useState<WakeJobSnapshot[]>([])

  membersRef.current = members
  msgsRef.current = msgs

  const persistMsg = useCallback(
    (msg: GroupChatMsg, streamState?: 'streaming' | 'final' | 'error') => {
      const state =
        streamState ||
        (msg.error ? 'error' : msg.streaming ? 'streaming' : 'final')
      // 流式中间态只留本地，定稿/错误/首条占位才写库
      if (state === 'streaming' && !msg.text) {
        void upsertDeptGroupMessage(msg as DeptGroupTimelineMsg, {
          deptId: dept.id,
          deptName: dept.name,
          streamState: 'streaming',
        }).catch(() => {})
        return
      }
      if (state === 'streaming') return
      void finalizeDeptGroupMessage(msg as DeptGroupTimelineMsg, {
        deptId: dept.id,
        deptName: dept.name,
      }).catch(() => {})
    },
    [dept.id, dept.name],
  )

  useEffect(() => {
    aliveRef.current = true
    bubbleByJobRef.current = new Map()
    setWakeJobs([])
    setMsgs([])
    setDraft('')
    setThreadCode(null)
    setThreadLines([])
    const deptId = dept.id
    const deptName = dept.name
    void migrateLocalDeptChatIfNeeded({ deptId, deptName })
      .then((rows) => {
        if (!aliveRef.current) return
        setMsgs(rows as GroupChatMsg[])
      })
      .catch(() => {
        /* keep empty */
      })
    return () => {
      aliveRef.current = false
      wakeQueueRef.current?.dispose()
      wakeQueueRef.current = null
    }
  }, [dept.id, dept.name])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [msgs])

  const threadPerson = useMemo(
    () => members.find((m) => m.agent_code === threadCode) || null,
    [members, threadCode],
  )

  const mentionCandidates = useMemo(() => {
    const q = mentionFilter.trim().toLowerCase()
    // 无关键字 = 全员列表，不必靠打字匹配才能选
    if (!q) return members
    const filtered = members.filter(
      (m) =>
        m.role_name.toLowerCase().includes(q) ||
        m.agent_code.toLowerCase().includes(q),
    )
    return filtered.length ? filtered : members
  }, [members, mentionFilter])

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
      setThreadCode(code)
      void import('../../lib/right-stage/open-employee-process-stage.js').then((m) => {
        m.openEmployeeProcessInRightStage(
          {
            taskId: `live:${code}`,
            agentCode: code,
            roleName,
            title: roleName,
            busy: false,
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

  const loadThread = useCallback(
    async (code: string) => {
      // 主对话区改走 V4 右栏，不再塞内嵌详情轨
      if (variant === 'main') {
        const person =
          membersRef.current.find((m) => m.agent_code === code) || {
            agent_code: code,
            role_name: code,
          }
        openEmployeeProcess(person)
        return
      }
      setThreadCode(code)
      setThreadLoading(true)
      try {
        const sk = deptMemberWorkSessionKey(dept.id, code)
        const res = sk
          ? await api.chatHistory(sk, 60)
          : await api.proactiveGetMessages(code, { limit: 60 })
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
        setThreadLoading(false)
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
            if (!aliveRef.current || input.signal.aborted) return
            live = true
            const body = formatBodyText(t)
            if (body) patchMsg(bubbleId!, { text: body, streaming: true, error: false })
          },
        })
        if (!aliveRef.current || input.signal.aborted) return {}
        const reply = formatBodyText(turn.text)
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
        const roster = membersRef.current
        const nestedFromAt = parseMentions(finalText, roster).filter(
          (x) => x.agent_code !== person.agent_code,
        )
        if (!nestedFromAt.length && hasUnresolvedAtMentions(finalText, roster)) {
          appendMsg({
            id: `sys-at-miss-${Date.now()}`,
            kind: 'system',
            text: `${person.role_name} 写了 @，但没对上本群花名册（可能还在用旧称呼）。本群可 @：${roster
              .map((m) => m.role_name)
              .filter(Boolean)
              .slice(0, 8)
              .join('、')}`,
            ts: Date.now(),
          })
        }
        const woken = new Set(nestedFromAt.map((x) => x.agent_code))
        const nested: Array<{ person: HomeCmdPerson; goal: string }> = nestedFromAt.map(
          (next) => ({
            person: next,
            goal:
              extractMentionGoal(finalText, next) ||
              `「${person.role_name}」在群里 @ 了你，请直接在群里回复。`,
          }),
        )
        for (const h of turn.handoffs || []) {
          if (!h.agentCode || h.agentCode === person.agent_code || woken.has(h.agentCode)) {
            continue
          }
          const next = roster.find((m) => m.agent_code === h.agentCode)
          if (!next) continue
          woken.add(h.agentCode)
          nested.push({
            person: next,
            goal:
              String(h.content || '').trim() ||
              `「${person.role_name}」经任务流转派给你，请在群里接手并回复。`,
          })
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
        await Promise.all(
          nested.map((item) =>
            q.enqueue({
              agentCode: item.person.agent_code,
              roleName: item.person.role_name,
              goal: item.goal,
              depth: input.depth + 1,
              fromAgentName: person.role_name,
              contextSummary: ctx,
              sourceMsgId: bubbleId,
              chainKey: `${person.agent_code}->${item.person.agent_code}`,
            }),
          ),
        )
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
    const q = new DeptGroupWakeQueue({
      run: (input) => runWakeJobRef.current(input),
      onChange: (jobs) => {
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
            if (finalized) persistMsg(finalized)
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
  }, [dept.id, persistMsg])

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
    const mentioned = parseMentions(text, members)
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
      // 未 @ → 小V；@ 多人 → 各人入队（同人串行、异人并行；忙则重试）
      await Promise.all(
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
          }),
        ),
      )
    } catch (e: unknown) {
      const msg = String((e as { message?: string })?.message || e || '失败')
      appendMsg({
        id: `sys-err-${Date.now()}`,
        kind: 'system',
        text: `群聊点名失败：${msg}`,
        ts: Date.now(),
        error: true,
      })
      toast(`点名失败：${msg}`, 'error')
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
        {isMain ? null : (
          <>
            <header className="evo-home-cmd__detail-head">
              <div className="evo-home-cmd__detail-titles">
                <div className="evo-home-cmd__detail-title-row">
                  <h3 className="evo-home-cmd__detail-title">
                    {dept.name}
                    {members.length ? (
                      <span className="evo-home-cmd__gc-badge">{members.length} 人</span>
                    ) : null}
                  </h3>
                </div>
              </div>
              <button type="button" className="evo-home-cmd__detail-close" aria-label="关闭" onClick={onClose}>
                <X className="evo-home-ic" />
              </button>
            </header>
            <div className="evo-home-cmd__gc-members" aria-label="成员">
              {members.map((m) => {
                const onDuty = isPersonOnDuty(m)
                return (
                  <button
                    key={m.agent_code}
                    type="button"
                    className={`evo-home-cmd__gc-chip${threadCode === m.agent_code ? ' is-active' : ''}${
                      m.busy ? ' is-busy' : ''
                    }${onDuty ? ' is-on-duty' : ' is-off-duty'}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertMention(m)}
                    onDoubleClick={() => void loadThread(m.agent_code)}
                    title={`${m.role_name} · ${personDutyLabel(m)}`}
                  >
                    <EmployeeStageAvatar
                      agentCode={m.agent_code}
                      title={m.role_name}
                      size={22}
                      busy={!!m.busy}
                    />
                    <span className="evo-home-cmd__gc-chip-name">{m.role_name}</span>
                    <span className="evo-home-cmd__gc-chip-state">{personDutyLabel(m)}</span>
                  </button>
                )
              })}
              {!members.length ? <span className="evo-home-cmd__gc-empty-hint">暂无成员</span> : null}
            </div>
          </>
        )}

        <div className="evo-home-cmd__gc-timeline" ref={listRef} role="log" aria-live="polite">
          {!msgs.length ? (
            <div className="evo-home-cmd__gc-empty">
              {isMain
                ? `直接说事，小V会接住；或 @${dept.head_role_name || members[0]?.role_name || '技术总监'} 点名`
                : `直接说事交给小V，或 @${dept.head_role_name || members[0]?.role_name || '技术总监'} 点名`}
            </div>
          ) : (
            msgs
              .filter((msg) => !(isMain && isNoiseSystemMsg(msg)))
              .map((msg) => {
                const who =
                  msg.kind === 'user'
                    ? '你'
                    : msg.kind === 'system'
                      ? '系统'
                      : msg.fromAgentName
                        ? `${msg.agentName || msg.agentCode} ← ${msg.fromAgentName}`
                        : msg.agentName || msg.agentCode || '成员'
                const clickable = !!(msg.agentCode || msg.mentions?.length)

                if (isMain && msg.kind !== 'system') {
                  const timeLabel = formatChatTime(msg.ts)
                  const agentName = msg.agentName || msg.agentCode || '成员'
                  return (
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
                          title={`查看 ${agentName} 过程`}
                          aria-label={`打开 ${agentName} 的执行过程`}
                          onClick={(e) => {
                            e.stopPropagation()
                            openEmployeeProcess({
                              agent_code: msg.agentCode!,
                              role_name: agentName,
                            })
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
                        {/* 微信式：头像旁先写名字 + 时间，再接气泡 */}
                        <div className="dept-im__head-line">
                          {msg.kind === 'agent' ? (
                            <>
                              <span className="dept-im__head-name">{agentName}</span>
                              {msg.streaming ? (
                                <span className="dept-im__head-state">回复中</span>
                              ) : null}
                              {timeLabel ? (
                                <span className="dept-im__head-time">{timeLabel}</span>
                              ) : null}
                            </>
                          ) : (
                            <>
                              {timeLabel ? (
                                <span className="dept-im__head-time">{timeLabel}</span>
                              ) : null}
                              <span className="dept-im__head-name">你</span>
                            </>
                          )}
                        </div>
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
                              renderTextWithMentions(msg.text, members)
                            )}
                            {msg.streaming && msg.text ? (
                              <span className="evo-home-cmd__gc-caret" aria-hidden />
                            ) : null}
                          </div>
                        </button>
                        {!msg.streaming && msg.text ? (
                          <MentionDispatchStrip
                            text={msg.text}
                            members={members}
                            wakeJobs={wakeJobs}
                            sourceMsgId={msg.id}
                          />
                        ) : null}
                      </div>
                      {msg.kind === 'user' ? (
                        <span className="dept-im__avatar dept-im__avatar--you" aria-hidden>
                          你
                        </span>
                      ) : null}
                    </div>
                  )
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
                        renderTextWithMentions(msg.text, members, 'evo-home-cmd__gc-mention')
                      )}
                      {msg.streaming && msg.text ? (
                        <span className="evo-home-cmd__gc-caret" aria-hidden />
                      ) : null}
                    </div>
                    {!msg.streaming && msg.text ? (
                      <MentionDispatchStrip
                        text={msg.text}
                        members={members}
                        wakeJobs={wakeJobs}
                        sourceMsgId={msg.id}
                      />
                    ) : null}
                  </button>
                )
              })
          )}
        </div>

        <div className={isMain ? 'dept-im__composer' : 'evo-home-cmd__gc-composer'}>
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
          <div className={isMain ? 'dept-im__composer-box' : 'evo-home-cmd__gc-composer-box'}>
            <textarea
              ref={inputRef}
              className={isMain ? 'dept-im__composer-input' : 'evo-home-cmd__gc-input'}
              rows={isMain ? 1 : 2}
              value={draft}
              placeholder={
                isMain
                  ? '直接说事，小V会接住；或 @成员点名…'
                  : '直接说事交给小V，或 @ 选人…'
              }
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={sending}
            />
            <button
              type="button"
              className={isMain ? 'dept-im__composer-send' : 'evo-home-cmd__gc-send'}
              onClick={() => void handleSend()}
              disabled={!draft.trim() || sending}
              aria-label="发送"
            >
              {sending ? (
                <Loader2 className="evo-home-ic evo-home-cmd__gc-spin" />
              ) : (
                <Send className="evo-home-ic" />
              )}
              {isMain ? null : '发送'}
            </button>
          </div>
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
    </div>
  )
}

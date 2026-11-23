/**
 * 员工执行过程 / 续聊：对话体走主聊同一套 V4（V4SessionPaneBridge → V4ZCodeTimeline），
 * 底部 sticky dock 挂主聊 ChatComposer（可输入、发送、停止），不强制切主区会话。
 *
 * 进度策略（非流式订阅）：
 * - 执行中 / 尚无 thread：约 3s 拉 meta + 强制 V4 投影刷新
 * - 刚结束：再收一帧后停止高频轮询
 * - 已完成：不再定时刷
 * - 打开后宽限内继续刷，避免首轮误绑旧 done 会话就停死
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type { ChatAttachment } from '../../chat-types.js'
import { ChatComposer } from '../../components/ChatComposer.js'
import { PluginQuickPanel } from '../../components/PluginQuickPanel.js'
import { SkillPickerModal } from '../../components/SkillPickerModal.js'
import { mintEmployeeChatEpisodeId } from '../../components/EmployeeTalkModeBar.js'
import { useComposerSkillPluginSelection } from '../../hooks/useComposerSkillPluginSelection.js'
import {
  isProactiveSessionKey,
  parseProactiveSessionKey,
} from '../../lib/session-list/workspace-groups.js'
import { resolveProactiveProcessMeta } from '../../../lib/proactive-session-messages.js'
import {
  clearEmployeeProcessPendingSend,
  employeeProcessStageTabKey,
  patchEmployeeProcessTabTitle,
  resolveEmployeeProcessTabTitle,
} from '../../../lib/right-stage/open-employee-process-stage.js'
// 【self-evolution-bot · 2026-11-22 · 第127轮 · 模型:deepseek-v4.1-flash】
// 平台排队首条消息的准入判据（忙则 hold、已发/in-flight 则跳、只有 send 才清 tab data）。
import {
  clearPendingSendInflight,
  decidePendingSend,
  markPendingSendInflight,
} from '../../../lib/right-stage/pending-send-gate.js'
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { logRightStagePane } from '../../../lib/right-stage/panel-set-debug-log.js'
import {
  getSharedV4SessionDataLayer,
  refreshEvoflowV4Session,
} from '../../v4/V4StreamRowsBridge.js'
import { V4SessionPaneBridge } from '../../v4/V4SessionPaneBridge.js'
import { resolveSessionBusyFromControl } from '../../v4/control-busy.js'
import { toast } from '../../../components/toast.js'
import { EmployeeStageAvatar } from '../../components/EmployeeStageAvatar.js'
// 【self-evolution-bot · 2026-11-21 · 第111轮 · 模型:deepseek-v4.1-flash-1017】
// 发送会话判据：对话不许用 task 会话（消息会进任务时间线，面板看不到）。
import { resolveSendSessionKeyForChat } from '../../../lib/right-stage/employee-send-session-kind.js'

/** 从 V4 窗口行拼纯文本，供右栏「复制对话」。 */
function plainTextFromV4Window(rows: readonly { kind?: string; text?: string }[] | null | undefined): string {
  if (!rows || rows.length === 0) return ''
  const parts: string[] = []
  for (const row of rows) {
    const kind = String(row?.kind || '')
    const text = String(row?.text || '').trim()
    if (!text) continue
    if (kind === 'userInput') parts.push(`用户：${text}`)
    else if (kind === 'assistantText') parts.push(`助手：${text}`)
    else if (kind === 'reasoning') parts.push(`思考：${text}`)
  }
  return parts.join('\n\n')
}

/** 执行中：跟进度 */
const POLL_ACTIVE_MS = 3000
/**
 * 【self-evolution-bot · 2026-11-21 · 第108轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：给 refreshEvoflowV4Session 显式传 softIntervalMs，与 POLL_ACTIVE_MS 同频。
 * 为什么（用户 2026-11-21 点破）：员工对话面板正文走 V4 catchup 快照，而本文件两处
 *   `refreshEvoflowV4Session(tid)` 都没传 softIntervalMs → 吃默认 CATCHUP_READY_SOFT_MS
 *   = 20_000ms，即「已有投影时 20 秒才 soft reconcile 一次」。所以员工在后台回话时，
 *   面板正文最长要等 20 秒才刷出来，而人手打消息走的是 live SSE 逐字流，是实时的。
 *   这就是用户说的「直接后台触发的没实时显示」。
 * 判据：同仓兄弟面板 v4-collab-subtask-transcript-pane.tsx:126 早就是
 *   `{ softIntervalMs: V4_SOFT_MS }`（=2000ms）；本面板漏了同一个参数。
 * 注意：只影响「已有投影时的软对账」频率，首屏 catchup 与 live 帧不受影响。
 */
const V4_CATCHUP_SOFT_MS = POLL_ACTIVE_MS
/** 刚结束：收尾再确认一次的延迟 */
const SETTLE_DELAY_MS = 2500
/**
 * 派发/唤醒常先开右栏、会话行稍后才入库。若首轮 meta 误绑旧「done」会话会立刻停刷。
 * 打开后宽限内即使看起来已结束也继续轮询，好换到真正在跑的 thread。
 */
const OPEN_GRACE_MS = 45_000

const RUNNING = new Set(['running', 'busy', 'active', 'in_progress', 'queued', 'pending'])


function looksLikeAgentCodeLabel(name: string, agentCode: string): boolean {
  const n = String(name || '').trim()
  const c = String(agentCode || '').trim()
  if (!n) return true
  if (c && n.toLowerCase() === c.toLowerCase()) return true
  if (n === '执行过程' || n === '查看进度' || n === '进度') return true
  return false
}

/** 仅本岗 proactive key；主聊 agent:main:* 等不能当员工会话去订 V4。 */
function employeeOwnedSessionKey(sessionKey: string, agentCode: string): string {
  const sk = String(sessionKey || '').trim()
  const code = String(agentCode || '').trim()
  if (!sk || !code || !isProactiveSessionKey(sk)) return ''
  const parsed = parseProactiveSessionKey(sk)
  return String(parsed.agentCode || '').trim() === code ? sk : ''
}

/** 后端 run_status 原值 → 徽标文案（未收录的回退原样显示） */
const STATUS_LABEL: Record<string, string> = {
  done: '已完成',
  completed: '已完成',
  success: '已完成',
  failed: '失败',
  error: '失败',
  cancelled: '已取消',
  canceled: '已取消',
  timeout: '超时',
  timed_out: '超时',
  running: '执行中',
  busy: '执行中',
  active: '执行中',
  in_progress: '执行中',
  queued: '排队中',
  pending: '等待中',
  // 后端空闲态常回 idle；对用户显示「可对话」，别甩英文原词
  idle: '可对话',
  ready: '可对话',
  none: '可对话',
}

export type V4EmployeeProcessPaneProps = {
  agentCode: string
  roleName?: string
  title?: string
  taskId?: string
  roundId?: string
  /**
   * 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
   * 本次派发时刻。roundId 在派单路径恒为空，故用它判「是否换了新一轮」。
   */
  roundStamp?: string
  busy?: boolean
  /** 归属主会话（文件预览 tab 挂靠）；缺省用员工 session_key */
  sessionKey?: string
  /** 平台 chat_send / openStage 传入的员工对话 key，优先于 meta 解析 */
  employeeSessionKeyHint?: string
  /** 平台 chat_send 排队的首条消息；挂载后走输入框同款 handleSend */
  pendingSendMessage?: string
  onClose?: () => void
}

async function ensureChatThread(sessionKey: string): Promise<string> {
  const sk = String(sessionKey || '').trim()
  if (!sk) return ''
  try {
    const { wsClient } = await import('../../../lib/ws-client.js')
    if (typeof wsClient.resolveSessionThreadId === 'function') {
      return String((await wsClient.resolveSessionThreadId(sk)) || '').trim()
    }
    if (typeof wsClient.ensureChatThread === 'function') {
      const r = await wsClient.ensureChatThread(sk)
      return String(
        r?.thread_id || r?.threadId || wsClient.getSessionThreadId?.(sk) || '',
      ).trim()
    }
  } catch {
    /* optional */
  }
  return ''
}

async function patchProactiveChatContext(sessionKey: string): Promise<void> {
  if (!isProactiveSessionKey(sessionKey)) return
  const parsed = parseProactiveSessionKey(sessionKey)
  try {
    const { api } = await import('../../../lib/tauri-api.js')
    const patch: Record<string, unknown> = {
      source: 'proactive',
      proactive_agent_code: parsed.agentCode || null,
      employee_talk_mode: 'chat',
    }
    if (parsed.kind === 'task' && parsed.taskId) {
      patch.workspace_kind = 'task'
      patch.related_task_id = parsed.taskId
    } else if (parsed.kind === 'chat') {
      patch.workspace_kind = 'chat'
      patch.related_task_id = null
    } else if (parsed.kind === 'duty') {
      patch.workspace_kind = 'duty'
    }
    await api.chatUpdateContext?.(sessionKey, patch)
  } catch {
    /* ignore */
  }
}

function mintEmployeeChatSessionKey(agentCode: string): string {
  const code = String(agentCode || '').trim()
  if (!code) return ''
  const stamp = mintEmployeeChatEpisodeId()
    .replace(/^chat:/, '')
    .replace(/[:/\\]/g, '-')
  return `proactive:${code}:chat:${stamp}`
}

export function V4EmployeeProcessPane(props: V4EmployeeProcessPaneProps) {
  const {
    agentCode,
    roleName = '',
    title,
    taskId = '',
    roundId = '',
    roundStamp = '',
    busy = false,
    sessionKey = '',
    employeeSessionKeyHint = '',
    pendingSendMessage = '',
    onClose,
  } = props

  const code = String(agentCode || '').trim()
  const [threadId, setThreadId] = useState('')
  /** 岗位绑定 workspace；会话 context 尚未灌入时仍能拼相对路径。 */
  const [roleWorkspacePath, setRoleWorkspacePath] = useState('')
  const [employeeSessionKey, setEmployeeSessionKey] = useState(() =>
    employeeOwnedSessionKey(employeeSessionKeyHint, agentCode),
  )

  useEffect(() => {
    const hint = employeeOwnedSessionKey(employeeSessionKeyHint, agentCode)
    if (hint) setEmployeeSessionKey(hint)
  }, [employeeSessionKeyHint, agentCode])
  const [runStatus, setRunStatus] = useState('')
  const [displayRole, setDisplayRole] = useState(() =>
    resolveEmployeeProcessTabTitle({ title, roleName, agentCode: code }),
  )
  const [loaded, setLoaded] = useState(false)
  const [sending, setSending] = useState(false)
  const [draftVersion, setDraftVersion] = useState(0)
  const [histOpen, setHistOpen] = useState(false)
  const [histLoading, setHistLoading] = useState(false)
  const [histSessions, setHistSessions] = useState<
    Array<{ key: string; title: string; kind?: string; updatedAt?: string; runStatus?: string }>
  >([])
  const draftRef = useRef('')
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null)
  const pickFilesRef = useRef<() => void>(() => {})
  const pickDocFilesRef = useRef<() => void>(() => {})
  const histMenuRef = useRef<HTMLDivElement | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasRunningRef = useRef(false)
  const settledRef = useRef(false)
  const openedAtRef = useRef(Date.now())
  // 【self-evolution-bot · 2026-11-22 · 第113轮 · 模型:deepseek-v4.1-flash-1017】
  // 闸门下界必须是「本轮派发时刻」，不能是「面板打开时刻」。
  // 派单时 CTA 下发的 roundStamp 就是本轮起点；重开/重启面板不该改变这个下界。
  // 只有当 CTA 没带 roundStamp（手点开进度等非派发路径）才退回面板打开时刻。
  const dispatchSinceRef = useRef(
    Number.isFinite(Date.parse(String(roundStamp || ''))) ? Date.parse(String(roundStamp)) : Date.now(),
  )
  useEffect(() => {
    const t = Date.parse(String(roundStamp || ''))
    dispatchSinceRef.current = Number.isFinite(t) ? t : openedAtRef.current
  }, [roundStamp])

  const pluginSessionKey =
    employeeOwnedSessionKey(employeeSessionKey, code) ||
    employeeOwnedSessionKey(employeeSessionKeyHint, code) ||
    ''
  const plugins = useComposerSkillPluginSelection({ selectedSessionKey: pluginSessionKey })
  const {
    bottomPluginPanelOpen,
    setBottomPluginPanelOpen,
    pluginPanelStyle,
    setPluginPanelStyle,
    pluginList,
    pluginListLoading,
    selectedPlugins,
    setSelectedPlugins,
    persistSelectedPlugins,
    bottomSkillOpen,
    setBottomSkillOpen,
    skillList,
    skillListLoading,
    selectedSkills,
    setSelectedSkills,
    persistSelectedSkills,
  } = plugins

  // 「+」面板锚定加号按钮上方（与主聊 / 小V 同款）
  useLayoutEffect(() => {
    if (!bottomPluginPanelOpen || typeof window === 'undefined') {
      setPluginPanelStyle(null)
      return
    }
    const update = () => {
      const btn = moreTriggerRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const gap = 10
      const sidePad = 10
      const width = 420
      const left = Math.max(sidePad, Math.min(r.left, window.innerWidth - sidePad - width))
      const bottom = Math.max(sidePad, window.innerHeight - r.top + gap)
      const maxH = Math.max(160, Math.min(window.innerHeight * 0.62, r.top - gap - sidePad))
      setPluginPanelStyle({
        position: 'fixed',
        left,
        bottom,
        top: 'auto',
        maxHeight: maxH,
        zIndex: 10060,
      } satisfies CSSProperties)
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [bottomPluginPanelOpen, setPluginPanelStyle])

  useEffect(() => {
    logRightStagePane('employeeProcess.mount', {
      agentCode: code || null,
      roleName: String(roleName || '').trim() || null,
      title: String(title || '').trim() || null,
      taskId: taskId || null,
      roundId: roundId || null,
      roundStamp: roundStamp || null,
      ownerSessionKey: String(sessionKey || '').trim() || null,
      employeeSessionKeyHint: String(employeeSessionKeyHint || '').trim() || null,
      pendingSendLen: String(pendingSendMessage || '').trim().length,
      busy,
    })
  }, [
    code,
    roleName,
    title,
    taskId,
    roundId,
    roundStamp,
    sessionKey,
    employeeSessionKeyHint,
    pendingSendMessage,
    busy,
  ])

  const fetchMeta = useCallback(async () => {
    if (!code) {
      setLoaded(true)
      return
    }
    try {
      // 主聊注入的 session_key / surface.sessionKey 绝不能当员工会话
      const hintSk = employeeOwnedSessionKey(
        employeeSessionKeyHint || employeeSessionKey,
        code,
      )
      const ownerSk = String(sessionKey || '').trim()
      const meta = await resolveProactiveProcessMeta({
        agentCode: code,
        taskId,
        roundId,
        sessionKey: hintSk || undefined,
        ensureThread: ensureChatThread,
        // 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：无 hint 且是一轮新派发时，把「本轮开始时刻」交给解析器当闸。
        // 为什么：换轮不继承旧会话键后要靠自动挑，而自动挑优先 running —— 同一员工
        // 可能正在跑别的对话派的任务，不设闸就会把别人的会话显示到这一屏。
        // 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：闸门条件从「有 roundId」放宽成「有 roundId 或 roundStamp」。
        // 为什么：派单路径 roundId 恒空，原来的条件让这道防串台闸门永不生效。
        // 【self-evolution-bot · 2026-11-22 · 第113轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：闸门下界从「面板打开时刻 openedAtRef」换成「本轮派发时刻 roundStamp」。
        // 为什么（个人助理现场实证）：openedAtRef 是**面板挂载**时刻，不是派发时刻。
        //   重启/重开面板后它变成 21:15，而本轮派发是 20:48 —— 闸门下界比真实派发
        //   晚了 27 分钟 ⇒ 任何会话都不可能「晚于闸门」⇒ eligible 恒空 ⇒ meta 恒空
        //   ⇒ 徽标退回写死乐观 busy=true，永久「执行中」（后端 DB 早就是 done）。
        //   只要页面重开过，旧闸门就必然把这一轮判死，这也是重启后仍复现的原因。
        //   派发时刻才是「这一轮从何时开始」的正解，且它每轮必变、不受重开影响。
        autoBindSince: !hintSk && (roundId || roundStamp) ? dispatchSinceRef.current : 0,
      })
      let tid = String(meta.thread_id || '').trim()
      const metaSk = employeeOwnedSessionKey(meta.session_key || '', code)
      // 防串台：解析结果若落到主聊 session/thread，丢掉 thread，继续宽限轮询
      let rejectedOwner = false
      if (ownerSk && metaSk && metaSk === ownerSk) {
        rejectedOwner = true
        tid = ''
      } else if (tid && ownerSk) {
        try {
          const { wsClient } = await import('../../../lib/ws-client.js')
          const ownerTid = String(wsClient.getSessionThreadId?.(ownerSk) || '').trim()
          // 有明确员工 hint 时，ensure 出的 thread 以 hint 为准，勿因偶发与主聊 map 撞号而拒绑
          if (ownerTid && tid === ownerTid && !hintSk) {
            rejectedOwner = true
            tid = ''
          }
        } catch {
          /* optional */
        }
      }
      if (!tid && hintSk) {
        try {
          tid = String((await ensureChatThread(hintSk)) || '').trim()
        } catch {
          /* optional */
        }
      }
      // 拒绑时也必须清掉错误 thread，否则会一直订着主聊
      setThreadId(tid)
      if (hintSk) {
        setEmployeeSessionKey(hintSk)
      } else if (metaSk) {
        setEmployeeSessionKey((prev) => prev || metaSk)
      }
      const status = String(meta.run_status || '').trim()
      if (rejectedOwner) {
        setRunStatus('')
      } else if (hintSk && metaSk && metaSk !== hintSk) {
        /* keep prior / busy fallback */
      } else if (status) {
        setRunStatus(status)
      } else if (!hintSk || metaSk === hintSk) {
        setRunStatus('')
      }
      if (meta.role_name) {
        setDisplayRole(
          resolveEmployeeProcessTabTitle({
            title: meta.role_name,
            roleName: meta.role_name,
            agentCode: code,
          }),
        )
      }
      if (tid) refreshEvoflowV4Session(tid, { softIntervalMs: V4_CATCHUP_SOFT_MS })
      logRightStagePane('employeeProcess.fetchMeta', {
        agentCode: code,
        taskId: taskId || null,
        roundId: roundId || null,
        hintSk: hintSk || null,
        ownerSk: ownerSk || null,
        sessionKey: metaSk || null,
        threadId: tid || null,
        runStatus: rejectedOwner ? null : status || null,
        hintMismatch: Boolean(hintSk && metaSk && metaSk !== hintSk),
        rejectedOwnerBind: rejectedOwner,
        graceMsLeft: Math.max(0, OPEN_GRACE_MS - (Date.now() - openedAtRef.current)),
        displayRole: String(displayRole || roleName || '').trim() || null,
      })
      setLoaded(true)
    } catch (err) {
      logRightStagePane('employeeProcess.fetchMeta error', {
        agentCode: code,
        error: String((err as Error)?.message || err || 'unknown'),
      })
      setLoaded(true)
    }
  }, [code, taskId, roundId, roundStamp, employeeSessionKeyHint, employeeSessionKey, sessionKey])

  const statusLow = String(runStatus || '').toLowerCase()
  // 【self-evolution-bot · 2026-11-22 · 第113轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：给「派单时写死在 tab.data 的乐观 busy」加一道失效闸。
  // 为什么（个人助理现场实证）：`platform_ui_feedback._employee_process_cta` 开栏时
  //   固定写 `data.busy=True`，而**没有任何回写清除路径**；一旦本面板拿不到后端
  //   run_status（见 proactive-session-messages.js 自动绑定闸门的续派误杀），
  //   `running` 就永远退化成 busy=true ⇒ 处理早结束（DB run_status=done）徽标仍
  //   永久停在「执行中」。本闸只兜「拿不到权威态」这一支，不碰有 status 的路径。
  const [optimisticBusyExpired, setOptimisticBusyExpired] = useState(false)
  // 自持起点，不读 openedAtRef：后者由下面另一个 effect 重置，换轮瞬间本 effect
  // 可能先跑一步读到上一轮的旧时刻，于是新轮次的乐观 busy 被立刻判死。
  const optimisticSinceRef = useRef(Date.now())
  useEffect(() => {
    // 换轮/换任务：乐观值重新计时
    optimisticSinceRef.current = Date.now()
    setOptimisticBusyExpired(false)
  }, [code, taskId, roundId, roundStamp])
  useEffect(() => {
    // 只在「有乐观 busy + 后端一直没给权威状态」时计时。
    // 【self-evolution-bot · 2026-11-22 · 第113轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：去掉原来的 `!threadId` 早退条件。
    // 为什么：绑不到会话（threadId 恒空）恰恰是本次故障的主路径——那时 run_status
    //   也恒空，`running` 退化成 busy=true。若这里因 threadId 为空而不计时，
    //   乐观值就永不过期，徽标照样永久「执行中」。绑不到会话时更该让它按时失效。
    if (!busy || optimisticBusyExpired || !loaded || statusLow) return
    const left = OPEN_GRACE_MS - (Date.now() - optimisticSinceRef.current)
    const timer = setTimeout(() => setOptimisticBusyExpired(true), Math.max(0, left))
    return () => clearTimeout(timer)
  }, [busy, loaded, statusLow, optimisticBusyExpired])
  // 后端 run_status 是权威；busy 只在尚未取到时兜底，且过了宽限即失效。
  const running = statusLow ? RUNNING.has(statusLow) : busy && !optimisticBusyExpired
  // chatSend 返回后 sending 立刻 false；群聊 @ 唤醒时 run_status 也常滞后/误 idle，
  // 但 V4 仍在流式——齿轮必须以投影「还有活」为准，否则会停转而正文还在刷。
  const [v4LiveBusy, setV4LiveBusy] = useState(false)
  useEffect(() => {
    const tid = String(threadId || '').trim()
    if (!tid) {
      setV4LiveBusy(false)
      return
    }
    const hostHint = sending || running ? true : statusLow ? false : undefined
    const tick = () => {
      try {
        const snap = getSharedV4SessionDataLayer().peekStore(tid)?.getState()?.snapshot ?? null
        setV4LiveBusy(
          resolveSessionBusyFromControl(snap, { hostExecuting: hostHint }),
        )
      } catch {
        setV4LiveBusy(false)
      }
    }
    tick()
    const store = getSharedV4SessionDataLayer().peekStore(tid)
    const unsub = store?.subscribe?.(() => tick())
    const poll = window.setInterval(tick, 800)
    return () => {
      try {
        unsub?.()
      } catch {
        /* ignore */
      }
      window.clearInterval(poll)
    }
  }, [threadId, sending, running, statusLow])
  const turnBusy = sending || running || v4LiveBusy

  useEffect(() => {
    // 【self-evolution-bot · 2026-11-22 · 第113轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：把「两者都空就直接 return」改成「只有真拿不到任何信息时才不写」。
    // 为什么：`_employee_process_cta` 开栏时写死 `busy:true`，而这里一旦
    //   `statusLow` 与 `v4LiveBusy` 都为空就 return —— 等于**只写不擦**，
    //   页签徽标上的乐观值永久留着。现在只要面板已加载且已绑到会话（或宽限期
    //   已过），就按真实存活态回写，含 false，把残留的乐观 busy 擦掉。
    const key = employeeProcessStageTabKey(taskId, sessionKey, code)
    if (!key) return
    const inGrace = Date.now() - openedAtRef.current < OPEN_GRACE_MS
    const knowsNothing = !statusLow && !v4LiveBusy && !sending && (!loaded || (!threadId && inGrace))
    if (knowsNothing) return
    const alive = RUNNING.has(statusLow) || v4LiveBusy || sending
    try {
      rightStageStore.patchTab(key, { data: { busy: alive } })
    } catch {
      /* store 不可用时忽略 */
    }
  }, [statusLow, v4LiveBusy, sending, loaded, threadId, taskId, sessionKey, code])

  useEffect(() => {
    openedAtRef.current = Date.now()
    wasRunningRef.current = false
    settledRef.current = false
    setLoaded(false)
    setThreadId('')
    setRunStatus('')
    // 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：换轮/换任务时把「上次手挑的会话」清回 hint（无 hint 即空）。
    // 为什么：上面 open-employee-process-stage 已不再把旧 employeeSessionKey 继承进
    // 新轮，但本组件 state 里还留着上一次的值，fetchMeta 走
    // `employeeSessionKeyHint || employeeSessionKey` 又会回落上去 —— 等于白改。
    // 症状就是派了新任务、右栏仍显示上一轮对话。手挑会话（switchEmployeeSession）
    // 不改这些依赖，因此不会被误清。
    setEmployeeSessionKey(employeeOwnedSessionKey(employeeSessionKeyHint, agentCode))
    // 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
    // roundStamp 必须进依赖：派单路径 roundId 恒空，只靠 roundId 时这条重置
    // 在「同一员工再派一单」时根本不会跑，state 里的旧手挑键照样回落。
  }, [code, taskId, roundId, roundStamp, employeeSessionKeyHint, agentCode])

  useEffect(() => {
    setDisplayRole(resolveEmployeeProcessTabTitle({ title, roleName, agentCode: code }))
  }, [title, roleName, code])

  // 员工绑定工作空间：相对产出路径要拼这个前缀才能点开
  useEffect(() => {
    if (!code) {
      setRoleWorkspacePath('')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const { api } = await import('../../../lib/tauri-api.js')
        const res = await api.proactiveGetRole?.(code)
        if (cancelled) return
        const role = res?.role || res
        const cfg =
          role && typeof role === 'object' && role.config && typeof role.config === 'object'
            ? role.config
            : {}
        setRoleWorkspacePath(String(cfg.workspace_path || '').trim())
      } catch {
        if (!cancelled) setRoleWorkspacePath('')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code])

  // 岗位名缺失或只剩 agent_code 时，拉 proactiveGetRole / agents 补中文名
  useEffect(() => {
    if (!code) return
    let cancelled = false
    const current = String(displayRole || roleName || title || '').trim()
    if (current && !looksLikeAgentCodeLabel(current, code)) return

    void (async () => {
      try {
        const { api } = await import('../../../lib/tauri-api.js')
        let nice = ''
        try {
          const res = await api.proactiveGetRole?.(code)
          const role = (res && typeof res === 'object' ? (res as any).role || res : null) as
            | Record<string, unknown>
            | null
          // 岗位中文名优先；合同名为空时用智能体显示名，绝不用 agent_code
          nice = String(
            role?.role_name || role?.roleName || role?.agent_name || role?.name || '',
          ).trim()
        } catch {
          /* ignore */
        }
        if ((!nice || looksLikeAgentCodeLabel(nice, code)) && typeof api.listAgents === 'function') {
          try {
            const agents = await api.listAgents()
            const row = (Array.isArray(agents) ? agents : []).find(
              (a: any) =>
                String(a?.agent_code || '')
                  .trim()
                  .toLowerCase() === code.toLowerCase(),
            )
            nice =
              String(row?.agent_name || row?.name || '').trim() || nice
          } catch {
            /* ignore */
          }
        }
        if (cancelled || !nice || looksLikeAgentCodeLabel(nice, code)) return
        setDisplayRole(nice)
        patchEmployeeProcessTabTitle(taskId, nice, {
          sessionKey,
          roleName: nice,
          agentCode: code,
        })
      } catch {
        /* ignore */
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code, displayRole, roleName, title, taskId, sessionKey])

  useEffect(() => {
    const nice = String(displayRole || '').trim()
    if (!code || !nice || nice === '执行过程') return
    patchEmployeeProcessTabTitle(taskId, nice, {
      sessionKey,
      roleName: nice,
      agentCode: code,
    })
  }, [displayRole, taskId, sessionKey, code])

  useEffect(() => {
    let disposed = false

    const clearPoll = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
    const clearSettle = () => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current)
        settleTimerRef.current = null
      }
    }

    void fetchMeta()

    const inOpenGrace = Date.now() - openedAtRef.current < OPEN_GRACE_MS
    // 宽限内继续刷：派发后会话行可能晚于右栏打开，避免首轮误绑旧 done 就停死
    const shouldPoll =
      !loaded || running || sending || !threadId || (inOpenGrace && !settledRef.current)

    logRightStagePane('employeeProcess.poll', {
      agentCode: code,
      shouldPoll,
      loaded,
      running,
      sending,
      hasThread: Boolean(threadId),
      inOpenGrace,
      settled: settledRef.current,
      wasRunning: wasRunningRef.current,
      runStatus: statusLow || null,
      sessionKey: String(employeeSessionKeyHint || employeeSessionKey || '').trim() || null,
      threadId: threadId || null,
    })

    if (shouldPoll) {
      wasRunningRef.current = wasRunningRef.current || running || sending
      if (running || sending) settledRef.current = false
      clearSettle()
      clearPoll()
      pollRef.current = setInterval(() => {
        if (disposed) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        // 宽限结束后若已非 running 且有 thread，下一轮 effect 会走 settle/停刷
        if (
          Date.now() - openedAtRef.current >= OPEN_GRACE_MS &&
          !running &&
          !sending &&
          threadId &&
          loaded
        ) {
          clearPoll()
          return
        }
        void fetchMeta()
      }, POLL_ACTIVE_MS)
      return () => {
        disposed = true
        clearPoll()
        clearSettle()
      }
    }

    if (wasRunningRef.current && !settledRef.current) {
      settledRef.current = true
      clearPoll()
      clearSettle()
      settleTimerRef.current = setTimeout(() => {
        if (disposed) return
        void fetchMeta()
      }, SETTLE_DELAY_MS)
      return () => {
        disposed = true
        clearPoll()
        clearSettle()
      }
    }

    clearPoll()
    clearSettle()
    return () => {
      disposed = true
      clearPoll()
      clearSettle()
    }
  }, [fetchMeta, loaded, running, sending, threadId])

  const resolveSendSessionKey = useCallback(async (): Promise<{ sk: string; tid: string }> => {
    // 【self-evolution-bot · 2026-11-21 · 第111轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：发送前对 `sk` 加一道硬判据 —— **不允许往 task 会话里发**。
    //   若解析结果落在 `proactive:<code>:task:<id>`，丢弃它、改建/复用该员工的 chat 会话。
    // 为什么（现网实证，不是推测）：审核员面板通过 resolveProactiveProcessMeta 自动挑会话时
    //   挑中了昨天那个任务会话 proactive:reviewer:task:2611202007_de39（thread 517144f5）。
    //   我经平台发的那句话就写进了那里：库实证 19:40:28 user + 19:40:31 assistant「审核员」，
    //   thread_id=517144f5；而面板显示的是 chat 会话 dept-e52862be9e71（thread ce27a8d1，
    //   只有 3 条、停在昨天 20:07）。结果：员工**确实收到并回答了**，但用户面板永远看不到。
    //   更坏的是后端回执的 session_key 是调用方传的 chat key，看起来"发对了"，纯属误导。
    // 判据：写库的 session_key 必须是 chat 会话且等于面板正在显示的会话；
    //   拿 task 会话发"对话"，用户在那个面板里一定看不到。
    let sk = String(employeeSessionKey || '').trim()
    if (!sk && code) {
      if (taskId) {
        const meta = await resolveProactiveProcessMeta({
          agentCode: code,
          taskId,
          roundId,
          sessionKey: String(employeeSessionKey || employeeSessionKeyHint || '').trim() || undefined,
          ensureThread: ensureChatThread,
        })
        sk = String(meta.session_key || '').trim()
      }
      if (!sk) sk = mintEmployeeChatSessionKey(code)
      setEmployeeSessionKey(sk)
    }
    // 【self-evolution-bot · 2026-11-21 · 第111轮 · 模型:deepseek-v4.1-flash-1017】
    // task 会话不能用来发「对话」：那条消息进的是任务时间线，面板（绑 chat 会话）看不到。
    // 现网实证：审核员被这条坑掉（详见 employee-send-session-kind.ts 顶部说明）。
    const guarded = resolveSendSessionKeyForChat({
      candidate: sk,
      fallback: code ? mintEmployeeChatSessionKey(code) : '',
    })
    if (guarded.switchedFrom) {
      console.warn('[employee-pane] send dropped task session key, switch to chat', {
        from: guarded.switchedFrom,
        to: guarded.sk,
      })
      sk = guarded.sk
      setEmployeeSessionKey(sk)
    }
    let tid = String(threadId || '').trim()
    if (sk && !tid) {
      tid = await ensureChatThread(sk)
      if (tid) setThreadId(tid)
    }
    return { sk, tid }
  }, [employeeSessionKey, employeeSessionKeyHint, code, taskId, roundId, threadId])

  // 【self-evolution-bot · 2026-11-22 · 第127轮 · 模型:deepseek-v4.1-flash】
  // 改了什么：返回值从 `void` 改成 `Promise<boolean>` —— **true 才算真发出去**。
  // 为什么：平台排队的那句话（pendingSendMessage）原来「先清 tab data 再发」，
  //   而 handleSend 在 `!text || sending` 时静默 return，会话解析失败也 return ——
  //   调用方根本分不出「发了」和「一句话没发」，于是清掉的那条消息永久消失
  //   （现网 2026-11-22 22:01:57 实证：全库 grep 探针 0 条，新会话 idle/0 条）。
  // 判据：只有 `api.chatSend` 真 resolve 才 return true；早退/异常一律 false。
  const handleSend = useCallback(
    async (message: string, attachments?: ChatAttachment[]): Promise<boolean> => {
      const text = String(message || '').trim()
      if (!text || sending) return false
      setSending(true)
      try {
        const { sk, tid } = await resolveSendSessionKey()
        if (!sk) {
          toast('无法解析员工会话', 'error')
          return false
        }
        await patchProactiveChatContext(sk)
        const { api } = await import('../../../lib/tauri-api.js')
        await api.chatSend(sk, text, attachments || [], undefined, {
          source: 'employee-process-pane',
        })
        draftRef.current = ''
        setDraftVersion((v) => v + 1)
        if (tid) refreshEvoflowV4Session(tid, { softIntervalMs: V4_CATCHUP_SOFT_MS })
        // 乐观：进入执行中，等 meta 回写
        setRunStatus('running')
        void fetchMeta()
        return true
      } catch (e) {
        toast(String((e as Error)?.message || e || '发送失败'), 'error')
        return false
      } finally {
        setSending(false)
      }
    },
    [sending, resolveSendSessionKey, fetchMeta],
  )

  // 输入框走的是 ChatComposer 契约（void | Promise<void>），把 boolean 收进来丢掉即可。
  const handleSendForComposer = useCallback(
    async (message: string, attachments?: ChatAttachment[]) => {
      await handleSend(message, attachments)
    },
    [handleSend],
  )

  // 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：把本面板的 handleSend 注册进 employee-pane-send-bridge，平台工具可经
  //   `/main-cdp/action employeeChatSend` 直接驱动面板自己发送。
  // 为什么（用户 2026-11-21 点破）：「我在右侧面板手打能看到实时结果，你后台触发页面上啥也看不到。」
  //   手打走的是 ChatApp.chatSend → live SSE 逐字流；后台 wake 是另一轮没有流，
  //   只能等整轮跑完再轮询快照。要「和手打一样」，就必须由面板这一侧调 chatSend。
  // 判据（可反证）：清空注册表后同一调用必须回落 pendingSend 分支；
  //   注册后应直接拿到 handleSend，parseToolResult 里的 pendingSendMessage 为空。
  useEffect(() => {
    if (!code) return
    let dispose: (() => void) | null = null
    let cancelled = false
    void (async () => {
      try {
        const mod = await import('../../../lib/right-stage/employee-pane-send-bridge.js')
        if (cancelled) return
        dispose = mod.registerEmployeePaneSender({
          agentCode: code,
          sessionKey: String(employeeSessionKeyHint || employeeSessionKey || '').trim(),
          // 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
          // 改了什么：send 返回 boolean —— 只有「真接住了」才 true。
          // 为什么：handleSend 在 `sending` 为真时第一句就 `return`（静默丢消息）。
          //   若这里不加判据，面板正忙时 CDP 仍会回 pane-live，工具层以为已送达、
          //   前端又因 panel_dispatch 非空不再补发 —— 这句话就凭空消失了，是典型假成功。
          // 判据：sending 为真 → false → CDP 回 mode='pane-busy' → 前端回落 pendingSend。
          send: (text: string) => {
            if (sending) return false
            void handleSend(String(text || ''))
            return true
          },
        })
      } catch {
        /* 桥可选：失败则平台侧回落 pendingSend */
      }
    })()
    return () => {
      cancelled = true
      try {
        dispose?.()
      } catch {
        /* ignore */
      }
    }
  }, [code, employeeSessionKeyHint, employeeSessionKey, handleSend])

  // 平台 chat_send：只开右栏 + pending，由本面板走与输入框同一套发送（ensureThread→chatSend）
  //
  // 【self-evolution-bot · 2026-11-22 · 第127轮 · 模型:deepseek-v4.1-flash】
  // 改了什么：整段重写。判据抽到 `pending-send-gate.ts`，且**发送成功后才清 tab data**。
  // 为什么（现网实证 2026-11-22 22:01:57，agent=case-fullstack-dev）：
  //   后端已按 busy 判据 mint 新会话、CDP 也回了 `pending-open-switch`，右栏确实把这句话
  //   写进了 tab data —— 但全库 grep 探针 `POKE-BUSY-SECOND` **0 条**，新会话 `idle / 0 条`。
  //   旧代码三处结构缺陷叠在一起：
  //   ① `if (sending) return` —— 面板正忙时既不排队也不留痕，`sending` 变回 false 后
  //      effect 虽会重跑，但那时 tab data 里的 pending 已被重开签覆盖成空，等于丢掉；
  //   ② `clearEmployeeProcessPendingSend(...)` 写在 `handleSend` **之前** —— 发送失败
  //      （会话解析不出 / 网络错）时消息已清空，无重试；
  //   ③ `pendingSentRef` 在清空之后、发送之前写入 —— 没发成也标成「已发」，永不重试。
  // 现值：忙 → hold（什么都不写，等 sending 翻 false 再发）；不忙 → 占坑 → 发送 →
  //   **成功**才写已发标记 + 清 tab data；失败则保留 pending 供下次 effect 重试并 toast。
  const pendingSentRef = useRef('')
  useEffect(() => {
    const pending = String(pendingSendMessage || '').trim()
    if (!pending || !code) return
    const decision = decidePendingSend({
      pendingText: pending,
      agentCode: code,
      sessionKey: String(employeeSessionKeyHint || employeeSessionKey || '').trim(),
      sentKey: pendingSentRef.current,
      sessionBusy: sending,
    })
    if (decision.action === 'hold') {
      logRightStagePane('employeeProcess.pendingSend → hold（面板忙，保留待发）', {
        agentCode: code,
        pendingLen: pending.length,
        reason: decision.reason,
      })
      return
    }
    if (decision.action !== 'send') return
    if (!markPendingSendInflight(decision.dedupeKey)) return
    logRightStagePane('employeeProcess.pendingSend → handleSend', {
      agentCode: code,
      pendingLen: pending.length,
      pendingPreview: pending.slice(0, 120),
      employeeSessionKey:
        String(employeeSessionKeyHint || employeeSessionKey || '').trim() || null,
    })
    // 【self-evolution-bot · 2026-11-22 · 第127轮 · 模型:deepseek-v4.1-flash】
    // 结算不挂在本轮 effect 的 cleanup 上：`sending` 翻转会让 effect 重跑，
    // 若用 `alive` 守卫跳过结算，这条**已经真发出去**的消息会既不记已发、也不清签，
    // 下一次 effect 再发一遍（同一句话两遍）。所以成功结算一律执行，
    // 且只清「仍是我发的那一句」——期间若来了新 pending，不能连它一起抹掉。
    void (async () => {
      let ok = false
      try {
        ok = await handleSend(pending)
      } catch {
        ok = false
      } finally {
        clearPendingSendInflight(decision.dedupeKey)
      }
      if (!ok) {
        // 失败：tab data 里的 pending 原样留着，下一次 effect（sending 变化 / 重挂载）
        // 会因 pendingSentRef 仍为空而重试；这里只留痕，不静默。
        logRightStagePane('employeeProcess.pendingSend 发送失败，保留待重试', {
          agentCode: code,
          pendingLen: pending.length,
        })
        return
      }
      pendingSentRef.current = decision.dedupeKey
      const key = employeeProcessStageTabKey(taskId, sessionKey, code)
      const live = key ? rightStageStore.findTab(key) : null
      const stillMine =
        String(live?.data?.pendingSendMessage || '').trim() === pending
      if (stillMine) {
        clearEmployeeProcessPendingSend(taskId, {
          sessionKey,
          agentCode: code,
        })
      }
    })()
  }, [
    pendingSendMessage,
    code,
    employeeSessionKeyHint,
    employeeSessionKey,
    taskId,
    sessionKey,
    sending,
    handleSend,
  ])

  const handleAbort = useCallback(async () => {
    const sk = String(employeeSessionKey || '').trim()
    if (!sk) return
    try {
      const { logStreamStop } = await import('../../lib/stream-stop-log.js')
      logStreamStop({
        sessionKey: sk,
        trigger: 'employee_process_pane',
        hasEndMarker: false,
        fromUiStopButton: true,
        detail: {
          source: 'employee_process_pane',
          whoZh: '员工进程面板停止按钮',
          note: '主动停止路径：员工进程面板停止按钮',
        },
      })
      const { api } = await import('../../../lib/tauri-api.js')
      await api.chatAbort?.(sk, undefined, { userInitiated: true, skipRunIdle: true })
      await api.stopSessionExecution?.(sk, { userInitiated: true })
      toast('已停止执行', 'info')
      void fetchMeta()
    } catch (e) {
      toast(String((e as Error)?.message || e || '停止失败'), 'error')
    }
  }, [employeeSessionKey, fetchMeta])

  const handleDraftChange = useCallback((value: string) => {
    draftRef.current = value
  }, [])

  const insertComposerText = useCallback((text: string) => {
    const cur = String(draftRef.current || '')
    draftRef.current = `${cur}${text}`
    setDraftVersion((v) => v + 1)
  }, [])

  /** 切到该员工的另一条会话 / 新开对话：换 employeeSessionKey，重绑 V4。 */
  const switchEmployeeSession = useCallback(
    (nextKey: string) => {
      const sk = employeeOwnedSessionKey(nextKey, code)
      if (!sk || sk === String(employeeSessionKey || '').trim()) {
        setHistOpen(false)
        return
      }
      setEmployeeSessionKey(sk)
      setThreadId('')
      setLoaded(false)
      setRunStatus('')
      openedAtRef.current = Date.now()
      wasRunningRef.current = false
      settledRef.current = false
      draftRef.current = ''
      setDraftVersion((v) => v + 1)
      setHistOpen(false)
      const tabKey = employeeProcessStageTabKey(taskId, sessionKey, code)
      if (tabKey) {
        try {
          rightStageStore.patchTab(tabKey, { data: { employeeSessionKey: sk } })
        } catch {
          /* ignore */
        }
      }
    },
    [code, employeeSessionKey, taskId, sessionKey],
  )

  const refreshEmployeeHistory = useCallback(async () => {
    if (!code) {
      setHistSessions([])
      return
    }
    setHistLoading(true)
    try {
      const { api } = await import('../../../lib/tauri-api.js')
      const res = await api.proactiveListConversations?.(code, { limit: 40 })
      const list = Array.isArray(res?.conversations) ? res.conversations : []
      const rows = list
        .map((c: any) => {
          const key = String(c?.session_key || '').trim()
          if (!key || !employeeOwnedSessionKey(key, code)) return null
          const kind = String(c?.kind || '').trim().toLowerCase()
          const title =
            String(c?.title || c?.task_id || '').trim() ||
            (kind === 'chat' ? '对话' : kind === 'duty' ? '值班' : kind === 'task' ? '任务' : key)
          return {
            key,
            title,
            kind,
            updatedAt: String(c?.updated_at || '').trim() || undefined,
            runStatus: String(c?.run_status || '').trim() || undefined,
          }
        })
        .filter(Boolean) as Array<{
        key: string
        title: string
        kind?: string
        updatedAt?: string
        runStatus?: string
      }>
      // 对话优先，其余按列表顺序跟在后面
      rows.sort((a, b) => {
        const ak = a.kind === 'chat' ? 0 : 1
        const bk = b.kind === 'chat' ? 0 : 1
        if (ak !== bk) return ak - bk
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
      })
      setHistSessions(rows)
    } catch {
      setHistSessions([])
    } finally {
      setHistLoading(false)
    }
  }, [code])

  const onToggleHistory = useCallback(async () => {
    const next = !histOpen
    setHistOpen(next)
    if (next) await refreshEmployeeHistory()
  }, [histOpen, refreshEmployeeHistory])

  const onNewEmployeeChat = useCallback(() => {
    if (!code) return
    const sk = mintEmployeeChatSessionKey(code)
    if (!sk) return
    switchEmployeeSession(sk)
    toast('已新开对话', 'success')
  }, [code, switchEmployeeSession])

  /** 侧栏直接打开当前员工编辑；保存后即时生效 */
  const onEditEmployee = useCallback(() => {
    const agentCode = String(code || '').trim()
    if (!agentCode) {
      toast('当前没有可编辑的员工', 'warning')
      return
    }
    void Promise.all([
      import('../../../lib/tauri-api.js'),
      import('../../../lib/proactive-role-edit.js'),
    ])
      .then(async ([{ api }, { showEditRoleModal }]) => {
        const res = (await api.proactiveGetRole(agentCode)) as { role?: unknown } | unknown
        const role =
          res && typeof res === 'object' && 'role' in (res as object)
            ? (res as { role?: unknown }).role || res
            : res
        if (!role || typeof role !== 'object') {
          toast('找不到当前员工', 'error')
          return
        }
        const name =
          String((role as { role_name?: string }).role_name || '').trim() ||
          String(displayRole || roleName || agentCode).trim()
        await showEditRoleModal(role, {
          sheetTitle: name ? `编辑 ${name}` : '编辑员工',
          sheetKicker: 'BOT',
          confirmLabel: '保存员工',
          allowAgentRebind: false,
          onSaved: (updated) => {
            const nextName = String(
              (updated as { role_name?: string } | undefined)?.role_name || '',
            ).trim()
            if (nextName) setDisplayRole(nextName)
            toast('员工已更新', 'success')
          },
        })
      })
      .catch((e) => {
        toast(`无法打开编辑：${(e as Error)?.message || e}`, 'error')
      })
  }, [code, displayRole, roleName])

  // 点历史菜单外关闭
  useEffect(() => {
    if (!histOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null
      if (!t) return
      if (histMenuRef.current?.contains(t)) return
      setHistOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHistOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [histOpen])

  const composerDock = useMemo(
    () => (
      <div
        className="v4-employee-process-composer border-t border-border bg-card px-2 pb-2 pt-1"
        data-v4-employee-composer-host="true"
      >
        <ChatComposer
          sessionReady={Boolean(code)}
          engineReady
          initialDraft={draftRef.current}
          draftVersion={draftVersion}
          onDraftChange={handleDraftChange}
          sending={turnBusy}
          streaming={turnBusy}
          // 【self-evolution-bot · 2026-11-22 · 第127轮 · 模型:deepseek-v4.1-flash】
          // 改了什么：包一层 `handleSendForComposer`，因为 handleSend 现在回 boolean
          //   （「是否真发出去」），而 ChatComposer.onSend 的契约是 `void | Promise<void>`。
          // 为什么：pendingSend 那条路必须能分辨成败（失败保留待重试），输入框这条路不需要；
          //   改共用组件的 prop 类型等于为了我这一处去动摇别人正在改的契约。
          onSend={handleSendForComposer}
          onAbort={handleAbort}
          placeholder={
            displayRole
              ? `跟「${displayRole}」说点什么…`
              : '输入消息，继续与该员工对话…'
          }
          speechEnabled={false}
          bottomMoreTriggerRef={moreTriggerRef}
          onOpenAttachmentMenu={() => {
            setBottomPluginPanelOpen((prev) => !prev)
          }}
          renderBottomControls={({ pickFiles, pickDocFiles }) => {
            pickFilesRef.current = pickFiles
            pickDocFilesRef.current = pickDocFiles
            return null
          }}
        />
      </div>
    ),
    [
      code,
      draftVersion,
      handleDraftChange,
      turnBusy,
      handleSend,
      handleAbort,
      displayRole,
      setBottomPluginPanelOpen,
    ],
  )

  const headerTitleRaw = String(displayRole || title || roleName || '').trim()
  const headerTitle = looksLikeAgentCodeLabel(headerTitleRaw, code)
    ? '执行过程'
    : headerTitleRaw || '执行过程'
  // 时间线 scope 必须用员工会话；绝不能回落主聊，否则与左侧同流
  const ownerSessionKey = String(sessionKey || '').trim()
  const timelineSessionKey = employeeOwnedSessionKey(employeeSessionKey, code)
  const bridgeSessionKey = timelineSessionKey || undefined
  const fileOwnerSessionKey = ownerSessionKey || timelineSessionKey || undefined

  if (!code) return null

  return (
    <div className="v4-employee-process v4-employee-process-panel relative flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <EmployeeStageAvatar
          agentCode={code}
          title={headerTitle}
          size={22}
          busy={turnBusy}
          className="shrink-0"
        />
        <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">{headerTitle}</span>
        <span
          className={
            'rounded px-1.5 py-0.5 text-[11px] ' +
            (turnBusy
              ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
              : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400')
          }
        >
          {turnBusy
            ? '执行中'
            : STATUS_LABEL[statusLow] || runStatus || (loaded ? '可对话' : '加载中')}
        </span>
        <div className="flex-1" />
        <div className="relative flex shrink-0 items-center gap-0.5" ref={histMenuRef}>
          <button
            type="button"
            className="rounded p-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
            onClick={() => {
              try {
                const tid = String(threadId || '').trim()
                const snap = tid
                  ? getSharedV4SessionDataLayer().peekStore(tid)?.getState()?.snapshot
                  : null
                const text = plainTextFromV4Window(snap?.rows?.window as { kind?: string; text?: string }[])
                if (!text) {
                  toast('暂无可复制的对话内容', 'info')
                  return
                }
                void navigator.clipboard.writeText(text).then(
                  () => toast('已复制对话内容', 'success'),
                  () => toast('复制失败', 'error'),
                )
              } catch {
                toast('复制失败', 'error')
              }
            }}
            title="复制对话"
            aria-label="复制对话"
            disabled={!threadId}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16V4a2 2 0 0 1 2-2h10" />
            </svg>
          </button>
          <button
            type="button"
            className="rounded p-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
            onClick={onEditEmployee}
            title="编辑员工"
            aria-label="编辑员工"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
          <button
            type="button"
            className="rounded p-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
            onClick={() => void onToggleHistory()}
            title="历史对话"
            aria-label="历史对话"
            aria-expanded={histOpen}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M12 7v5l4 2" />
            </svg>
          </button>
          {histOpen ? (
            <div
              className="absolute right-0 top-full z-50 mt-1 max-h-72 w-64 overflow-auto rounded-md border border-border bg-card py-1 shadow-md"
              role="menu"
              aria-label="历史对话"
            >
              <div className="px-3 py-1.5 text-[11px] font-medium text-foreground-subtlest">
                历史对话
              </div>
              {histLoading ? (
                <div className="px-3 py-4 text-center text-ui-sm text-foreground-subtlest">
                  加载中…
                </div>
              ) : histSessions.length ? (
                histSessions.map((s) => {
                  const kindTag =
                    s.kind === 'chat'
                      ? '对话'
                      : s.kind === 'duty'
                        ? '值班'
                        : s.kind === 'task'
                          ? '任务'
                          : ''
                  const active = s.key === timelineSessionKey
                  return (
                    <button
                      key={s.key}
                      type="button"
                      role="menuitem"
                      className={
                        'flex w-full flex-col gap-0.5 px-3 py-2 text-left text-ui-sm hover:bg-hover ' +
                        (active ? 'bg-selected text-foreground' : 'text-foreground')
                      }
                      onClick={() => {
                        switchEmployeeSession(s.key)
                        toast('已切换会话', 'success')
                      }}
                    >
                      <span className="min-w-0 truncate font-medium">
                        {kindTag ? `[${kindTag}] ` : ''}
                        {s.title}
                      </span>
                      {s.runStatus ? (
                        <span className="text-[11px] text-foreground-subtlest">
                          {STATUS_LABEL[String(s.runStatus).toLowerCase()] || s.runStatus}
                        </span>
                      ) : null}
                    </button>
                  )
                })
              ) : (
                <div className="px-3 py-4 text-center text-ui-sm text-foreground-subtlest">
                  暂无历史对话
                </div>
              )}
            </div>
          ) : null}
          <button
            type="button"
            className="rounded p-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
            onClick={onNewEmployeeChat}
            title="新开对话"
            aria-label="新开对话"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
          </button>
        </div>
        {onClose ? (
          <button
            type="button"
            className="rounded p-1 text-foreground-subtlest hover:bg-hover"
            onClick={onClose}
            aria-label="关闭"
          >
            {'\u2715'}
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {threadId ? (
          <V4SessionPaneBridge
            sessionId={threadId}
            connecting={!loaded}
            sessionKey={fileOwnerSessionKey}
            evoflowSessionKey={bridgeSessionKey}
            workspacePath={roleWorkspacePath || undefined}
            embedded
            sessionBusy={turnBusy}
            bottomDock={composerDock}
          />
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-ui-sm text-foreground-subtlest">
              {!loaded
                ? '正在解析员工会话…'
                : turnBusy
                  ? '执行中，等待会话 thread…'
                  : '暂无历史消息，可在下方直接发第一句'}
            </div>
            {composerDock}
          </div>
        )}
      </div>

      <PluginQuickPanel
        open={bottomPluginPanelOpen}
        onClose={() => setBottomPluginPanelOpen(false)}
        style={pluginPanelStyle}
        plugins={pluginList}
        loading={pluginListLoading}
        selected={selectedPlugins}
        onToggle={(item) => {
          setSelectedPlugins((prev) => {
            const next = prev.some((p) => p.id === item.id)
              ? prev.filter((p) => p.id !== item.id)
              : [
                  ...prev,
                  {
                    id: item.id,
                    label: item.label || item.name,
                    iconUrl: item.iconUrl,
                  },
                ]
            void persistSelectedPlugins(String(pluginSessionKey || ''), next)
            return next
          })
        }}
        onPickDocs={() => {
          setBottomPluginPanelOpen(false)
          pickDocFilesRef.current?.()
        }}
        onPickImages={() => {
          setBottomPluginPanelOpen(false)
          pickFilesRef.current?.()
        }}
        onOpenSkillPicker={() => {
          setBottomPluginPanelOpen(false)
          setBottomSkillOpen(true)
        }}
        onOpenGoal={() => {
          setBottomPluginPanelOpen(false)
          window.dispatchEvent(new CustomEvent('evopanel:open-goal-panel', { detail: { open: true } }))
        }}
        onOpenLegacyMenu={() => setBottomPluginPanelOpen(false)}
        onInsertText={(text) => insertComposerText(text)}
        showVoice={false}
        voiceOn={false}
        onToggleVoice={() => {}}
        showLegacyMenu={false}
        showHintBar={false}
        onPickEmployee={() => {
          setBottomPluginPanelOpen(false)
          toast('当前已是员工对话标签', 'info')
        }}
      />

      <SkillPickerModal
        open={bottomSkillOpen}
        onClose={() => setBottomSkillOpen(false)}
        skills={skillList}
        loading={skillListLoading}
        selected={selectedSkills}
        onConfirm={(next) => {
          setSelectedSkills(next)
          void persistSelectedSkills(String(pluginSessionKey || ''), next)
          setBottomSkillOpen(false)
        }}
      />
    </div>
  )
}

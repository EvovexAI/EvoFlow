/**
 * 部门群聊 @ 成员：复用 proactive 员工对话会话（全工具 harness + 多轮历史），
 * 不用会议 speak_in_meeting 口头模板。
 *
 * sessionKey 稳定为 ``proactive:{code}:chat:dept-{deptId}``，同一部门同一人始终续聊。
 */
import { api } from '../../lib/tauri-api.js'
import { deptChatSessionKey } from './dept-chat-session.js'
import {
  extractDeptGroupHandoffs,
  type DeptGroupHandoff,
} from './dept-group-handoff.js'

export function deptMemberWorkSessionKey(deptId: string, agentCode: string): string {
  const code = String(agentCode || '').trim()
  const did = String(deptId || '')
    .trim()
    .replace(/[:/\\]+/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 120)
  if (!code || !did) return ''
  return `proactive:${code}:chat:dept-${did}`
}

function extractContentField(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (p && typeof p === 'object') {
          return String((p as { text?: string; content?: string }).text || (p as { content?: string }).content || '')
        }
        return ''
      })
      .filter(Boolean)
      .join('')
      .trim()
  }
  if (content && typeof content === 'object') {
    return String((content as { text?: string; content?: string }).text || (content as { content?: string }).content || '').trim()
  }
  return ''
}

function extractAssistantText(payload: any): string {
  if (!payload || typeof payload !== 'object') return ''
  const msg = payload.message
  if (msg && typeof msg === 'object') {
    const fromMsg = extractContentField((msg as { content?: unknown }).content)
    if (fromMsg) return fromMsg
  }
  const delta = String(payload.delta || payload.text || '').trim()
  if (delta) return delta
  return extractContentField(payload.content)
}

/** 从 chatHistory 行抽出助手正文（兼容 content / content_json） */
export function extractHistoryAssistantText(row: any): string {
  if (!row || typeof row !== 'object') return ''
  const role = String(row.role || '').toLowerCase()
  if (role && role !== 'assistant' && role !== 'ai') return ''
  const direct = extractContentField(row.content)
  if (direct) return direct
  const payload =
    row.content_json && typeof row.content_json === 'object'
      ? row.content_json
      : row.contentJson && typeof row.contentJson === 'object'
        ? row.contentJson
        : null
  if (!payload) return ''
  const fromPayload = extractContentField(payload.content)
  if (fromPayload) return fromPayload
  return String(payload.text || '').trim()
}

/** 群气泡丢了正文时，从员工 sticky 会话回读最近一条助手回复 */
export async function loadLatestDeptMemberReply(workSessionKey: string): Promise<string> {
  const sk = String(workSessionKey || '').trim()
  if (!sk) return ''
  try {
    const hist = await api.chatHistory(sk, 40, { bypassCache: true })
    const rows = Array.isArray(hist?.messages)
      ? hist.messages
      : Array.isArray(hist)
        ? hist
        : []
    for (let i = rows.length - 1; i >= 0; i--) {
      const t = extractHistoryAssistantText(rows[i])
      if (t) return t
    }
  } catch {
    /* ignore */
  }
  return ''
}

export type DeptMemberWorkTurnOpts = {
  deptId: string
  deptName?: string
  agentCode: string
  roleName?: string
  /** 用户原话 / 派工目标 */
  text: string
  /** 群时间线近期上下文（可选） */
  groupContext?: string
  fromAgentName?: string
  /**
   * 小V 群管家模式：用户未 @ 任何人，默认由小V接住。
   * 需知道本群花名册，才能灵活 @ 分派。
   */
  stewardMode?: boolean
  /** 本群成员（角色名），给管家提示「可以 @ 谁」 */
  roster?: Array<{ agent_code: string; role_name: string }>
  onDelta?: (text: string) => void
  signal?: { aborted?: boolean }
}

export type DeptMemberWorkTurnResult = {
  text: string
  /** 工具 handlers / 派发结果里的下游（正文漏 @ 时仍可叫醒） */
  handoffs: DeptGroupHandoff[]
}

/**
 * 对部门内一名员工跑一轮完整 agent 对话（可调工具），返回定稿正文 + 工具接力。
 */
export async function runDeptMemberWorkTurn(
  opts: DeptMemberWorkTurnOpts,
): Promise<DeptMemberWorkTurnResult> {
  const code = String(opts.agentCode || '').trim()
  const deptId = String(opts.deptId || '').trim()
  const sk = deptMemberWorkSessionKey(deptId, code)
  if (!sk) throw new Error('缺少部门或员工')

  const roleName = String(opts.roleName || code).trim() || code
  const goal = String(opts.text || '').trim()
  if (!goal) throw new Error('请输入内容')

  const { wsClient } = await import('../../lib/ws-client.js')
  const deptName = String(opts.deptName || '部门').trim() || '部门'

  const stewardMode = !!opts.stewardMode
  const roster = Array.isArray(opts.roster) ? opts.roster : []
  const sessionCtx = {
    source: 'proactive',
    proactive_agent_code: code,
    agent_id: code,
    agent_name: roleName,
    employee_talk_mode: 'chat',
    workspace_kind: 'chat',
    session_mode: 'agent',
    dept_group_id: deptId,
    dept_group_name: deptName,
    dept_group_im: true,
    // 反查群时间线 session
    dept_group_timeline_session: deptChatSessionKey(deptId),
    // 每轮显式写，避免 sticky 会话残留上一轮管家旗标
    dept_group_steward: stewardMode,
  }

  try {
    await api.chatSessionsCreate(code, {
      sessionKey: sk,
      title: stewardMode ? `${deptName} · 小V管家` : `${deptName} · ${roleName}`,
      ensureThread: true,
      context: sessionCtx,
    })
  } catch {
    /* 已有会话时偶发冲突，ensure-thread 会在 chatSend 里再补 */
  }

  try {
    await wsClient.updateSessionContext?.(sk, sessionCtx)
  } catch {
    /* optional */
  }

  const parts: string[] = []
  if (stewardMode) {
    const rosterLine = roster.length
      ? roster
          .map((m) => String(m.role_name || m.agent_code || '').trim())
          .filter(Boolean)
          .slice(0, 40)
          .join('、')
      : '（花名册暂空，仍可先回用户再想办法）'
    parts.push(
      [
        `【部门群聊 · ${deptName} · 小V 群管家】`,
        `你是小V，这个「${deptName}」常驻群的默认管家。用户没 @ 任何人时，话默认交给你。`,
        `你清楚：当前是群聊、对象是「${deptName}」、群里有谁、事情推进到哪（看群近期）。像聪明的微信群管家：先接住、再判断、该自己答就答、该派人就 @ 派出去。`,
        `本群可点名：${rosterLine}`,
        `硬规则：`,
        `1. 口语回群；不要问「要不要转到这儿」。`,
        `2. 能直接答的（进度、协调、澄清、拍板建议）自己说清楚；需要专人干的，在同一条回复里写「@角色名 + 具体交代」叫醒对方（可一次 @ 多人，每人一段）。`,
        `3. 不要把用户踢去「请你自己 @某某」——你就是来分流的。`,
        `4. 可调工具查证/派工；工具派了人，正文仍要 @，群里才看得见。`,
        `5. 【纯文本】像微信：禁止 Markdown（# * ** 表格 代码块）。`,
      ].join('\n'),
    )
  } else {
    parts.push(
      [
        `【部门群聊 · ${deptName} · 强制】你正在常驻部门群里被点名。`,
        `硬规则（违反即协作中断）：`,
        `1. 你的回复会出现在群时间线；请口语直接回群，不要问「要不要转到这儿」。`,
        `2. 【关键】同事不会自动知道你要他干什么。要谁继续干，必须在回复正文里写「@角色名 + 具体交代」。系统只认正文 @ 才会叫醒对方；只建任务/只调转交工具、正文不 @ → 对方不会在本群出现。`,
        `3. 可以正常调工具做实质工作；若工具里也派了下级，仍必须在同一条回复里 @ 对方，让群里看得见接力。`,
        `4. 禁止只报任务号/派单号却不 @；禁止把群聊当成私聊收件箱。`,
        `5. 【纯文本】群聊像微信：只输出普通文字。禁止 Markdown（不要 # 标题、* /** 加粗斜体、\` 代码、代码块、| 表格、清单符号）。列举用中文逗号或换行。`,
      ].join('\n'),
    )
  }
  if (opts.fromAgentName) {
    parts.push(`（「${opts.fromAgentName}」在群里 @ 了你，请直接回群）`)
  }
  const groupCtx = String(opts.groupContext || '').trim()
  if (groupCtx) {
    parts.push(`【群近期】\n${groupCtx.slice(0, 2400)}`)
  }
  parts.push(stewardMode ? `【用户对群说（未点名，请你接住）】\n${goal}` : `【本条消息】\n${goal}`)
  const userText = parts.join('\n\n')

  let collected = ''
  let finalText = ''
  const handoffMap = new Map<string, DeptGroupHandoff>()

  const ingestHandoffs = (raw: unknown) => {
    for (const h of extractDeptGroupHandoffs(raw)) {
      if (h.agentCode === code) continue
      const prev = handoffMap.get(h.agentCode)
      if (!prev || (h.content && h.content.length > (prev.content || '').length)) {
        handoffMap.set(h.agentCode, h)
      }
    }
  }

  const unsub = wsClient.onEvent((msg: any) => {
    if (msg?.type !== 'event' || msg?.event !== 'chat') return
    const p = msg.payload
    if (!p || String(p.sessionKey || '') !== sk) return
    if (opts.signal?.aborted) return
    const st = String(p.state || '')
    if (st === 'tool' || st === 'tool_result') {
      ingestHandoffs(p.data)
      ingestHandoffs(p.result)
      ingestHandoffs(p.output)
      ingestHandoffs(p.content)
      ingestHandoffs(p)
    } else if (st === 'delta') {
      const piece = extractAssistantText(p)
      if (piece) {
        if (String(p.streamTextMode || '') === 'piece') {
          collected = `${collected}${piece}`
        } else if (
          piece.length >= collected.length &&
          (!collected || piece.startsWith(collected.slice(0, Math.min(24, collected.length))))
        ) {
          collected = piece
        } else {
          collected = `${collected}${piece}`
        }
        opts.onDelta?.(collected)
      }
    } else if (st === 'final') {
      const t = extractAssistantText(p)
      if (t) {
        finalText = t
        collected = t
        opts.onDelta?.(t)
      }
    }
  })

  try {
    await api.chatSend(sk, userText)
  } finally {
    try {
      unsub?.()
    } catch {
      /* ignore */
    }
  }

  if (opts.signal?.aborted) {
    return { text: collected || finalText || '', handoffs: [...handoffMap.values()] }
  }

  let out = String(finalText || collected || '').trim()
  if (!out) {
    out = await loadLatestDeptMemberReply(sk)
  }
  return { text: out, handoffs: [...handoffMap.values()] }
}

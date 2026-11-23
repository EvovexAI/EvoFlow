/**
 * 部门群聊 @ 成员：复用 proactive 员工对话会话（全工具 harness + 多轮历史），
 * 不用会议 speak_in_meeting 口头模板。
 *
 * sessionKey 稳定为 ``proactive:{code}:chat:dept-{deptId}``，同一部门同一人始终续聊。
 */
import { api } from '../../lib/tauri-api.js'
import { normalizeChatToolPayloadToEntries } from '../../lib/chat-normalize.js'
import { formatActivityLabelsFromToolCalls } from '../../lib/tool-display.js'
import { deptChatSessionKey } from './dept-chat-session.js'
import {
  extractDeptGroupHandoffs,
  type DeptGroupHandoff,
} from './dept-group-handoff.js'
import { isTrivialGroupNestGoal } from './dept-group-nest-policy.js'
import {
  buildDeptGroupTurnUserText,
  type DeptGroupTurnHint,
} from './dept-group-turn.js'

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
   * 小V 群管家模式：显式 @ 小V，或无人 @ 且部门无负责人时的兜底。
   * 需知道本群花名册，才能灵活 @ 分派。
   */
  stewardMode?: boolean
  /**
   * 无人 @ 时由部门负责人默认承接（非小V管家）。
   * 走普通成员 prompt，另加一条「负责人接住」hint。
   */
  headDefaultCatcher?: boolean
  /** 本群成员（角色名），给管家提示「可以 @ 谁」 */
  roster?: Array<{ agent_code: string; role_name: string }>
  onDelta?: (text: string) => void
  /** 工具进行中一行摘要（群气泡「正在回复」下方 ticker） */
  onActivity?: (info: { kind: 'tool'; text: string }) => void
  signal?: { aborted?: boolean }
}

function liveToolLineFromChatPayload(payload: any): string {
  try {
    const entries = normalizeChatToolPayloadToEntries(payload) || []
    const labels = formatActivityLabelsFromToolCalls(entries)
    const last = labels.length ? String(labels[labels.length - 1] || '').trim() : ''
    if (last) return last
  } catch {
    /* fall through */
  }
  const data =
    payload?.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : payload
  const name = String(
    payload?.toolName ||
      payload?.tool_name ||
      (data && (data as { name?: string }).name) ||
      (data && (data as { tool_name?: string }).tool_name) ||
      (data && (data as { tool?: string }).tool) ||
      (data && (data as { toolCallName?: string }).toolCallName) ||
      '',
  ).trim()
  return name ? name.replace(/_/g, ' ') : ''
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
  const headDefaultCatcher = !!opts.headDefaultCatcher && !stewardMode
  const roster = Array.isArray(opts.roster) ? opts.roster : []
  const rosterNames = roster
    .map((m) => String(m.role_name || m.agent_code || '').trim())
    .filter(Boolean)
    .slice(0, 40)
  // 岗位思考 / 工作模型写在 role.config；群聊 sticky 原先不带 → 跟错默认。
  // 每轮从岗位回填，与 1:1 摘要面板一致（后端 apply_role_* 再兜底）。
  let roleRuntimePatch: Record<string, unknown> = {}
  try {
    const roleRes = await api.proactiveGetRole(code, { silent: true, skipRetry: true })
    const role = roleRes?.role || roleRes
    const cfg = role?.config && typeof role.config === 'object' ? role.config : {}
    const te = cfg.thinking_enabled
    if (te === true || te === false) {
      roleRuntimePatch = {
        ...roleRuntimePatch,
        thinking_enabled: te,
        thinking_type: 'manual',
        reasoning_effort: te ? 'medium' : 'minimum',
      }
    }
    const model = String(cfg.model_name || '').trim()
    if (model && model.toLowerCase() !== 'default') {
      // 配置类回填必须带 model_pinned=0（写入纪律，docs/design/model-resolution.md）：
      // 否则会被当成用户 pin，岗位改模型后 sticky 会话跟不过去。
      roleRuntimePatch = { ...roleRuntimePatch, model_name: model, model_pinned: false }
    }
  } catch {
    /* 岗位拉不到时交给后端 apply_role_*_to_run_cfg */
  }

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
    // 花名册进系统提示（dept_group_im）；勿再塞进用户消息
    dept_group_roster: rosterNames,
    ...roleRuntimePatch,
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

  // 群身份 / 硬规则 / 花名册已由 sessionCtx → 系统提示 <dept_group_im> 注入。
  // 本轮 user 文本用 <dept_group_turn> 标签分层：hint/recent 仅给模型；
  // instruction 才是用户可见指令（前端 extractDeptGroupVisibleUserText 剥离展示）。
  const trivialGoal = isTrivialGroupNestGoal(goal)
  const hints: DeptGroupTurnHint[] = []
  if (opts.fromAgentName) {
    hints.push({
      kind: 'from_agent',
      text: `「${opts.fromAgentName}」在群里 @ 了你，请直接回群`,
    })
  }
  if (stewardMode) {
    hints.push({
      kind: 'steward',
      text: '请你以群管家身份接住本条（显式点名或部门暂无负责人时的兜底）。',
    })
  } else if (headDefaultCatcher) {
    hints.push({
      kind: 'behavior',
      text:
        '用户未 @ 任何人；你是本部门负责人，请先接住本条。'
        + '能自己答就答；确实需要专人时再在正文 @ 岗位名交代。'
        + '对用户说话用岗位名，不要写内部编码。',
    })
    if (trivialGoal) {
      hints.push({
        kind: 'behavior',
        text:
          '本条偏打招呼/报到：一两句回应即可，不要展开旧任务，也不要借机给下级派活。',
      })
    }
  } else if (trivialGoal) {
    hints.push({
      kind: 'behavior',
      text:
        '本条只是打招呼/报到/回一声。用一两句说清你是谁、平时干什么即可；'
        + '禁止汇报进度、禁止展开记忆/站立摘要/群近期里的旧任务、'
        + '禁止 @ 同事派活。用户可见正文只用岗位名，不要写内部编码。',
    })
  } else {
    hints.push({
      kind: 'behavior',
      text:
        '把该你说的说完即可。打招呼/报到不要再 @ 同事或小V；'
        + '只有本轮明确要推进的新活才 @，且不要重复点名已经出过面的人。'
        + '对用户说话用岗位名，不要写 agent_code / 内部编码。',
    })
  }
  const groupCtx = String(opts.groupContext || '').trim()
  const recent = groupCtx
    ? trivialGoal
      ? groupCtx.slice(0, 400)
      : groupCtx.slice(0, 2400)
    : ''
  const userText = buildDeptGroupTurnUserText({
    instruction: goal,
    stewardMode,
    recent,
    recentSummary: trivialGoal && !!recent,
    hints,
  })

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
      if (st === 'tool') {
        const line = liveToolLineFromChatPayload(p)
        if (line) opts.onActivity?.({ kind: 'tool', text: line })
      }
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

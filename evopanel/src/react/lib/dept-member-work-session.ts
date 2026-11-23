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

export const DEPT_DESIGN_BRIEF_HINT = '门店设计任务：先对齐门店、具体部位、找原图还是重新绘制，并确认可用的图号或版本。已有明确答案就沿用，不重复确认；关键项不明时合并问一句，确认前不派工、不绘图。不得把柜面圆盘和背墙圆盘当成同一对象。找原图只检索和交付原文件，不自行重绘；明确要求绘图才制作。派工写清上述范围；接手时复述同一任务范围，不擅自更换部位或图号。状态查询、聊天验收和寒暄直接回应，不启动新设计任务。'

/** Only standalone courtesies or bounded literal echoes may bypass tools. */
export function isLightweightDeptTurn(text: string): boolean {
  const t = String(text || '').trim()
  if (/^(你好|您好|嗨|在吗|收到|谢谢|多谢|好的|好|ok)[！!。.?？\s]*$/i.test(t)) return true
  return /^(?:群聊回填验收\s+[\w-]+[：:]\s*)?(?:只|仅)回复[“「"][^”」"\n]{1,100}[”」"](?:[，,]不要查资料、调用工具、绘图或点名任何同事[。.]?)?[。.!！\s]*$/.test(t)
}

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

async function loadDeptMemberHistory(workSessionKey: string): Promise<any[]> {
  const hist = await api.chatHistory(workSessionKey, 200, { bypassCache: true })
  return Array.isArray(hist?.messages) ? hist.messages : Array.isArray(hist) ? hist : []
}

type ReplyFence = { runId?: string; afterSeq?: number }

function belongsToTurn(row: any, fence: ReplyFence): boolean {
  const runId = String(row.runId || row.run_id || '').trim()
  if (fence.runId) return runId === fence.runId
  return fence.afterSeq != null && Number(row.seq) > fence.afterSeq
}

/** Legacy timeline recovery only; dispatch must use the current turn's result. */
export async function loadLatestDeptMemberReply(workSessionKey: string): Promise<string> {
  const sk = String(workSessionKey || '').trim()
  if (!sk) return ''
  try {
    const rows = await loadDeptMemberHistory(sk)
    for (let i = rows.length - 1; i >= 0; i--) {
      const t = extractHistoryAssistantText(rows[i])
      if (t) return t
    }
  } catch {
    /* A missing history is not evidence that the run completed. */
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

  const perfStartedAt = Date.now()
  const turnPerf: Record<string, any> = {
    sessionKey: sk, agentCode: code, startedAt: perfStartedAt,
    mode: isLightweightDeptTurn(goal) ? 'ask' : 'agent',
    stageMs: {}, historyReads: 0, historyRows: 0, historyReadMs: 0, statusReads: 0,
  }
  // Numeric diagnostics only: never retain a prompt, message body or credentials.
  const perfRing = ((globalThis as any).__evoflowDeptTurnPerf ||= [])
  perfRing.push(turnPerf)
  if (perfRing.length > 32) perfRing.splice(0, perfRing.length - 32)
  const markPerf = (stage: string) => { turnPerf.stageMs[stage] = Date.now() - perfStartedAt }
  const readHistory = async () => {
    const start = Date.now()
    turnPerf.historyReads++
    const rows = await loadDeptMemberHistory(sk)
    turnPerf.historyRows += rows.length
    turnPerf.historyReadMs += Date.now() - start
    return rows
  }
  markPerf('start')

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

  markPerf('role_ready')
  const sessionCtx = {
    source: 'proactive',
    proactive_agent_code: code,
    agent_id: code,
    agent_name: roleName,
    employee_talk_mode: 'chat',
    workspace_kind: 'chat',
    session_mode: turnPerf.mode,
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

  markPerf('session_ready')
  try {
    await wsClient.updateSessionContext?.(sk, sessionCtx)
  } catch {
    /* optional */
  }

  markPerf('context_ready')
  // 群身份 / 硬规则 / 花名册已由 sessionCtx → 系统提示 <dept_group_im> 注入。
  // 本轮 user 文本用 <dept_group_turn> 标签分层：hint/recent 仅给模型；
  // instruction 才是用户可见指令（前端 extractDeptGroupVisibleUserText 剥离展示）。
  const trivialGoal = isTrivialGroupNestGoal(goal)
  const hints: DeptGroupTurnHint[] = []
  if (!trivialGoal && (deptName.includes('门店设计') || code.endsWith('construction-drafting'))) {
    hints.push({ kind: 'behavior', text: DEPT_DESIGN_BRIEF_HINT })
  }
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

  let afterSeq: number | undefined
  try {
    const rows = await readHistory()
    afterSeq = Math.max(0, ...rows.map((row) => Number(row.seq) || 0))
  } catch {
    /* Run-id matching remains available if history cannot be read. */
  }
  markPerf('history_baseline_ready')
  let targetRunId = ''
  let finalSeen = false
  let streamError = ''
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
    const eventRunId = String(p.runId || p.run_id || '').trim()
    if (targetRunId && eventRunId !== targetRunId) return
    const st = String(p.state || '')
    if (st === 'error' || st === 'aborted') {
      streamError = String(p.errorMessage || p.error || '本轮回复已中断')
    }
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
        if (turnPerf.stageMs.first_visible_text == null) markPerf('first_visible_text')
        opts.onDelta?.(collected)
      }
    } else if (st === 'final') {
      const t = extractAssistantText(p)
      if (t) {
        finalSeen = true
        finalText = t
        collected = t
        if (turnPerf.stageMs.first_visible_text == null) markPerf('first_visible_text')
        opts.onDelta?.(t)
      }
    }
  })

  try {
    if (opts.signal?.aborted) return { text: '', handoffs: [] }
    markPerf('send_started')
    const sent = await api.chatSend(sk, userText)
    markPerf('send_returned')
    turnPerf.awaitingV4 = !!sent?.awaitingV4
    if (sent?.ok === false) throw new Error(String(sent.error || '发送失败'))
    if (sent?.aborted) throw new Error('本轮回复已中断')
    // A live SSE handoff returns before the backend finishes. Keep the listener
    // alive and read only this run until its final event / execution terminal state.
    targetRunId = sent?.awaitingV4 ? String(sent.runId || '').trim() : ''
    if (sent?.awaitingV4) {
      if (!targetRunId) throw new Error('回复接管缺少运行标识')
      // Before the handoff identifies the backend run, an old sticky-session
      // event may still arrive. Rebuild from this run's events/history only.
      finalSeen = false
      finalText = ''
      collected = ''
      streamError = ''
      handoffMap.clear()
    }
    const fence = { runId: targetRunId || undefined, afterSeq }
    const deadline = Date.now() + 10 * 60 * 1000
    let terminalReads = 0
    while (!opts.signal?.aborted) {
      if (streamError) throw new Error(streamError)
      if (finalSeen) break
      let status: any = null
      if (sent?.awaitingV4) {
        try {
          turnPerf.statusReads++
          status = await wsClient.getSessionRunStatus(sk)
        } catch {
          /* An unavailable status must not become a false idle/empty reply. */
        }
      }
      const completedId = String(
        status?.recently_completed_run_id === targetRunId ? targetRunId : status?.runId || '',
      )
      const phase = String(
        status?.recently_completed_run_id === targetRunId
          ? status?.recently_completed_status || status?.status
          : status?.status || '',
      ).toLowerCase()
      const terminal = !status?.executing && completedId === targetRunId &&
        ['done', 'completed', 'success', 'error', 'failed', 'cancelled', 'aborted', 'interrupted'].includes(phase)
      if (terminal && ['error', 'failed', 'cancelled', 'aborted', 'interrupted'].includes(phase)) {
        throw new Error(`本轮回复未完成：${phase}`)
      }
      let historyText = ''
      let historyCompleted = false
      // Running runs cannot yield a final dispatch result. Avoid repeatedly
      // transferring the full transcript while the status already says running.
      const mayReadHistory = !sent?.awaitingV4 || terminal ||
        (!status?.executing && status?.status === 'done')
      try {
        const rows = mayReadHistory ? (await readHistory()).filter((row) => belongsToTurn(row, fence)) : []
        const lastRow = rows[rows.length - 1]
        historyCompleted = !!lastRow &&
          ['assistant', 'ai'].includes(String(lastRow.role).toLowerCase()) &&
          String(lastRow.turn_state || lastRow.turnState || '') === 'completed' &&
          !!extractHistoryAssistantText(lastRow)
        for (const row of rows) {
          if (String(row.role).toLowerCase() === 'tool') {
            ingestHandoffs(row.content_json || row.contentJson || row.content)
          }
          const text = extractHistoryAssistantText(row)
          if (text) historyText = text
        }
      } catch {
        /* Keep waiting for the authoritative event/status. */
      }
      if (finalSeen) break
      // Desktop execution/state clears runId on completion and may not retain
      // recently_completed. A durable final row for our exact run still proves
      // completion; idle/unavailable status or another run's row never does.
      const completedWithoutRunId = status?.status === 'done' && !status?.runId &&
        !status?.executing && historyCompleted
      if (!sent?.awaitingV4 || terminal || completedWithoutRunId) {
        if (historyText) {
          finalText = historyText
          if (turnPerf.stageMs.first_visible_text == null) markPerf('first_visible_text')
        }
        if (!sent?.awaitingV4 || historyText || ++terminalReads >= 3) break
      }
      if (Date.now() >= deadline) throw new Error('等待本轮回复超时，请查看员工处理过程')
      await new Promise((resolve) => setTimeout(resolve, 750))
    }
    markPerf('result_ready')
    return {
      text: String(finalText || collected || '').trim(),
      handoffs: [...handoffMap.values()],
    }
  } finally {
    markPerf('finished')
    turnPerf.elapsedMs = Date.now() - perfStartedAt
    unsub?.()
  }
}

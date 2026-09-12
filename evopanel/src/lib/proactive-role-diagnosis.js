/**
 * 智能体员工「失败说人话」诊断条：一句话原因 + 可点动作。
 * 纯前端聚合 dashboard / 待审批 / 工作项信号，不新增后端接口。
 */

/** @typedef {{
 *   code: string,
 *   level: 'urgent'|'warn'|'info',
 *   title: string,
 *   detail?: string,
 *   actions: { id: string, label: string }[],
 * }} RoleDiagnosis */

function reportsIncompleteJournal(init) {
  if (!init || typeof init !== 'object') return false
  const plan = init.action_plan
  if (plan && typeof plan === 'object' && plan.incomplete === true) return true
  const desc = String(init.description || '')
  // 兼容历史文案「交班汇报」与新文案「工作汇报」
  if (/【(?:交班|工作)汇报·未完成】/.test(desc)) return true
  const goal = String(init.goal || init.title || '')
  if (/自动交班·未完成|本轮汇报未写完|中断·未完成|未完整收尾/.test(goal)) return true
  const phase = String(plan?.phase || init.phase || '').toLowerCase()
  if (String(init.status || '') === 'failed' && phase === 'wrap_up') return true
  return false
}

/**
 * @param {{
 *   agentCode?: string,
 *   dash?: object|null,
 *   pendingApprovalCount?: number,
 *   initiatives?: object[],
 *   noWorkspace?: boolean,
 *   isDraft?: boolean,
 *   isPaused?: boolean,
 * }} input
 * @returns {RoleDiagnosis[]}
 */
export function diagnoseRole(input = {}) {
  const dash = input.dash || null
  const pendingN = Number(input.pendingApprovalCount || 0)
  const initiatives = Array.isArray(input.initiatives) ? input.initiatives : []
  const out = []

  if (input.isDraft) {
    out.push({
      code: 'draft',
      level: 'info',
      title: '草稿未确认',
      detail: '确认上班后才会按频率自动干活',
      actions: [{ id: 'edit', label: '编辑岗位' }],
    })
    return out
  }

  if (pendingN > 0) {
    out.push({
      code: 'pending_approval',
      level: 'urgent',
      title: `${pendingN} 项待你审批`,
      detail: '常见是转交同事前的「同意派发」；卡住时先清这里',
      actions: [
        { id: 'approvals', label: '去待审批' },
        { id: 'worklog', label: '打开员工' },
      ],
    })
  }

  const zombie = Number(dash?.zombie_executing_count || 0)
  if (zombie > 0) {
    out.push({
      code: 'zombie',
      level: zombie > 5 ? 'urgent' : 'warn',
      title: `${zombie} 条卡住执行`,
      detail: '执行超过约 45 分钟仍未结束，先看工作过程再决定取消或重开',
      actions: [
        { id: 'live', label: '工作过程' },
        { id: 'worklog', label: '上班记录' },
        { id: 'tasks', label: '任务列表' },
      ],
    })
  }

  const incomplete = initiatives.filter((i) => reportsIncompleteJournal(i))
  if (incomplete.length) {
    out.push({
      code: 'wrap_incomplete',
      level: 'warn',
      title: '本轮汇报没写完',
      detail: '最近一轮下班小结没写完，可点「现在开始工作」续跑，或打开工作过程查看',
      actions: [
        { id: 'patrol', label: '现在开始工作' },
        { id: 'live', label: '工作过程' },
        { id: 'worklog', label: '看本轮' },
      ],
    })
  }

  const noopN = Number(dash?.consecutive_noop_count || 0)
  const idle =
    !!dash?.idle_suspected || noopN >= 3 || Number(dash?.no_op_pct || 0) >= 40
  if (!input.isPaused && idle && pendingN === 0) {
    out.push({
      code: 'idle',
      level: 'warn',
      title: noopN > 0 ? `近期没干活（连续 ${noopN} 轮）` : '近期没干活',
      detail: '试着点「现在开始工作」，或把职责写得更具体再观察',
      actions: [
        { id: 'patrol', label: '现在开始工作' },
        { id: 'edit', label: '改职责' },
        { id: 'live', label: '工作过程' },
      ],
    })
  }

  // Workspace is optional (system default). Card already shows「默认工作区」chip —
  // do not add a second「指定目录」diagnosis strip that looks like a required picker.

  // At most 3 chips to avoid clutter
  return out.slice(0, 3)
}

/**
 * @param {RoleDiagnosis[]} diags
 * @param {{ esc: (s: any) => string, code: string, compact?: boolean }} opts
 */
export function renderRoleDiagnosisHtml(diags, { esc, code, compact = false } = {}) {
  const list = Array.isArray(diags) ? diags : []
  if (!list.length || !code) return ''
  const items = list
    .map((d) => {
      const acts = (d.actions || [])
        .map(
          (a) =>
            `<button type="button" class="pro-diag-act" data-action="diag" data-diag-act="${esc(a.id)}" data-code="${esc(code)}">${esc(a.label)}</button>`,
        )
        .join('')
      return `
        <div class="pro-diag-item pro-diag-item--${esc(d.level || 'info')}" data-diag-code="${esc(d.code)}">
          <div class="pro-diag-copy">
            <strong class="pro-diag-title">${esc(d.title)}</strong>
            ${
              !compact && d.detail
                ? `<span class="pro-diag-detail">${esc(d.detail)}</span>`
                : ''
            }
          </div>
          <div class="pro-diag-actions">${acts}</div>
        </div>`
    })
    .join('')
  return `<div class="pro-diag" data-role-diag="${esc(code)}" role="status">${items}</div>`
}

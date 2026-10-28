/**
 * 员工「交工审核」文案与选项（autonomy_level）。
 *
 * 后端仍是三档；加人表单只暴露「需要审核 / 无需审核」两档，避免「谨慎型/平衡型」费解。
 * 编辑页保留中间档，便于已有岗位微调。
 */

/** @typedef {'full_auto'|'approval_for_risky'|'approval_for_all'} AutonomyLevel */

export const AUTONOMY_FIELD_LABEL = '交工审核'

/** 字段旁固定说明：选完后会发生什么 */
export const AUTONOMY_FIELD_DESC =
  '管的是：本岗干完、要交给下游同事时，要不要先等你点「同意派发」。单岗、无下游时通常碰不到。新开任务默认仍会直接开跑。'

export const AUTONOMY_LABELS = {
  full_auto: '无需审核',
  approval_for_risky: '有风险才审',
  approval_for_all: '需要审核',
}

export const AUTONOMY_HINTS = {
  full_auto:
    '结案转交下游时自动派发；仅极高风险才会拦住问你。适合流程已稳、少人工判断的岗位。',
  approval_for_risky:
    '结案转交下游时：中风险及以上须你点「同意派发」；低风险自动派。适合多数日常岗位。',
  approval_for_all:
    '结案转交下游时一律先等你点「同意派发」再叫醒下级。上手推荐；批完才进入下一步。',
}

/** 加人弹窗：两档（映射后端 full_auto / approval_for_all） */
export const AUTONOMY_HIRE_OPTIONS = [
  { value: 'approval_for_all', label: AUTONOMY_LABELS.approval_for_all },
  { value: 'full_auto', label: AUTONOMY_LABELS.full_auto },
]

/** 编辑弹窗：三档全开 */
export const AUTONOMY_EDIT_OPTIONS = [
  { value: 'approval_for_all', label: AUTONOMY_LABELS.approval_for_all },
  { value: 'approval_for_risky', label: AUTONOMY_LABELS.approval_for_risky },
  { value: 'full_auto', label: AUTONOMY_LABELS.full_auto },
]

/**
 * 加人表单若只挂两档，把「有风险才审」收成「需要审核」，避免芯片选不中。
 * @param {string} value
 * @returns {AutonomyLevel}
 */
export function normalizeAutonomyForHire(value) {
  const v = String(value || '').trim()
  if (v === 'full_auto') return 'full_auto'
  return 'approval_for_all'
}

/**
 * @param {string} value
 * @returns {string}
 */
export function autonomyLabel(value) {
  const v = String(value || '').trim()
  return AUTONOMY_LABELS[v] || v || '—'
}

/**
 * @param {string} value
 * @returns {string}
 */
export function autonomyHint(value) {
  const v = String(value || '').trim()
  return AUTONOMY_HINTS[v] || AUTONOMY_HINTS.approval_for_all
}

/**
 * @param {{ value: string, label: string }[]} options
 * @param {string} selected
 * @returns {string}
 */
export function renderAutonomyChips(options, selected) {
  const on = String(selected || '').trim()
  return options
    .map((opt) => {
      const active = opt.value === on
      return `<button type="button" class="hire-chip${active ? ' is-on' : ''}" data-value="${opt.value}">${opt.label}</button>`
    })
    .join('')
}

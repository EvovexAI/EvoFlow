/**
 * Publish readiness — soft warnings over hard blocks.
 * Only block when the app cannot run at all (zero steps).
 */
import { showContentModal } from '../components/modal.js'

const PLACEHOLDER_GOALS = [
  '用白话写这一步要完成的事',
  '请配置具体任务目标',
]

/**
 * @param {{ steps?: unknown[], answer_from_ref?: string, goal?: string }} plan
 * @param {unknown[]} [parameters]
 * @returns {{ blockers: string[], warnings: string[] }}
 */
export function assessPublishReadiness(plan, parameters = []) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : []
  const blockers = []
  const warnings = []

  if (!steps.length) {
    blockers.push('至少需要一个智能体步骤，才能发布后运行。')
    return { blockers, warnings }
  }

  const answerRef = String(plan?.answer_from_ref || '').trim()
  if (!answerRef) {
    warnings.push('未指定「最终答案」来源：运行页/接口会用系统默认汇总（可选，不连也能跑）。')
  } else {
    const hit = steps.some((s) => String(s?.ref || '') === answerRef)
    if (!hit) {
      warnings.push(`「最终答案」指向的步骤 ${answerRef} 已不存在，将回退为默认汇总。`)
    }
  }

  const vague = steps.filter((s) => {
    const g = String(s?.goal || '').trim()
    return !g || PLACEHOLDER_GOALS.includes(g)
  })
  if (vague.length === steps.length) {
    warnings.push('步骤说明还是占位文案：建议先写清「做什么」，否则跑出来效果会偏空。')
  } else if (vague.length > 0) {
    warnings.push(`${vague.length} 个步骤的说明仍是占位文案，可稍后在画布改。`)
  }

  const params = Array.isArray(parameters) ? parameters : []
  const required = params.filter((p) => p && p.required !== false && String(p.name || '').trim())
  if (required.length) {
    const corpus = [
      String(plan?.goal || ''),
      ...steps.map((s) =>
        [s?.goal, s?.name, s?.description, s?.inputs, s?.outputs, s?.instruction]
          .map((x) => String(x || ''))
          .join('\n'),
      ),
    ].join('\n')
    const unused = required
      .map((p) => String(p.name).trim())
      .filter((name) => !corpus.includes(`{{${name}}}`))
    if (unused.length === required.length) {
      warnings.push(
        `已配置运行参数（${unused.slice(0, 3).join('、')}${unused.length > 3 ? '…' : ''}），但步骤说明里还没引用。运行页仍会让用户填写；需要时在步骤里点芯片插入。`,
      )
    }
  }

  return { blockers, warnings }
}

/**
 * @param {string[]} warnings
 * @returns {Promise<boolean>} true = continue publish
 */
export function confirmPublishWarnings(warnings) {
  const list = Array.isArray(warnings) ? warnings.filter(Boolean) : []
  if (!list.length) return Promise.resolve(true)

  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      resolve(ok)
    }

    const items = list.map((w) => `<li style="margin:0 0 6px">${escapeHtml(w)}</li>`).join('')
    const overlay = showContentModal({
      title: '发布前提示',
      width: 480,
      content: `
        <p style="margin:0 0 10px;font-size:13px;line-height:1.55;color:var(--text-secondary)">
          以下不影响发布，确认无误可继续；也可以先回去改。
        </p>
        <ul style="margin:0;padding-left:1.2em;font-size:13px;line-height:1.55;color:var(--text-secondary)">
          ${items}
        </ul>
      `,
      buttons: [{ label: '仍要发布', className: 'btn btn-primary btn-sm', id: 'btn-pub-anyway' }],
    })

    const cancel = overlay.querySelector('[data-action="cancel"]')
    if (cancel) cancel.textContent = '回去改'

    overlay.querySelector('#btn-pub-anyway')?.addEventListener('click', () => {
      overlay.close()
      finish(true)
    })
    cancel?.addEventListener('click', () => finish(false), { once: true })
    overlay.addEventListener(
      'click',
      (e) => {
        if (e.target === overlay) finish(false)
      },
      { once: true },
    )
  })
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

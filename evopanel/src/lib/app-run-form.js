/**
 * Form-first App run helper — list/detail share the same parameter modal.
 * List「运行」must NOT open the canvas editor.
 */
import { api } from './tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm, showContentModal } from '../components/modal.js'

const PARAM_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g

/**
 * Client-side {{param}} preview (mirrors backend _render_text).
 * @param {string} text
 * @param {Record<string, string>} values
 */
export function previewRenderText(text, values) {
  const src = String(text || '')
  if (!src) return ''
  return src.replace(PARAM_RE, (_, key) => {
    const v = values?.[key]
    if (v == null || String(v).trim() === '') return `〈未填 · ${key}〉`
    return String(v)
  })
}

/**
 * @param {object} p AppParameter
 * @returns {{ name: string, label: string, type?: string, value: string, placeholder?: string, required?: boolean, options?: {value:string,label:string}[], hint?: string, rows?: number }}
 */
function isNoiseDescription(text) {
  const s = String(text || '').trim()
  if (!s) return true
  return /auto[- ]?extracted|file_path parameter|parameter extracted/i.test(s)
}

export function paramToField(p) {
  const name = String(p?.name || p?.key || '').trim()
  const label = String(p?.label || p?.name || name).trim() || name
  const required = p?.required !== false
  const type = String(p?.type || 'text').toLowerCase()
  const desc = String(p?.description || '').trim()
  const cleanHint = desc && desc !== label && !isNoiseDescription(desc) ? desc : undefined
  const base = {
    name,
    label,
    required,
    value: p?.default != null ? String(p.default) : '',
    placeholder: cleanHint || `请输入${label}`,
    hint: cleanHint,
  }
  if (type === 'textarea') return { ...base, type: 'textarea', rows: 3 }
  if (type === 'number') {
    return {
      ...base,
      type: 'text',
      placeholder: base.placeholder || '数字',
      hint: [base.hint, '请填写数字'].filter(Boolean).join(' · ') || undefined,
    }
  }
  if (type === 'select' && Array.isArray(p?.options) && p.options.length) {
    return {
      ...base,
      type: 'select',
      options: p.options.map((o) =>
        typeof o === 'string'
          ? { value: o, label: o }
          : { value: String(o?.value ?? o), label: String(o?.label ?? o?.value ?? o) },
      ),
      value: base.value || String(p.options[0]?.value ?? p.options[0] ?? ''),
    }
  }
  return base
}

/**
 * Collect parameter values from modal result; validate required + number.
 * @returns {{ ok: true, values: Record<string,string> } | { ok: false, missing: string[], invalid?: string[] }}
 */
export function collectParamValues(params, result) {
  const list = Array.isArray(params) ? params : []
  const missing = []
  const invalid = []
  const values = {}
  for (const p of list) {
    const key = String(p?.name || p?.key || '').trim()
    if (!key) continue
    const raw = result?.[key]
    const val = raw == null ? '' : String(raw).trim()
    values[key] = val
    if (p?.required !== false && !val) {
      missing.push(String(p?.label || p?.name || key))
      continue
    }
    if (val && String(p?.type || '').toLowerCase() === 'number' && Number.isNaN(Number(val))) {
      invalid.push(String(p?.label || p?.name || key))
    }
  }
  if (missing.length || invalid.length) {
    return { ok: false, missing, invalid }
  }
  return { ok: true, values }
}

/** Human label for app.execution_mode */
export function executionModeLabel(mode) {
  return String(mode || 'workflow') === 'lead_supervised'
    ? '先生成计划再确认'
    : '按步骤自动跑完'
}

/**
 * Serialize parameters for settings textarea.
 * Format: name|label|type|default|required[|opt1,opt2]
 */
export function serializeParamsForEditor(params) {
  const list = Array.isArray(params) ? params : []
  if (!list.length) return ''
  return list
    .map((p) => {
      const name = String(p?.name || '').trim()
      const label = String(p?.label || name).trim()
      const type = String(p?.type || 'text').trim() || 'text'
      const def = String(p?.default ?? '')
      const req = p?.required === false ? '0' : '1'
      const opts = Array.isArray(p?.options)
        ? p.options.map((o) => (typeof o === 'string' ? o : o?.value ?? o)).filter(Boolean).join(',')
        : ''
      const base = `${name}|${label}|${type}|${def}|${req}`
      return type === 'select' && opts ? `${base}|${opts}` : base
    })
    .join('\n')
}

/**
 * Parse settings textarea back into AppParameter[].
 */
export function parseParamsFromEditor(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const out = []
  for (const line of lines) {
    const parts = line.split('|').map((s) => s.trim())
    const name = parts[0] || ''
    if (!name) continue
    const label = parts[1] || name
    const type = parts[2] || 'text'
    const def = parts[3] ?? ''
    const reqRaw = parts[4]
    const required = reqRaw === undefined || reqRaw === '' || reqRaw === '1' || reqRaw === 'true'
    const normalizedType = ['text', 'textarea', 'select', 'number'].includes(type) ? type : 'text'
    /** @type {Record<string, unknown>} */
    const param = {
      name,
      label,
      type: normalizedType,
      default: def,
      required,
      description: '',
    }
    if (normalizedType === 'select' && parts[5]) {
      param.options = parts[5]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    out.push(param)
  }
  return out
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fieldControlHtml(field) {
  const name = escapeHtml(field.name)
  const value = escapeHtml(field.value ?? '')
  const ph = escapeHtml(field.placeholder || '')
  const idAttr = field.id ? ` id="${escapeHtml(field.id)}"` : ''
  if (field.type === 'textarea') {
    return `<textarea class="app-run-prompt-input"${idAttr} data-name="${name}" rows="${field.rows || 3}" placeholder="${ph}">${value}</textarea>`
  }
  if (field.type === 'select' && Array.isArray(field.options)) {
    const opts = field.options
      .map((o) => {
        const v = escapeHtml(o.value)
        const sel = String(o.value) === String(field.value) ? ' selected' : ''
        return `<option value="${v}"${sel}>${escapeHtml(o.label)}</option>`
      })
      .join('')
    return `<select class="app-run-prompt-input"${idAttr} data-name="${name}">${opts}</select>`
  }
  return `<input class="app-run-prompt-input"${idAttr} data-name="${name}" value="${value}" placeholder="${ph}">`
}

function readFormValues(root) {
  const result = {}
  root.querySelectorAll('[data-name]').forEach((el) => {
    result[el.dataset.name] = el.value
  })
  return result
}

function fieldsHtml(fields) {
  return fields
    .map(
      (f) => `
      <div class="app-run-prompt-field">
        <label class="app-run-prompt-label" for="app-run-field-${escapeHtml(f.name)}">
          <span>${escapeHtml(f.label)}${f.required !== false ? ' <span class="app-run-prompt-star" aria-hidden="true">*</span>' : ''}</span>
        </label>
        ${fieldControlHtml({ ...f, id: `app-run-field-${f.name}` })}
        <div class="app-run-prompt-key">参数名：<code>${escapeHtml(f.name)}</code></div>
        ${f.hint ? `<div class="app-run-prompt-hint">${escapeHtml(f.hint)}</div>` : ''}
      </div>`,
    )
    .join('')
}

/**
 * Prompt for parameters (single-column), optionally persist defaults, then runApp.
 */
export async function promptAndRunApp(app, opts = {}) {
  const appId = app?.id
  if (!appId) {
    toast.error('无效工作流')
    return null
  }
  const params = Array.isArray(app.parameters) ? app.parameters : []
  const mode = app.execution_mode || 'workflow'
  const goalTemplate = String(app.goal_template || app.plan?.goal || '').trim()
  const appName = String(app.name || '工作流').trim() || '工作流'
  const modeLabel = executionModeLabel(mode)

  const doRun = async (values) => {
    try {
      if (opts.beforeRun) await opts.beforeRun()
      const result = await api.runApp(appId, {
        parameters: values,
        execution_mode: mode,
        run_kind: opts.runKind || 'debug',
        trigger_kind: opts.triggerKind || 'manual',
      })
      toast.success(
        mode === 'lead_supervised' ? '已生成计划，请在任务中确认执行' : '已开始运行',
      )
      opts.onStarted?.(result, values)
      return result
    } catch (e) {
      toast.error('运行失败: ' + (e?.message || e))
      return null
    }
  }

  const persistDefaults = async (values) => {
    const next = params.map((p) => {
      const key = String(p?.name || p?.key || '').trim()
      if (!key || !(key in values)) return p
      return { ...p, default: values[key] }
    })
    await api.updateApp(appId, { parameters: next })
    opts.onParamsSaved?.(next)
  }

  if (params.length === 0) {
    const ok = await showConfirm(
      `工作流「${appName}」无需填写参数，确认立即调试？\n执行方式：${modeLabel}`,
    )
    if (!ok) return null
    return doRun({})
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const fields = params.map(paramToField)
    const requiredCount = fields.filter((f) => f.required !== false).length
    const goalShort = goalTemplate.replace(/\s+/g, ' ').trim()
    const goalNeedsFold = goalShort.length > 96

    const overlay = showContentModal({
      title: '调试运行',
      subtitle: '填写运行参数并确认本次调试内容',
      width: 680,
      className: 'app-run-prompt-modal',
      overlayClass: 'app-run-prompt-overlay',
      content: `
        <div class="app-run-prompt">
          <section class="app-run-prompt-task">
            <div class="app-run-prompt-section-label">任务</div>
            <div class="app-run-prompt-task-name" title="${escapeHtml(appName)}">${escapeHtml(appName)}</div>
            ${
              goalShort
                ? `<p class="app-run-prompt-task-goal${goalNeedsFold ? ' is-clamp' : ''}" data-role="task-goal">${escapeHtml(goalShort)}</p>
                   ${goalNeedsFold ? `<button type="button" class="app-run-prompt-goal-more" data-act="toggle-goal">展开</button>` : ''}`
                : ''
            }
          </section>

          <section class="app-run-prompt-mode">
            <div class="app-run-prompt-section-label">执行方式</div>
            <div class="app-run-prompt-mode-value">● ${escapeHtml(modeLabel)}</div>
          </section>

          <section class="app-run-prompt-fields">
            <div class="app-run-prompt-fields-head">
              <span>运行参数</span>
              <span class="app-run-prompt-fields-count">${requiredCount} 个必填</span>
            </div>
            ${fieldsHtml(fields)}
          </section>

          <label class="app-run-prompt-save-defaults">
            <input type="checkbox" data-role="save-defaults" checked>
            <span>将本次参数设为默认值</span>
          </label>
        </div>
      `,
      buttons: [
        {
          label: '开始调试',
          className: 'btn btn-primary btn-sm',
          id: 'btn-app-run-confirm',
        },
      ],
    })

    const confirmBtn = overlay.querySelector('#btn-app-run-confirm')
    const saveDefaultsEl = overlay.querySelector('[data-role="save-defaults"]')
    const syncConfirmLabel = () => {
      if (!confirmBtn) return
      confirmBtn.textContent = saveDefaultsEl?.checked
        ? '保存参数并开始调试'
        : '开始调试'
    }
    saveDefaultsEl?.addEventListener('change', syncConfirmLabel)
    syncConfirmLabel()

    overlay.querySelector('[data-act="toggle-goal"]')?.addEventListener('click', (e) => {
      const goalEl = overlay.querySelector('[data-role="task-goal"]')
      const btn = e.currentTarget
      if (!goalEl || !btn) return
      const open = goalEl.classList.toggle('is-clamp') === false
      btn.textContent = open ? '收起' : '展开'
    })

    confirmBtn?.addEventListener('click', async () => {
      const collected = collectParamValues(params, readFormValues(overlay))
      if (!collected.ok) {
        const parts = []
        if (collected.missing?.length) parts.push('请填写: ' + collected.missing.join(', '))
        if (collected.invalid?.length) parts.push('数字无效: ' + collected.invalid.join(', '))
        toast.warning(parts.join('；'))
        return
      }
      confirmBtn.disabled = true
      try {
        if (saveDefaultsEl?.checked) {
          try {
            await persistDefaults(collected.values)
          } catch (e) {
            toast.warning('默认值未保存: ' + (e?.message || e))
          }
        }
        overlay.close()
        const runResult = await doRun(collected.values)
        finish(runResult)
      } finally {
        confirmBtn.disabled = false
      }
    })

    const onDismiss = () => finish(null)
    overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', onDismiss, {
      once: true,
    })
    overlay.querySelector('[data-action="dismiss"]')?.addEventListener('click', onDismiss, {
      once: true,
    })
    overlay.addEventListener(
      'click',
      (e) => {
        if (e.target === overlay) onDismiss()
      },
      { once: true },
    )
  })
}

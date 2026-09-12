/**
 * Shared schedule editor — AI + presets + next-run preview.
 * Client never displays raw cron / RRULE to users (stored internally only).
 *
 * Return shape used by cron.js / proactive.js / proactive-role-edit.js:
 *   { html, initEvents(root?), getSchedule() -> { cronExpr, ... } }
 */
import { api } from './tauri-api.js'
import { toast } from '../components/toast.js'

const esc = (s) =>
  !s
    ? ''
    : String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')

export function looksLikeCron(s) {
  const t = String(s || '').trim()
  if (!t || t.startsWith('@') || /FREQ=/i.test(t)) return false
  return t.split(/\s+/).length >= 5
}

function parseAiSchedulePayload(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  let jsonStr = raw
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) jsonStr = fence[1].trim()
  else {
    const brace = raw.match(/\{[\s\S]*\}/)
    if (brace) jsonStr = brace[0]
  }
  try {
    const obj = JSON.parse(jsonStr)
    const cron = String(obj.cron || obj.cron_expr || obj.expression || '').trim()
    const scheduledAt = String(obj.scheduled_at || obj.scheduledAt || '').trim()
    const summary = String(obj.summary || obj.description || '').trim()
    if (scheduledAt && !cron) return { cronExpr: '', scheduledAt, summary }
    if (cron) return { cronExpr: cron, scheduledAt: '', summary }
    if (summary) return { error: true, summary }
  } catch {
    /* fall through */
  }
  const cronOnly = raw.match(
    /\b([\d,\-\/]+|\*)\s+([\d,\-\/]+|\*)\s+([\d,\-\/\?]+|\*)\s+([\d,\-\/\?]+|\*)\s+([\d,\-\/\?A-Za-z]+|\*)\b/,
  )
  if (cronOnly) return { cronExpr: cronOnly[0], scheduledAt: '', summary: '' }
  return null
}

export function formatPreviewRunLabel(iso) {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return String(iso)
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return String(iso)
  }
}

export function formatPreviewRelative(iso, now = new Date()) {
  try {
    const d = new Date(iso)
    const diff = d.getTime() - now.getTime()
    if (diff < 0) return '已过期'
    const mins = Math.round(diff / 60000)
    if (mins < 60) return `${mins} 分钟后`
    const hours = Math.round(mins / 60)
    if (hours < 48) return `${hours} 小时后`
    return `${Math.round(hours / 24)} 天后`
  } catch {
    return ''
  }
}

/** Plain Chinese — never return raw cron / RRULE. */
export function cronToPlainZh(expr) {
  const raw = String(expr || '').trim()
  if (!raw) return '未设周期'
  if (!looksLikeCron(raw)) {
    if (/FREQ=/i.test(raw)) {
      if (/INTERVAL=1(?!\d)/i.test(raw) && /HOURLY/i.test(raw)) return '每小时'
      if (/INTERVAL=2(?!\d)/i.test(raw) && /HOURLY/i.test(raw)) return '每 2 小时'
      if (/INTERVAL=3(?!\d)/i.test(raw) && /HOURLY/i.test(raw)) return '每 3 小时'
      if (/MINUTELY/i.test(raw) && /INTERVAL=30/i.test(raw)) return '每 30 分钟'
      if (/MINUTELY/i.test(raw) && /INTERVAL=10/i.test(raw)) return '每 10 分钟'
      if (/DAILY/i.test(raw) && /BYHOUR=(\d+)/i.test(raw)) {
        const h = Number(RegExp.$1)
        return `每天 ${String(h).padStart(2, '0')}:00`
      }
    }
    if (!/FREQ=/i.test(raw) && raw.split(/\s+/).length < 5) return raw
  }
  const parts = raw.split(/\s+/)
  if (parts.length < 5) return '按计划自动上班'
  const [minF, hourF, domF, monF, dowF] = parts
  const star = (x) => x === '*' || x === '?'
  const min0 = minF === '0' || minF === '00'

  let m
  if ((m = hourF.match(/^\*\/(\d+)$/)) && star(domF) && star(monF) && star(dowF)) {
    const n = Number(m[1])
    return n <= 1 ? '每小时' : `每 ${n} 小时`
  }
  if ((m = hourF.match(/^(\d{1,2})-(\d{1,2})\/(\d+)$/)) && star(domF) && star(monF) && star(dowF)) {
    const n = Number(m[3])
    const label = n <= 1 ? '每小时' : `每 ${n} 小时`
    return `${label}（${Number(m[1])}–${Number(m[2])} 点）`
  }
  if (
    (m = hourF.match(/^(\d{1,2})-(\d{1,2})$/)) &&
    star(domF) &&
    star(monF) &&
    star(dowF) &&
    (min0 || star(minF))
  ) {
    return `每小时（${Number(m[1])}–${Number(m[2])} 点）`
  }
  if ((m = minF.match(/^\*\/(\d+)$/)) && star(hourF) && star(domF) && star(monF) && star(dowF)) {
    const n = Number(m[1])
    return n <= 1 ? '每分钟' : `每 ${n} 分钟`
  }
  if (
    (m = minF.match(/^\*\/(\d+)$/)) &&
    (m = hourF.match(/^(\d{1,2})-(\d{1,2})$/)) &&
    star(domF) &&
    star(monF) &&
    star(dowF)
  ) {
    /* handled below via min step + hour range — re-parse */
  }
  if (minF.match(/^\*\/(\d+)$/) && hourF.match(/^(\d{1,2})-(\d{1,2})$/) && star(domF) && star(monF) && star(dowF)) {
    const n = Number(minF.match(/^\*\/(\d+)$/)[1])
    const lo = Number(hourF.match(/^(\d{1,2})-(\d{1,2})$/)[1])
    const hi = Number(hourF.match(/^(\d{1,2})-(\d{1,2})$/)[2])
    const base = n <= 1 ? '每分钟' : `每 ${n} 分钟`
    return `${base}（${lo}–${hi} 点）`
  }
  if (star(hourF) && star(domF) && star(monF) && star(dowF) && min0) return '每小时'
  if (/^\d+$/.test(minF) && /^\d+$/.test(hourF) && star(domF) && star(monF) && star(dowF)) {
    return `每天 ${hourF.padStart(2, '0')}:${minF.padStart(2, '0')}`
  }
  if (/^\d+$/.test(minF) && /^\d+$/.test(hourF) && star(domF) && star(monF) && dowF === '1-5') {
    return `工作日 ${hourF.padStart(2, '0')}:${minF.padStart(2, '0')}`
  }
  return '按计划自动上班'
}

/**
 * @param {{ schedule?: string, scheduledAt?: string, idPrefix?: string, compact?: boolean, tone?: 'duty'|'task' }} initial
 * tone=duty（默认）：智能体员工「自动上班」文案
 * tone=task：自动化任务「执行计划」文案
 */
export function createSchedulePanel(initial = {}) {
  const prefix = String(initial.idPrefix || 'sched').trim() || 'sched'
  const id = (name) => `${prefix}${name}`
  let lastPreview = null
  const initSchedule = String(initial.schedule || '').trim()
  const initOnce = String(initial.scheduledAt || '').trim()
  const initExpr = initOnce || initSchedule || '0 9-19/2 * * *'
  const isTask = initial.tone === 'task'
  const copy = isTask
    ? {
        aiLabel: '用自然语言描述何时执行',
        aiPlaceholder: '例：工作日每天上午 9 点 / 每 2 小时 / 每小时',
        aiHint: '说人话即可，我们会自动安排执行节奏',
        aiEmpty: '请先输入想何时执行的描述',
        aiOkToast: '已生成执行安排',
        nextTitle: '即将执行',
        emptyPick: '请先选择或描述执行频率',
        fallbackSummary: '按计划执行',
      }
    : {
        aiLabel: '用自然语言描述何时上班',
        aiPlaceholder: '例：工作日每 2 小时 / 每天上午 9 点 / 每小时',
        aiHint: '说人话即可，我们会自动安排上班节奏',
        aiEmpty: '请先输入想何时上班的描述',
        aiOkToast: '已生成上班安排',
        nextTitle: '即将自动上班',
        emptyPick: '请先选择或描述上班频率',
        fallbackSummary: '按计划自动上班',
      }

  const PRESETS = [
    { label: '每小时', cron: '0 9-19 * * *' },
    { label: '每 2 小时', cron: '0 9-19/2 * * *' },
    { label: '每 3 小时', cron: '0 9-19/3 * * *' },
    { label: '每 30 分钟', cron: '*/30 9-19 * * *' },
    { label: '每天 9:00', cron: '0 9 * * *' },
    { label: '工作日 9:00', cron: '0 9 * * 1-5' },
  ]

  function plainSummary(text, fallbackExpr) {
    const raw = String(text || '').trim()
    if (raw && !looksLikeCron(raw) && !/FREQ=/i.test(raw)) return raw
    const zh = cronToPlainZh(fallbackExpr || raw || initExpr)
    if (zh === '按计划自动上班' && isTask) return copy.fallbackSummary
    return zh
  }

  function renderHtml() {
    const aiBlock = `
      <div class="sched-ai-box">
        <label class="sched-ai-label" for="${id('AiInput')}">${esc(copy.aiLabel)}</label>
        <div class="sched-ai-row">
          <input class="cron-input" id="${id('AiInput')}" type="text"
                 placeholder="${esc(copy.aiPlaceholder)}" />
          <button type="button" class="cron-btn primary" id="${id('AiBtn')}">AI 生成</button>
        </div>
        <div class="sched-ai-hint" id="${id('AiHint')}">${esc(copy.aiHint)}</div>
      </div>`

    const presetBlock = `
      <div class="sched-preset-row" role="group" aria-label="常用频率">
        ${PRESETS.map(
          (p) =>
            `<button type="button" class="sched-preset-chip${p.cron === initExpr ? ' is-on' : ''}" data-cron="${esc(p.cron)}">${esc(p.label)}</button>`,
        ).join('')}
      </div>
      <input type="hidden" id="${id('Expr')}" value="${esc(initExpr)}" />`

    return `
    <div class="sched-panel sched-panel--simple sched-panel--human" data-schedule-root="${prefix}">
      ${aiBlock}
      ${presetBlock}
      <div class="sched-summary-card" id="${id('Summary')}">选择频率后显示说明</div>
      <div class="sched-next-runs" id="${id('NextRuns')}">
        <div class="sched-next-runs-title">${esc(copy.nextTitle)}</div>
        <div class="sched-next-runs-empty">等待解析…</div>
      </div>
    </div>`
  }

  function setAiHint(msg, kind) {
    const el = document.getElementById(id('AiHint'))
    if (!el) return
    el.textContent = msg || copy.aiHint
    el.classList.remove('is-error', 'is-ok')
    if (kind === 'error') el.classList.add('is-error')
    if (kind === 'ok') el.classList.add('is-ok')
  }

  function syncPresetActive(cron) {
    const root = document.querySelector(`[data-schedule-root="${prefix}"]`)
    if (!root) return
    root.querySelectorAll('.sched-preset-chip').forEach((btn) => {
      btn.classList.toggle('is-on', btn.getAttribute('data-cron') === cron)
    })
  }

  function setExpr(value) {
    const exprEl = document.getElementById(id('Expr'))
    if (exprEl) exprEl.value = String(value || '')
    syncPresetActive(String(value || '').trim())
  }

  function renderNextRuns(runs) {
    const el = document.getElementById(id('NextRuns'))
    if (!el) return
    if (!runs || !runs.length) {
      el.innerHTML =
        `<div class="sched-next-runs-title">${esc(copy.nextTitle)}</div><div class="sched-next-runs-empty">暂无预览</div>`
      return
    }
    const now = new Date()
    const items = runs
      .map(
        (iso, i) =>
          '<li>' +
          '<span class="sched-next-runs-idx">' +
          (i + 1) +
          '</span>' +
          '<span class="sched-next-runs-time">' +
          formatPreviewRunLabel(iso) +
          '</span>' +
          '<span class="sched-next-runs-rel">' +
          formatPreviewRelative(iso, now) +
          '</span>' +
          '</li>',
      )
      .join('')
    el.innerHTML =
      `<div class="sched-next-runs-title">${esc(copy.nextTitle)}</div><ul class="sched-next-runs-list">` +
      items +
      '</ul>'
  }

  async function refreshPreview() {
    const exprEl = document.getElementById(id('Expr'))
    const summaryEl = document.getElementById(id('Summary'))
    const raw = ((exprEl && exprEl.value) || '').trim()
    if (!raw) {
      lastPreview = null
      if (summaryEl) summaryEl.textContent = copy.emptyPick
      renderNextRuns([])
      return
    }
    const looksOnce = /^\d{4}-\d{2}-\d{2}/.test(raw) && raw.split(/\s+/).length < 5
    try {
      const res = await api.automationSchedulePreview({
        schedule: looksOnce ? '' : raw,
        scheduled_at: looksOnce ? raw.replace(' ', 'T').slice(0, 16) : '',
        schedule_type: looksOnce ? 'once' : 'recurring',
        count: 5,
      })
      lastPreview = res
      if (summaryEl) {
        if (res && res.ok) {
          const label = plainSummary(res.summary, res.cron || raw)
          summaryEl.innerHTML = '<span class="ss-icon">⏱</span> ' + esc(label)
          if (res.cron && looksLikeCron(res.cron) && exprEl && !looksOnce) {
            exprEl.value = res.cron
            syncPresetActive(res.cron)
          }
        } else {
          summaryEl.textContent = (res && res.error) || '无法识别该时间安排'
        }
      }
      renderNextRuns((res && res.ok && res.next_runs) || [])
    } catch (err) {
      lastPreview = null
      if (summaryEl) summaryEl.textContent = '预览失败：' + (err && err.message ? err.message : err)
      renderNextRuns([])
    }
  }

  async function runAiSchedule() {
    const input = document.getElementById(id('AiInput'))
    const btn = document.getElementById(id('AiBtn'))
    const text = ((input && input.value) || '').trim()
    if (!text) {
      setAiHint(copy.aiEmpty, 'error')
      return
    }
    if (btn) {
      btn.disabled = true
      btn.textContent = '生成中…'
    }
    setAiHint('正在理解时间安排…')
    const localNow = new Date().toLocaleString('zh-CN', { hour12: false })
    const system = [
      isTask ? '你是定时任务时间助手。根据用户自然语言，输出唯一 JSON，不要 Markdown。' : '你是上班时间助手。根据用户自然语言，输出唯一 JSON，不要 Markdown。',
      '格式：{"cron":"分 时 日 月 星期","summary":"中文白话简述","scheduled_at":""}',
      '规则：五段 cron；星期 0=周日…6=周六，工作日用 1-5；多时段如 0 18,20 * * 1-5。',
      'summary 必须是普通人能懂的中文（如「每 2 小时」「工作日上午 9 点」），不要写 cron。',
      '一次性：scheduled_at 用本地 YYYY-MM-DDTHH:mm，cron 为空。',
      '当前本地时间：' + localNow,
    ].join('\n')
    try {
      const res = await api.invokeConfiguredModel({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
        invocation_kind: 'hosted_panel',
      })
      const parsed = parseAiSchedulePayload(res && res.content)
      if (!parsed || parsed.error || (!parsed.cronExpr && !parsed.scheduledAt)) {
        setAiHint((parsed && parsed.summary) || '未能识别时间，请换种说法', 'error')
        return
      }
      const value = parsed.scheduledAt || parsed.cronExpr
      setExpr(value)
      setAiHint('已应用：' + plainSummary(parsed.summary, value), 'ok')
      toast(copy.aiOkToast, 'success')
      await refreshPreview()
    } catch (err) {
      setAiHint('AI 生成失败：' + (err && err.message ? err.message : err), 'error')
    } finally {
      if (btn) {
        btn.disabled = false
        btn.textContent = 'AI 生成'
      }
    }
  }

  return {
    html: renderHtml(),
    /** Template / hire prefill — cron stays in hidden input only. */
    setSchedule(value) {
      setExpr(value || initExpr)
      void refreshPreview()
    },
    initEvents(_root) {
      const root = document.querySelector(`[data-schedule-root="${prefix}"]`) || _root
      const btn = document.getElementById(id('AiBtn'))
      const aiInput = document.getElementById(id('AiInput'))
      if (btn)
        btn.onclick = () => {
          void runAiSchedule()
        }
      if (aiInput)
        aiInput.onkeydown = (e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void runAiSchedule()
          }
        }
      root?.querySelectorAll('.sched-preset-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const cron = chip.getAttribute('data-cron') || ''
          setExpr(cron)
          void refreshPreview()
        })
      })
      syncPresetActive(initExpr)
      void refreshPreview()
    },
    getSchedule() {
      const raw = (
        (document.getElementById(id('Expr')) && document.getElementById(id('Expr')).value) ||
        ''
      ).trim()
      const pv = lastPreview && lastPreview.ok ? lastPreview : null
      if (pv && pv.schedule_type === 'once') {
        return {
          freq: 'once',
          scheduledAt: pv.scheduled_at || raw,
          cronExpr: '',
          rrule: '',
        }
      }
      if (pv && pv.cron) {
        return {
          freq: 'custom',
          cronExpr: pv.cron,
          rrule: '',
          scheduledAt: '',
        }
      }
      if (/^\d{4}-\d{2}-\d{2}/.test(raw) && raw.split(/\s+/).length < 5) {
        return {
          freq: 'once',
          scheduledAt: raw.replace(' ', 'T').slice(0, 16),
          cronExpr: '',
          rrule: '',
        }
      }
      return { freq: 'custom', cronExpr: raw, rrule: '', scheduledAt: '' }
    },
  }
}

/** Resolve internal schedule expr from role row (not for UI display). */
export function roleScheduleExpr(role) {
  const sched = String(role?.heartbeat_schedule || '').trim()
  if (looksLikeCron(sched)) return sched
  const rr = String(role?.heartbeat_rrule || '').trim()
  if (looksLikeCron(rr)) return rr
  if (/FREQ=/i.test(sched) || /FREQ=/i.test(rr)) {
    if (/INTERVAL=1(?!\d)/i.test(sched || rr) && /HOURLY/i.test(sched || rr)) {
      return '0 9-19 * * *'
    }
    if (/INTERVAL=2(?!\d)/i.test(sched || rr) && /HOURLY/i.test(sched || rr)) {
      return '0 9-19/2 * * *'
    }
  }
  return sched || rr || '0 9-19/2 * * *'
}

export function roleScheduleSummary(role) {
  const fromApi = String(role?.schedule_summary || '').trim()
  if (fromApi && !looksLikeCron(fromApi) && !/FREQ=/i.test(fromApi)) return fromApi
  return cronToPlainZh(roleScheduleExpr(role))
}

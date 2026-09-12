/**
 * 应用运行页 — 填参为主路径，不进画布。
 * 路由：#/apps/:id/run
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { navigate, getCurrentRoute } from '../router.js'
import { showConfirm } from '../components/modal.js'
import {
  previewRenderText,
  paramToField,
  collectParamValues,
  executionModeLabel,
} from '../lib/app-run-form.js'
import { appRunControlFlags } from '../lib/app-run-controls.js'
import { notifyDesktopCompletion } from '../lib/desktop-notification.js'

let pollTimer = null
let trackingToken = 0

export function cleanup() {
  trackingToken++
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function parseAppIdFromRoute() {
  const hash = getCurrentRoute()
  const path = hash.split('?')[0]
  const parts = path.split('/').filter(Boolean)
  // apps / :id / run
  if (parts[0] === 'apps' && parts[2] === 'run') return parts[1] || ''
  return ''
}

export async function render() {
  cleanup()
  const appId = parseAppIdFromRoute()
  const page = document.createElement('div')
  page.className = 'page app-run-page'

  if (!appId) {
    page.innerHTML =
      '<div style="padding:40px;text-align:center;color:var(--text-tertiary)">无效的工作流 ID，<a href="#/apps">返回工作流列表</a></div>'
    return page
  }

  page.innerHTML = `
    <div class="page-header">
      <div>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-back-apps" style="margin-bottom:8px">← 工作流列表</button>
        <h1 class="page-title" id="app-run-title">加载中…</h1>
        <p class="page-desc" id="app-run-desc"></p>
      </div>
      <div class="page-actions">
        <button type="button" class="btn btn-secondary" id="btn-edit-flow">编辑流程</button>
      </div>
    </div>
    <div class="page-content" style="max-width:560px">
      <div class="apps-ops-guide" style="margin-bottom:16px;padding:12px 14px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg-secondary);font-size:13px;line-height:1.55;color:var(--text-secondary)">
        <ol style="margin:0;padding-left:1.2em">
          <li>填好下方参数 → 点「运行」→ 查看结果</li>
          <li>可暂停 / 继续 / 取消；需要改流程请点「编辑流程」</li>
        </ol>
        <details style="margin-top:8px;font-size:12px;color:var(--text-tertiary)">
          <summary style="cursor:pointer">开发者：API 调用</summary>
          <p style="margin:6px 0 0">发布后可在画布「API」创建 Key，按 OpenAPI 兼容接口调用。</p>
        </details>
      </div>
      <div id="app-run-body">
        <div class="page-loader">
          <div class="page-loader-spinner"></div>
          <div class="page-loader-text">加载工作流…</div>
        </div>
      </div>
      <div id="app-run-status" class="app-run-status-card" hidden style="margin-top:20px;padding:16px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg-card)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px">
          <strong data-role="status-label">执行中</strong>
          <span data-role="status-pct" style="font-size:12px;color:var(--text-tertiary)">0%</span>
        </div>
        <div style="height:6px;background:var(--bg-secondary);border-radius:3px;overflow:hidden;margin-bottom:12px">
          <div data-role="status-bar" style="height:100%;width:0%;background:var(--primary);transition:width .2s"></div>
        </div>
        <div data-role="status-answer" hidden style="margin-bottom:12px;padding:12px;border-radius:8px;background:var(--bg-secondary);white-space:pre-wrap;line-height:1.55;font-size:13px;max-height:280px;overflow:auto"></div>
        <div data-role="status-actions" style="display:flex;flex-wrap:wrap;gap:8px"></div>
      </div>
    </div>
  `

  page.querySelector('#btn-back-apps').addEventListener('click', () => navigate('/apps'))
  page.querySelector('#btn-edit-flow').addEventListener('click', () => navigate(`/apps/${appId}`))

  let appData = null

  try {
    appData = await api.getApp(appId)
  } catch (e) {
    page.querySelector('#app-run-body').innerHTML =
      `<div style="color:var(--danger)">加载失败: ${escHtml(e.message)}</div>`
    return page
  }

  page.querySelector('#app-run-title').textContent = appData.name || '未命名工作流'
  const status = String(appData.status || 'draft').toLowerCase()
  page.querySelector('#app-run-desc').textContent =
    appData.description ||
    `${executionModeLabel(appData.execution_mode)} · 填好参数即可启动`

  const body = page.querySelector('#app-run-body')

  // 填参运行页是对外消费面：仅已发布可跑（画布内调试仍允许草稿）
  if (status !== 'published') {
    body.innerHTML = `
      <div style="padding:20px 0;color:var(--text-secondary);line-height:1.6">
        <p style="margin:0 0 12px">当前为<strong>${status === 'archived' ? '已归档' : '草稿'}</strong>，填参运行页仅开放已发布工作流。</p>
        <p style="margin:0 0 16px;font-size:13px;color:var(--text-tertiary)">可在画布内调试；确认流程后点「发布」，再回本页或列表「运行」。</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn btn-primary" id="btn-goto-editor">去画布发布</button>
          <button type="button" class="btn btn-ghost" id="btn-back-list">返回列表</button>
        </div>
      </div>`
    body.querySelector('#btn-goto-editor')?.addEventListener('click', () => navigate(`/apps/${appId}`))
    body.querySelector('#btn-back-list')?.addEventListener('click', () => navigate('/apps'))
    return page
  }

  const params = Array.isArray(appData.parameters) ? appData.parameters : []
  const goalTemplate = String(appData.goal_template || appData.plan?.goal || '').trim()

  if (params.length === 0) {
    body.innerHTML = `
      <p style="color:var(--text-secondary);margin-bottom:16px">该工作流无需参数，可直接运行。</p>
      <button type="button" class="btn btn-primary" id="btn-start-run">立即运行</button>
    `
    body.querySelector('#btn-start-run').addEventListener('click', async () => {
      const modeLabel = executionModeLabel(appData.execution_mode)
      const ok = await showConfirm(
        `工作流「${appData.name || '工作流'}」无需填写参数，确认立即运行？\n执行方式：${modeLabel}`,
      )
      if (!ok) return
      const btn = body.querySelector('#btn-start-run')
      btn.disabled = true
      try {
        const result = await api.runApp(appId, {
          parameters: {},
          execution_mode: appData.execution_mode || 'workflow',
        })
        toast.success(
          (appData.execution_mode || 'workflow') === 'lead_supervised'
            ? '已生成计划，请在任务中确认执行'
            : '工作流已启动',
        )
        startTracking(page, appData, result)
      } catch (e) {
        toast.error('运行失败: ' + (e?.message || e))
        btn.disabled = false
      }
    })
  } else {
    const fields = params.map(paramToField)
    const fieldsHtml = fields
      .map((f) => {
        const name = escHtml(f.name)
        const label = escHtml(f.label)
        const value = escHtml(f.value ?? '')
        const ph = escHtml(f.placeholder || '')
        let control = `<input class="form-input" data-name="${name}" value="${value}" placeholder="${ph}">`
        if (f.type === 'textarea') {
          control = `<textarea class="form-input" data-name="${name}" rows="${f.rows || 3}" placeholder="${ph}" style="resize:vertical">${value}</textarea>`
        } else if (f.type === 'select' && Array.isArray(f.options)) {
          const opts = f.options
            .map((o) => {
              const v = escHtml(o.value)
              const sel = String(o.value) === String(f.value) ? ' selected' : ''
              return `<option value="${v}"${sel}>${escHtml(o.label)}</option>`
            })
            .join('')
          control = `<select class="form-input" data-name="${name}">${opts}</select>`
        }
        return `
          <div class="form-group">
            <label class="form-label">${label}</label>
            ${control}
            ${f.hint ? `<div class="form-hint">${escHtml(f.hint)}</div>` : ''}
          </div>`
      })
      .join('')

    body.innerHTML = `
      <form id="app-run-form">
        ${fieldsHtml}
        ${
          goalTemplate
            ? `<div class="form-group" style="margin-top:8px">
                <label class="form-label">目标预览</label>
                <div data-role="goal-preview" class="form-hint" style="padding:10px 12px;background:var(--bg-secondary);border-radius:6px;white-space:pre-wrap;line-height:1.5;min-height:2.5em"></div>
              </div>`
            : ''
        }
        <div style="display:flex;gap:8px;margin-top:16px">
          <button type="submit" class="btn btn-primary" id="btn-start-run">运行</button>
        </div>
      </form>
    `

    const form = body.querySelector('#app-run-form')
    const previewEl = body.querySelector('[data-role="goal-preview"]')
    const readValues = () => {
      const result = {}
      form.querySelectorAll('[data-name]').forEach((el) => {
        result[el.dataset.name] = el.value
      })
      return result
    }
    const syncPreview = () => {
      if (previewEl) previewEl.textContent = previewRenderText(goalTemplate, readValues()) || '（空）'
    }
    form.addEventListener('input', syncPreview)
    form.addEventListener('change', syncPreview)
    syncPreview()

    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const collected = collectParamValues(params, readValues())
      if (!collected.ok) {
        const parts = []
        if (collected.missing?.length) parts.push('请填写: ' + collected.missing.join(', '))
        if (collected.invalid?.length) parts.push('数字无效: ' + collected.invalid.join(', '))
        toast.warning(parts.join('；'))
        return
      }
      const btn = form.querySelector('#btn-start-run')
      btn.disabled = true
      try {
        const result = await api.runApp(appId, {
          parameters: collected.values,
          execution_mode: appData.execution_mode || 'workflow',
        })
        toast.success(
          (appData.execution_mode || 'workflow') === 'lead_supervised'
            ? '已生成计划，请在任务中确认执行'
            : '工作流已启动',
        )
        startTracking(page, appData, result)
      } catch (err) {
        toast.error('运行失败: ' + (err?.message || err))
        btn.disabled = false
      }
    })
  }

  return page
}

function startTracking(page, appData, result) {
  const runId = result?.run_id
  const taskId = result?.task_id
  const appId = String(appData?.id || '').trim()
  const isLead = (appData?.execution_mode || 'workflow') === 'lead_supervised'

  // U3: lead 模式生成计划后直接跳转任务确认页，无需在此轮询
  if (isLead && taskId) {
    toast.info('计划已生成，正在跳转任务确认页…')
    navigate(`/task/${taskId}`)
    return
  }

  const card = page.querySelector('#app-run-status')
  if (!card || !runId) {
    if (appId) {
      toast.info(runId ? '正在打开运行结果…' : '缺少运行 ID，返回工作流编辑器')
      navigate(runId ? `/apps/${appId}?run=${encodeURIComponent(runId)}` : `/apps/${appId}`)
    } else if (taskId) {
      navigate(`/task/${taskId}`)
    }
    return
  }
  card.hidden = false

  // S6: token 防竞态 — 页面卸载/重渲染时 cleanup() 会递增 token，使旧轮询自动失效
  const myToken = ++trackingToken
  const labelEl = card.querySelector('[data-role="status-label"]')
  const pctEl = card.querySelector('[data-role="status-pct"]')
  const barEl = card.querySelector('[data-role="status-bar"]')
  const answerEl = card.querySelector('[data-role="status-answer"]')
  const actionsEl = card.querySelector('[data-role="status-actions"]')

  let notifiedTerminal = false

  const showAnswer = (status) => {
    if (!answerEl) return
    const text = String(
      status?.result_summary || status?.summary || status?.error || '',
    ).trim()
    if (!text) {
      answerEl.hidden = true
      answerEl.textContent = ''
      return
    }
    answerEl.hidden = false
    answerEl.textContent = text
  }

  const renderActions = (status) => {
    const flags = appRunControlFlags(status)
    const bits = []
    if (appId && runId) {
      bits.push(`<button type="button" class="btn btn-sm btn-secondary" data-act="log">查看运行结果</button>`)
    }
    if (flags.canPause) bits.push(`<button type="button" class="btn btn-sm btn-ghost" data-act="pause">暂停</button>`)
    if (flags.canResume) bits.push(`<button type="button" class="btn btn-sm btn-ghost" data-act="resume">继续</button>`)
    if (flags.canCancel) bits.push(`<button type="button" class="btn btn-sm btn-ghost" data-act="cancel">取消</button>`)
    if (flags.isTerminal && appId && runId) {
      bits.push(`<button type="button" class="btn btn-sm btn-primary" data-act="log">打开运行结果</button>`)
    }
    actionsEl.innerHTML = bits.join('')
    actionsEl.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act
        try {
          if (act === 'log' && appId && runId) {
            navigate(`/apps/${appId}?run=${encodeURIComponent(runId)}`)
            return
          }
          else if (act === 'pause') await api.pauseAppRun(runId)
          else if (act === 'resume') await api.resumeAppRun(runId)
          else if (act === 'cancel') await api.cancelAppRun(runId)
          await pollOnce()
        } catch (e) {
          toast.error((e && e.message) || String(e))
        }
      })
    })
  }

  async function pollOnce() {
    // S6: 页面已卸载或被新 startTracking 取代时，旧轮询直接退出（不清 timer，避免误清新实例的 interval）
    if (myToken !== trackingToken) return
    try {
      const status = await api.getAppRunStatus(runId)
      if (!status) return
      // S6: await 返回后再次校验 token，防止竞态窗口内页面已切换
      if (myToken !== trackingToken) return
      const overall = status.status || 'running'
      const progress = Math.min(100, Math.max(0, status.progress || 0))
      if (labelEl) labelEl.textContent = overall
      if (pctEl) pctEl.textContent = `${progress}%`
      if (barEl) barEl.style.width = `${progress}%`
      renderActions(overall)

      const terminal = ['completed', 'failed', 'cancelled'].includes(overall)
      if (terminal) {
        showAnswer(status)
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
        if (!notifiedTerminal) {
          notifiedTerminal = true
          const appName = appData?.name || '工作流'
          const snippet = String(status.result_summary || status.error || '').trim()
          if (overall === 'completed') {
            toast.success(`${appName} 执行完成`)
            void notifyDesktopCompletion({
              title: '工作流运行完成',
              body: snippet.slice(0, 120) || appName,
              tag: `app-run-${runId}`,
            })
          } else if (overall === 'failed') {
            toast.error(`${appName} 执行失败`)
            void notifyDesktopCompletion({
              title: '工作流运行失败',
              body: String(status.error || appName),
              tag: `app-run-${runId}`,
            })
          } else {
            toast.info(`${appName} 已取消`)
          }
        }
      }
    } catch {
      /* ignore transient */
    }
  }

  if (pollTimer) clearInterval(pollTimer)
  pollOnce()
  pollTimer = setInterval(pollOnce, 3000)
}

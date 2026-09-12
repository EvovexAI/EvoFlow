/**
 * Modal 弹窗组件
 */

import { buildContextWindowFieldHtml, bindContextWindowPresets } from '../lib/model-context-field.js'
import { applyModalTauriDragChrome, listenModalEscape } from '../lib/modal-chrome.js'

// 转义 HTML 属性值，防止双引号等字符破坏 HTML 结构
function escapeAttr(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 菜单项点击后短时间内忽略遮罩 click，避免同一次手势误触关闭确认框 */
let suppressBackdropDismissUntil = 0

export function suppressModalBackdropDismiss(ms = 250) {
  suppressBackdropDismissUntil = Date.now() + Math.max(0, Number(ms) || 0)
}

/**
 * 自定义确认弹窗，替代原生 confirm()
 * Tauri WebView 不支持原生 confirm/alert，必须用自定义弹窗
 * @param {string} message 确认消息
 * @returns {Promise<boolean>} 用户选择确认返回 true，取消返回 false
 */
export function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal" style="max-width:400px">
        <div class="modal-title">确认操作</div>
        <div style="font-size:var(--font-size-sm);color:var(--text-secondary);white-space:pre-wrap;line-height:1.6">${escapeAttr(message)}</div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
          <button type="button" class="btn btn-danger btn-sm" data-action="confirm">确定</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    applyModalTauriDragChrome(overlay)

    let settled = false
    const close = (result) => {
      if (settled) return
      settled = true
      unlistenEscape()
      resolve(result)
      // 同步移除遮罩，避免 pointer-events:none + 延迟移除导致同一次 click 穿透到下层「删除会话」等按钮
      try {
        overlay.remove()
      } catch {
        /* ignore */
      }
    }

    const bindAction = (btn, result) => {
      const onActivate = (e) => {
        if (e.type === 'pointerdown' && e.pointerType === 'mouse' && e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation?.()
        close(result)
      }
      // pointerdown 优先；click 作 WebView2 首次点击兜底（settled 防双触发）
      btn.addEventListener('pointerdown', onActivate)
      btn.addEventListener('click', onActivate)
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          close(result)
        }
      })
    }

    overlay.addEventListener('click', (e) => {
      if (Date.now() < suppressBackdropDismissUntil) return
      if (e.target === overlay) close(false)
    })
    const cancelBtn = overlay.querySelector('[data-action="cancel"]')
    const confirmBtn = overlay.querySelector('[data-action="confirm"]')
    if (!cancelBtn || !confirmBtn) {
      overlay.remove()
      resolve(false)
      return
    }
    bindAction(cancelBtn, false)
    bindAction(confirmBtn, true)
    const unlistenEscape = listenModalEscape(() => close(false), { overlay })
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        close(true)
      }
    })
    // 勿 focus 确定按钮：WebView2 下首次点击常被当作 focus，需点两次才触发
    overlay.focus({ preventScroll: true })
  })
}

/**
 * Multi-button choice dialog (Tauri-safe; no native confirm).
 * @param {string} message
 * @param {{ id: string, label: string, variant?: 'primary'|'danger'|'secondary', default?: boolean }[]} choices
 * @param {{ title?: string }} [opts]
 * @returns {Promise<string|null>} chosen id, or null if dismissed
 */
export function showChoice(message, choices, opts = {}) {
  const list = Array.isArray(choices) ? choices.filter((c) => c && c.id && c.label) : []
  if (!list.length) return Promise.resolve(null)
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    const title = escapeAttr(opts.title || '请选择')
    const buttons = list
      .map((c) => {
        const variant = c.variant === 'danger' ? 'btn-danger' : c.variant === 'primary' ? 'btn-primary' : 'btn-secondary'
        return `<button type="button" class="btn ${variant} btn-sm" data-choice="${escapeAttr(c.id)}">${escapeAttr(c.label)}</button>`
      })
      .join('')
    overlay.innerHTML = `
      <div class="modal" style="max-width:480px">
        <div class="modal-title">${title}</div>
        <div style="font-size:var(--font-size-sm);color:var(--text-secondary);white-space:pre-wrap;line-height:1.6">${escapeAttr(message)}</div>
        <div class="modal-actions" style="flex-wrap:wrap;gap:8px">${buttons}</div>
      </div>
    `
    document.body.appendChild(overlay)
    applyModalTauriDragChrome(overlay)

    let settled = false
    const close = (result) => {
      if (settled) return
      settled = true
      unlistenEscape()
      resolve(result)
      try {
        overlay.remove()
      } catch {
        /* ignore */
      }
    }

    const bindChoice = (btn, id) => {
      const onActivate = (e) => {
        if (e.type === 'pointerdown' && e.pointerType === 'mouse' && e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation?.()
        close(id)
      }
      btn.addEventListener('pointerdown', onActivate)
      btn.addEventListener('click', onActivate)
    }

    overlay.addEventListener('click', (e) => {
      if (Date.now() < suppressBackdropDismissUntil) return
      if (e.target === overlay) close(null)
    })
    for (const btn of overlay.querySelectorAll('[data-choice]')) {
      bindChoice(btn, btn.getAttribute('data-choice'))
    }
    const defaultId = list.find((c) => c.default)?.id || null
    const unlistenEscape = listenModalEscape(() => close(null), { overlay })
    overlay.tabIndex = -1
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && defaultId) {
        e.preventDefault()
        close(defaultId)
      }
    })
    overlay.focus({ preventScroll: true })
  })
}

export function showModal({ title, fields, onConfirm, width, className = '' }) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'

  const w = Number(width) || 0
  const widthStyle = w
    ? ` style="width:min(${w}px, 94vw);max-width:94vw"`
    : ''
  const modalClass = ['modal', className].filter(Boolean).join(' ')

  // 处理 inline 字段分组
  let fieldHtml = ''
  let i = 0
  const renderInlineControl = (f) => {
    if (f.type === 'select') {
      return `<select class="form-input" data-name="${f.name}">
        ${(f.options || []).map((o) => `<option value="${escapeAttr(o.value)}" ${o.value === f.value ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>`
    }
    if (f.type === 'textarea') {
      return `<textarea class="form-input" data-name="${f.name}" rows="${f.rows || 3}" placeholder="${escapeAttr(f.placeholder || '')}" style="resize:vertical">${escapeAttr(f.value || '')}</textarea>`
    }
    const inputType = f.type === 'date' || f.type === 'number' || f.type === 'email' || f.type === 'password' ? f.type : 'text'
    return `<input type="${inputType}" class="form-input" data-name="${f.name}" value="${escapeAttr(f.value)}" placeholder="${escapeAttr(f.placeholder || '')}"${f.readonly ? ' readonly style="opacity:0.6;cursor:not-allowed"' : ''}>`
  }
  while (i < fields.length) {
    const f = fields[i]
    // 检查是否是一组连续的 inline 字段
    if (f.inline) {
      const inlineFields = []
      while (i < fields.length && fields[i].inline) {
        inlineFields.push(fields[i])
        i++
      }
      const inlineHtml = inlineFields.map((field) => `
        <div class="form-group-inline-item">
          <label class="form-label">${field.label}</label>
          ${renderInlineControl(field)}
          ${field.hint ? `<div class="form-hint">${field.hint}</div>` : ''}
        </div>
      `).join('')
      fieldHtml += `<div class="form-group-inline${inlineFields.length >= 3 ? ' form-group-inline--dense' : ''}">${inlineHtml}</div>`
    } else {
      // 普通字段渲染
      if (f.type === 'checkbox') {
        fieldHtml += `
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" data-name="${f.name}" ${f.value ? 'checked' : ''}>
              <span class="form-label" style="margin:0">${f.label}</span>
            </label>
            ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
          </div>`
      } else if (f.type === 'select') {
        fieldHtml += `
          <div class="form-group">
            <label class="form-label">${f.label}</label>
            <select class="form-input" data-name="${f.name}">
              ${f.options.map(o => `<option value="${o.value}" ${o.value === f.value ? 'selected' : ''}>${o.label}</option>`).join('')}
            </select>
            ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
          </div>`
      } else if (f.type === 'checkbox-list') {
        const selectedValues = Array.isArray(f.value) ? f.value : []
        const optionsHtml = f.options.map(o => {
          const checked = selectedValues.includes(o.value) ? 'checked' : ''
          return `
            <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;cursor:pointer;transition:background 0.2s" onmouseover="this.style.background='var(--bg-tertiary)'" onmouseout="this.style.background='transparent'">
              <input type="checkbox" data-name="${f.name}" value="${escapeAttr(o.value)}" ${checked}>
              <span style="font-size:var(--font-size-sm)">${o.icon || ''} ${o.label}</span>
            </label>`
        }).join('')
        fieldHtml += `
          <div class="form-group">
            <label class="form-label">${f.label}</label>
            <div data-checkbox-list="${f.name}" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg-secondary)">
              ${optionsHtml}
            </div>
            ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
          </div>`
      } else if (f.type === 'textarea') {
        const textareaLabel = String(f.label || '').trim()
          ? `<label class="form-label">${f.label}</label>`
          : ''
        fieldHtml += `
          <div class="form-group">
            ${textareaLabel}
            <textarea class="form-input" data-name="${f.name}" placeholder="${escapeAttr(f.placeholder || '')}" rows="${f.rows || 4}"${f.readonly ? ' readonly style="opacity:0.6;cursor:not-allowed;resize:vertical"' : ' style="resize:vertical"'}>${escapeAttr(f.value)}</textarea>
            ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
          </div>`
      } else if (f.type === 'contextWindow') {
        fieldHtml += buildContextWindowFieldHtml(f)
      } else if (f.type === 'file') {
        fieldHtml += `
          <div class="form-group">
            <label class="form-label">${f.label}</label>
            <input type="file" class="form-input" data-name="${f.name}" accept="${escapeAttr(f.accept || '')}" ${f.multiple ? 'multiple' : ''} style="padding:6px;font-size:var(--font-size-sm)">
            ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
          </div>`
      } else if (f.type === 'folder') {
        fieldHtml += `
          <div class="form-group">
            <label class="form-label">${f.label}</label>
            <div class="form-folder-row" style="display:flex;gap:8px;align-items:stretch">
              <input class="form-input" data-name="${f.name}" value="${escapeAttr(f.value)}" placeholder="${escapeAttr(f.placeholder || '')}" style="flex:1;min-width:0">
              <button type="button" class="btn btn-secondary btn-sm" data-folder-pick="${f.name}">选择目录</button>
            </div>
            ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
          </div>`
      } else {
        const inputType = f.type === 'date' || f.type === 'number' || f.type === 'email' || f.type === 'password' ? f.type : 'text'
        fieldHtml += `
          <div class="form-group">
            <label class="form-label">${f.label}</label>
            <input type="${inputType}" class="form-input" data-name="${f.name}" value="${escapeAttr(f.value)}" placeholder="${escapeAttr(f.placeholder || '')}"${f.readonly ? ' readonly style="opacity:0.6;cursor:not-allowed"' : ''}>
            ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
          </div>`
      }
      i++
    }
  }

  overlay.innerHTML = `
    <div class="${modalClass}"${widthStyle}>
      <div class="modal-title">${title}</div>
      <div class="modal-body">
        ${fieldHtml}
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
        <button class="btn btn-primary btn-sm" data-action="confirm">确定</button>
      </div>
    </div>
  `

  document.body.appendChild(overlay)
  bindContextWindowPresets(overlay)
  applyModalTauriDragChrome(overlay)

  const dismiss = () => {
    unlistenEscape()
    overlay.remove()
  }

  overlay.querySelectorAll('[data-folder-pick]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-folder-pick')
      const input = overlay.querySelector(`[data-name="${name}"]`)
      if (!input) return
      const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
      if (isTauri) {
        try {
          const dlg = await import('@tauri-apps/plugin-dialog')
          const picked = await dlg.open({ directory: true, multiple: false, title: '选择工作目录' })
          const p = Array.isArray(picked) ? picked[0] : picked
          if (p) input.value = String(p).trim().replace(/[\\/]+$/, '')
        } catch (err) {
          console.warn('[modal] folder pick failed', err)
        }
        return
      }
      const next = window.prompt('请输入工作目录绝对路径', input.value || '')
      if (next != null) input.value = String(next).trim().replace(/[\\/]+$/, '')
    })
  })

  // 不因点击遮罩关闭：新建/编辑待办等表单填到一半时容易误触丢失输入
  overlay.querySelector('[data-action="cancel"]').onclick = () => dismiss()

  overlay.querySelector('[data-action="confirm"]').onclick = () => {
    const result = {}
    // 处理普通字段
    overlay.querySelectorAll('[data-name]').forEach(el => {
      if (el.type === 'file') {
        // 文件输入：返回 File 对象（或 FileList）
        result[el.dataset.name] = el.multiple ? el.files : (el.files?.[0] || null)
      } else if (el.type === 'checkbox') {
        // 检查是否在 checkbox-list 中
        const listContainer = el.closest('[data-checkbox-list]')
        if (listContainer) {
          // 多选列表：收集所有选中的值
          const listName = listContainer.dataset.checkboxList
          if (!result[listName]) {
            result[listName] = []
          }
          if (el.checked) {
            result[listName].push(el.value)
          }
        } else {
          // 普通复选框
          result[el.dataset.name] = el.checked
        }
      } else {
        result[el.dataset.name] = el.value
      }
    })
    // 确保 checkbox-list 即使没有选中项也有空数组
    overlay.querySelectorAll('[data-checkbox-list]').forEach(container => {
      const name = container.dataset.checkboxList
      if (!(name in result)) {
        result[name] = []
      }
    })
    // 先调用回调，再移除 overlay，避免嵌套对话框时序问题
    const callback = onConfirm
    setTimeout(() => dismiss(), 0)
    callback(result)
  }

  const unlistenEscape = listenModalEscape(() => dismiss(), { overlay })
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const tag = String(e.target?.tagName || '').toLowerCase()
    if (tag === 'textarea' || e.target?.isContentEditable) return
    if (e.target?.closest?.('[data-action]')) return
    e.preventDefault()
    overlay.querySelector('[data-action="confirm"]')?.click()
  })

  // 自动聚焦第一个输入框
  const firstInput = overlay.querySelector('input, select, textarea')
  if (firstInput) firstInput.focus()
}

/**
 * 通用内容弹窗 — 支持自定义 HTML 和按钮
 * @param {{
 *   title: string,
 *   subtitle?: string,
 *   content: string,
 *   buttons?: Array<{ label: string, className?: string, id?: string }>,
 *   width?: number,
 *   className?: string,
 *   overlayClass?: string,
 * }} opts
 * @returns {HTMLElement} overlay 元素（带 .close() 方法）
 */
export function showContentModal({
  title,
  subtitle = '',
  content,
  buttons = [],
  width = 480,
  className = '',
  overlayClass = '',
}) {
  const overlay = document.createElement('div')
  overlay.className = ['modal-overlay', overlayClass].filter(Boolean).join(' ')

  const btnsHtml = buttons
    .map(
      (b) =>
        `<button type="button" class="${b.className || 'btn btn-primary btn-sm'}" id="${b.id || ''}">${b.label}</button>`,
    )
    .join('')

  const subHtml = subtitle
    ? `<p class="modal-subtitle">${subtitle}</p>`
    : ''

  overlay.innerHTML = `
    <div class="modal ${className}" style="max-width:${Number(width) || 480}px" role="dialog" aria-modal="true">
      <div class="modal-header">
        <div class="modal-header-text">
          <div class="modal-title">${title}</div>
          ${subHtml}
        </div>
        <button type="button" class="modal-close" data-action="dismiss" aria-label="关闭">×</button>
      </div>
      <div class="modal-content-body">${content}</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
        ${btnsHtml}
      </div>
    </div>
  `

  document.body.appendChild(overlay)
  applyModalTauriDragChrome(overlay)

  let unlistenEscape = () => {}
  const close = () => {
    unlistenEscape()
    overlay.remove()
  }
  overlay.close = close
  unlistenEscape = listenModalEscape(close, { overlay })

  // 不因点击遮罩关闭，避免表单内容误触丢失；用取消 / × / Esc 关闭
  overlay.querySelectorAll('[data-action="cancel"], [data-action="dismiss"]').forEach((btn) => {
    btn.addEventListener('click', close)
  })

  const firstInput = overlay.querySelector('input, textarea, select')
  if (firstInput) firstInput.focus()

  return overlay
}

/**
 * 升级进度弹窗 — 带进度条和实时日志
 * @returns {{ appendLog, setProgress, setDone, setError, destroy }}
 */
export function showUpgradeModal(title) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-title">${title || '升级 EvoFlow'}</div>
      <div class="upgrade-progress-wrap">
        <div class="upgrade-progress-bar"><div class="upgrade-progress-fill" style="width:0%"></div></div>
        <div class="upgrade-progress-text">准备中...</div>
      </div>
      <div class="upgrade-log-box"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="close">关闭</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  applyModalTauriDragChrome(overlay)

  const fill = overlay.querySelector('.upgrade-progress-fill')
  const text = overlay.querySelector('.upgrade-progress-text')
  const logBox = overlay.querySelector('.upgrade-log-box')
  const closeBtn = overlay.querySelector('[data-action="close"]')
  const _logLines = []

  let _onClose = null
  let _finished = false
  let _taskBar = null
  let unlistenEscape = () => {}

  const bindEscape = () => {
    unlistenEscape()
    unlistenEscape = listenModalEscape(closeModal, { overlay })
  }

  // 重新打开弹窗（从任务状态栏点击时）
  function reopenModal() {
    if (_taskBar) { _taskBar.remove(); _taskBar = null }
    document.body.appendChild(overlay)
    bindEscape()
  }

  // 关闭弹窗：未完成时显示任务状态栏
  function closeModal() {
    unlistenEscape()
    overlay.remove()
    if (!_finished) {
      showTaskBar()
    } else {
      if (_taskBar) { _taskBar.remove(); _taskBar = null }
      _onClose?.()
    }
  }

  // 全局任务状态栏：关闭弹窗后显示在页面顶部
  function showTaskBar() {
    if (_taskBar) return
    _taskBar = document.createElement('div')
    _taskBar.className = 'upgrade-task-bar'
    _taskBar.innerHTML = `
      <span class="upgrade-task-bar-text">${text.textContent}</span>
      <button class="btn btn-sm upgrade-task-bar-open">查看详情</button>
      <button class="btn btn-sm btn-ghost upgrade-task-bar-dismiss">×</button>
    `
    _taskBar.querySelector('.upgrade-task-bar-open').onclick = reopenModal
    _taskBar.querySelector('.upgrade-task-bar-dismiss').onclick = () => { _taskBar.remove(); _taskBar = null }
    document.body.appendChild(_taskBar)
  }

  function updateTaskBar(statusText) {
    if (_taskBar) {
      const span = _taskBar.querySelector('.upgrade-task-bar-text')
      if (span) span.textContent = statusText
    }
  }

  closeBtn.onclick = closeModal
  bindEscape()

  return {
    appendLog(line) {
      _logLines.push(line)
      const div = document.createElement('div')
      div.textContent = line
      logBox.appendChild(div)
      logBox.scrollTop = logBox.scrollHeight
    },
    appendHtmlLog(line) {
      _logLines.push(line)
      const div = document.createElement('div')
      div.innerHTML = line
      logBox.appendChild(div)
      logBox.scrollTop = logBox.scrollHeight
    },
    getLogText() { return _logLines.join('\n') },
    setProgress(pct) {
      fill.style.width = pct + '%'
      let statusText
      if (pct >= 100) statusText = '完成'
      else if (pct >= 75) statusText = '正在安装...'
      else if (pct >= 30) statusText = '正在下载依赖...'
      else statusText = '准备中...'
      text.textContent = statusText
      updateTaskBar(statusText)
    },
    setDone(msg) {
      _finished = true
      text.textContent = msg || '升级完成'
      fill.style.width = '100%'
      fill.classList.add('done')
      if (_taskBar) { _taskBar.remove(); _taskBar = null }
      closeBtn.focus()
    },
    setError(msg) {
      _finished = true
      text.textContent = msg || '升级失败'
      fill.classList.add('error')
      if (_taskBar) {
        const span = _taskBar.querySelector('.upgrade-task-bar-text')
        if (span) { span.textContent = msg || '升级失败'; span.style.color = 'var(--error)' }
      }
      closeBtn.focus()
    },
    onClose(fn) { _onClose = fn },
    destroy() {
      unlistenEscape()
      overlay.remove()
      if (_taskBar) { _taskBar.remove(); _taskBar = null }
      _onClose?.()
    },
  }
}

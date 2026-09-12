/**
 * Shared workspace field UI: history dropdown + direct folder picker.
 */
import { api } from './tauri-api.js'
import { toast } from '../components/toast.js'

export function pathBasename(p) {
  const s = String(p || '').replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s || p
}

export async function loadWorkspacePaths() {
  try {
    const res = await api.listUserWorkspaceHistory()
    return (res?.paths || []).map((p) => String(p || '').trim()).filter(Boolean)
  } catch {
    return []
  }
}

export async function pickResolvedWorkspaceFolder(options = {}) {
  const title = options.title || '选择工作空间文件夹'
  const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
  let raw = null
  if (isTauri) {
    try {
      const dlg = await import('@tauri-apps/plugin-dialog')
      const picked = await dlg.open({ directory: true, multiple: false, title })
      raw = Array.isArray(picked) ? picked[0] : picked
    } catch (err) {
      toast(`打开目录选择失败：${err.message || err}`, 'error')
      return null
    }
  } else {
    const next = window.prompt('请输入工作空间绝对路径', String(options.defaultPath || '').trim())
    if (next == null) return null
    raw = next
  }
  raw = String(raw || '').trim()
  if (!raw) return null
  try {
    const resolvedInfo = await api.resolveWorkspacePath(raw)
    const resolved = String(resolvedInfo?.resolved || raw).trim()
    if (!resolved) return null
    if (resolvedInfo?.exists === false) {
      toast(`目录不存在：${resolved}`, 'error')
      return null
    }
    if (resolvedInfo?.is_dir === false) {
      toast(`不是文件夹：${resolved}`, 'error')
      return null
    }
    return resolved
  } catch (err) {
    toast(String(err?.message || err), 'error')
    return null
  }
}

function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderHireDdOptions(items, selectedValue) {
  return items
    .map((it) => {
      const value = String(it.value || '')
      const name = String(it.name || value)
      const sub = String(it.sub || '')
      const on = value === selectedValue
      return `
        <li role="option" class="hire-dd-option${on ? ' is-on' : ''}" data-value="${esc(value)}" data-name="${esc(name)}" aria-selected="${on ? 'true' : 'false'}">
          <span class="hire-dd-option-name">${esc(name)}</span>
          ${sub ? `<span class="hire-dd-option-path">${esc(sub)}</span>` : ''}
        </li>`
    })
    .join('')
}

function buildWorkspaceItems(paths, selectedPath) {
  const selected = String(selectedPath || '').trim()
  const list = Array.isArray(paths)
    ? paths.filter(Boolean).map((p) => String(p).trim()).filter(Boolean)
    : []
  const items = [
    { value: '', name: '默认', sub: '不指定则使用系统默认工作空间' },
    ...list.map((p) => ({ value: p, name: pathBasename(p), sub: p })),
  ]
  if (selected && !list.includes(selected)) {
    items.splice(1, 0, { value: selected, name: pathBasename(selected), sub: selected })
  }
  return { items, value: selected, label: selected ? pathBasename(selected) : '默认' }
}

function renderWorkspaceFieldInner(paths, selectedPath = '') {
  const { items, value, label } = buildWorkspaceItems(paths, selectedPath)
  return `
    <div class="hire-field">
      <span>管辖工作空间（可选）</span>
      <div class="hire-workspace-row">
        <div class="hire-dd" data-role="workspace-dd">
          <button type="button" class="hire-dd-trigger" data-act="dd-toggle" aria-haspopup="listbox" aria-expanded="false">
            <span class="hire-dd-label" data-role="dd-label">${esc(label)}</span>
            <span class="hire-dd-chevron" aria-hidden="true"></span>
          </button>
          <ul class="hire-dd-menu" role="listbox" hidden>
            ${renderHireDdOptions(items, value)}
          </ul>
          <input type="hidden" data-name="workspace_path" value="${esc(value)}">
        </div>
        <button type="button" class="hire-workspace-pick-btn" data-act="ws-pick-folder" title="选择本机文件夹">浏览…</button>
      </div>
      <p class="hire-chip-hint hire-workspace-path" data-role="ws-path">${esc(value || '使用默认工作空间')}</p>
      <p class="hire-chip-hint">可从最近目录选择，或点「浏览…」直接指定本机文件夹</p>
    </div>`
}

export function renderWorkspaceField(paths, selectedPath = '', domainText = '') {
  return `${renderWorkspaceFieldInner(paths, selectedPath)}
    <label class="hire-field">
      <span>关注子路径（可选）</span>
      <textarea class="hire-input hire-textarea" data-name="domain_scope" rows="2" placeholder="每行一条，相对工作空间，例如：&#10;evopanel/src/&#10;evopanel/scripts/">${esc(domainText)}</textarea>
    </label>`
}

export function renderWorkspaceFieldOnly(paths, selectedPath = '') {
  return renderWorkspaceFieldInner(paths, selectedPath)
}

function ensureWorkspaceOption(menu, path) {
  if (!menu || !path) return
  const existing = [...menu.querySelectorAll('.hire-dd-option')].some(
    (el) => (el.dataset.value || '') === path,
  )
  if (existing) return
  const li = document.createElement('li')
  li.setAttribute('role', 'option')
  li.className = 'hire-dd-option'
  li.dataset.value = path
  li.dataset.name = pathBasename(path)
  li.setAttribute('aria-selected', 'false')
  li.innerHTML = `
    <span class="hire-dd-option-name">${esc(pathBasename(path))}</span>
    <span class="hire-dd-option-path">${esc(path)}</span>`
  menu.appendChild(li)
}

function applyWorkspaceSelection(overlay, path) {
  const dd = overlay.querySelector('[data-role="workspace-dd"]')
  if (!dd) return
  const menu = dd.querySelector('.hire-dd-menu')
  const hidden = dd.querySelector('input[data-name="workspace_path"]')
  const labelEl = dd.querySelector('[data-role="dd-label"]')
  const pathEl = overlay.querySelector('[data-role="ws-path"]')
  const value = String(path || '')
  if (hidden) hidden.value = value
  if (labelEl) labelEl.textContent = value ? pathBasename(value) : '默认'
  if (pathEl) pathEl.textContent = value || '使用默认工作空间'
  menu?.querySelectorAll('.hire-dd-option').forEach((el) => {
    const on = (el.dataset.value || '') === value
    el.classList.toggle('is-on', on)
    el.setAttribute('aria-selected', on ? 'true' : 'false')
  })
}

export function bindWorkspaceSelect(overlay) {
  const dd = overlay.querySelector('[data-role="workspace-dd"]')
  if (!dd) return
  const trigger = dd.querySelector('[data-act="dd-toggle"]')
  const menu = dd.querySelector('.hire-dd-menu')
  const hidden = dd.querySelector('input[data-name="workspace_path"]')
  const labelEl = dd.querySelector('[data-role="dd-label"]')
  const pathEl = overlay.querySelector('[data-role="ws-path"]')
  if (!trigger || !menu || !hidden) return

  const close = () => {
    menu.hidden = true
    dd.classList.remove('is-open')
    menu.classList.remove('is-fixed')
    trigger.setAttribute('aria-expanded', 'false')
  }
  const open = () => {
    const r = trigger.getBoundingClientRect()
    menu.style.top = `${Math.round(r.bottom + 6)}px`
    menu.style.left = `${Math.round(r.left)}px`
    menu.style.width = `${Math.round(r.width)}px`
    menu.classList.add('is-fixed')
    menu.hidden = false
    dd.classList.add('is-open')
    trigger.setAttribute('aria-expanded', 'true')
  }
  const pick = (opt) => {
    const value = opt?.dataset.value || ''
    applyWorkspaceSelection(overlay, value)
    close()
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (menu.hidden) open()
    else close()
  })
  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('.hire-dd-option')
    if (!opt) return
    e.preventDefault()
    pick(opt)
  })
  overlay.addEventListener('click', (e) => {
    if (!dd.contains(e.target) && !menu.contains(e.target)) close()
  })

  overlay.querySelector('[data-act="ws-pick-folder"]')?.addEventListener('click', async (e) => {
    e.preventDefault()
    close()
    const resolved = await pickResolvedWorkspaceFolder({
      defaultPath: hidden.value || '',
    })
    if (!resolved) return
    ensureWorkspaceOption(menu, resolved)
    applyWorkspaceSelection(overlay, resolved)
  })
}

export function readWorkspacePath(overlay) {
  return (overlay.querySelector('input[data-name="workspace_path"]')?.value || '').trim()
}

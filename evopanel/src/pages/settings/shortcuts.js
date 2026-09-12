/**
 * 设置 → 快捷键
 */
import { toast } from '../../components/toast.js'
import { showConfirm } from '../../components/modal.js'
import {
  SHORTCUT_DEFS,
  formatShortcutDisplay,
  getKeyboardShortcuts,
  patchKeyboardShortcuts,
  resetAllKeyboardShortcuts,
  resetKeyboardShortcut,
  bindingFromKeyboardEvent,
  findDuplicateShortcut,
  shortcutConflictHint,
  KEYBOARD_SHORTCUTS_CHANGED,
} from '../../lib/keyboard-shortcuts.js'

/** @type {HTMLElement | null} */
let _root = null
/** @type {string | null} */
let _capturingId = null
/** @type {((e: KeyboardEvent) => void) | null} */
let _captureHandler = null

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function groupLabel(category) {
  return category === 'chat' ? '聊天' : '全局'
}

function renderRows() {
  const shortcuts = getKeyboardShortcuts()
  const groups = ['chat', 'global']
  return groups
    .map((cat) => {
      const items = Object.values(SHORTCUT_DEFS).filter((d) => d.category === cat)
      if (!items.length) return ''
      const rows = items
        .map((def) => {
          const binding = shortcuts[def.id] || def.defaultBinding
          const display = formatShortcutDisplay(binding)
          const conflict = shortcutConflictHint(binding)
          const editable = def.editable !== false
          const capturing = _capturingId === def.id
          return `
            <div class="shortcut-row${editable ? '' : ' shortcut-row--readonly'}" data-shortcut-row="${escHtml(def.id)}">
              <div class="shortcut-row-main">
                <div class="shortcut-row-label">${escHtml(def.label)}</div>
                <div class="shortcut-row-desc">${escHtml(def.description)}</div>
                ${conflict ? `<p class="form-hint shortcut-row-warn">${escHtml(conflict)}</p>` : ''}
              </div>
              <div class="shortcut-row-actions">
                <kbd class="shortcut-kbd${capturing ? ' shortcut-kbd--capturing' : ''}" data-shortcut-display="${escHtml(def.id)}">${capturing ? '按下新快捷键…' : escHtml(display)}</kbd>
                ${
                  editable
                    ? `<button type="button" class="cron-btn sm" data-shortcut-edit="${escHtml(def.id)}" ${capturing ? 'disabled' : ''}>${capturing ? '录制中' : '修改'}</button>
                       <button type="button" class="cron-btn sm" data-shortcut-reset="${escHtml(def.id)}" ${capturing ? 'disabled' : ''}>恢复默认</button>`
                    : ''
                }
              </div>
            </div>`
        })
        .join('')
      return `
        <div class="config-section">
          <div class="config-section-title">${groupLabel(cat)}</div>
          <div class="shortcut-list">${rows}</div>
        </div>`
    })
    .join('')
}

function renderPage() {
  if (!_root) return
  _root.innerHTML = `
    <div class="settings-group">
      <div class="settings-group-header">
        <div class="settings-group-title">快捷键</div>
        <div class="settings-group-desc">自定义聊天与全局快捷键，修改后立即生效</div>
      </div>
      ${renderRows()}
      <div class="config-section">
        <div class="config-section-title">全部恢复</div>
        <button type="button" class="cron-btn" id="shortcuts-reset-all">恢复所有默认快捷键</button>
      </div>
    </div>
  `
}

function stopCapture() {
  if (_captureHandler) {
    window.removeEventListener('keydown', _captureHandler, true)
    _captureHandler = null
  }
  _capturingId = null
}

async function startCapture(id) {
  stopCapture()
  _capturingId = id
  renderPage()
  _captureHandler = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      stopCapture()
      renderPage()
      return
    }
    const binding = bindingFromKeyboardEvent(e)
    if (!binding) return
    const dup = findDuplicateShortcut(id, binding)
    if (dup) {
      toast(`与「${dup}」冲突，请换一个组合键`, 'warning')
      return
    }
    try {
      await patchKeyboardShortcuts({ [id]: binding })
      toast('快捷键已更新', 'success')
    } catch (err) {
      toast(String(err?.message || err), 'error')
    } finally {
      stopCapture()
      renderPage()
    }
  }
  window.addEventListener('keydown', _captureHandler, true)
}

function onRootClick(e) {
  const editBtn = e.target.closest?.('[data-shortcut-edit]')
  if (editBtn) {
    e.preventDefault()
    void startCapture(editBtn.getAttribute('data-shortcut-edit'))
    return
  }
  const resetBtn = e.target.closest?.('[data-shortcut-reset]')
  if (resetBtn) {
    e.preventDefault()
    const id = resetBtn.getAttribute('data-shortcut-reset')
    if (!id) return
    void resetKeyboardShortcut(id).then(() => {
      toast('已恢复默认', 'success')
      renderPage()
    })
    return
  }
  if (e.target.closest?.('#shortcuts-reset-all')) {
    e.preventDefault()
    void (async () => {
      const ok = await showConfirm('确定将所有快捷键恢复为默认值？')
      if (!ok) return
      await resetAllKeyboardShortcuts()
      toast('已恢复所有默认快捷键', 'success')
      renderPage()
    })()
  }
}

/** @param {HTMLElement} container */
export async function mountShortcutsInto(container) {
  cleanup()
  _root = container
  _root.classList.add('settings-embed-wrap')
  renderPage()
  _root.addEventListener('click', onRootClick)
  _root.addEventListener('evopanel:keyboard-shortcuts-sync', renderPage)
  window.addEventListener(KEYBOARD_SHORTCUTS_CHANGED, renderPage)
}

export function cleanup() {
  stopCapture()
  if (_root) {
    _root.removeEventListener('click', onRootClick)
    _root.removeEventListener('evopanel:keyboard-shortcuts-sync', renderPage)
    window.removeEventListener(KEYBOARD_SHORTCUTS_CHANGED, renderPage)
  }
  _root = null
}

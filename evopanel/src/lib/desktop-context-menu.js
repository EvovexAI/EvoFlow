/**
 * 桌面端（Tauri）编辑菜单：
 * - 屏蔽 WebView 浏览器原生右键菜单（检查、另存为等）
 * - 在输入框 / 可选中文本处提供 剪切·复制·粘贴·全选
 * - Ctrl/Cmd+V 走与右键相同的剪贴板写入（WebView 原生粘贴在 password 等字段常失效）
 * - 粘贴读剪贴板走 Rust arboard，避免 navigator.clipboard.readText 触发左上角「已读取剪贴板」提示
 * - 空白处不弹菜单；聊天/工作台输入框不拦截 Ctrl+V（需保留图片粘贴）
 */
import { isTauri } from './panel-login.js'
import { api } from './tauri-api.js'

const MENU_ID = 'evopanel-desktop-ctx-menu'

/** @type {HTMLElement | null} */
let _menuEl = null
/** @type {(() => void) | null} */
let _cleanupOutside = null
/** 右键菜单打开时记住的可编辑目标（点击菜单项会抢焦点） */
/** @type {HTMLInputElement | HTMLTextAreaElement | HTMLElement | null} */
let _editTarget = null

function isEditableTarget(el) {
  if (!(el instanceof Element)) return false
  const node = el.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')
  if (!node) return false
  if (node instanceof HTMLInputElement) {
    const t = (node.type || 'text').toLowerCase()
    if (['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image', 'range', 'color'].includes(t)) {
      return false
    }
    return !node.disabled && !node.readOnly
  }
  if (node instanceof HTMLTextAreaElement) return !node.disabled && !node.readOnly
  return true
}

/** 聊天 / 工作台输入：需保留原生 paste 事件以粘贴图片，不走本模块 Ctrl+V */
function isComposePasteField(el) {
  if (!(el instanceof Element)) return false
  return !!el.closest('.react-chat-composer, .react-chat-input, .evo-home-composer')
}

function hasTextSelection() {
  const sel = window.getSelection?.()
  if (!sel || sel.isCollapsed) return false
  return String(sel.toString() || '').length > 0
}

function ensureMenu() {
  if (_menuEl) return _menuEl
  const el = document.createElement('div')
  el.id = MENU_ID
  el.className = 'ep-desktop-ctx-menu'
  el.setAttribute('role', 'menu')
  el.hidden = true
  document.body.appendChild(el)
  _menuEl = el
  return el
}

function hideMenu() {
  if (_cleanupOutside) {
    _cleanupOutside()
    _cleanupOutside = null
  }
  if (!_menuEl) return
  _menuEl.hidden = true
  _menuEl.innerHTML = ''
  _editTarget = null
}

/**
 * @param {HTMLInputElement | HTMLTextAreaElement} el
 * @param {string} text
 */
function insertTextIntoField(el, text) {
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  const v = el.value
  el.value = `${v.slice(0, start)}${text}${v.slice(end)}`
  const pos = start + text.length
  try {
    el.setSelectionRange(pos, pos)
  } catch {
    /* type=number 等可能不支持 */
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * @param {'cut' | 'copy' | 'paste' | 'selectAll'} cmd
 * @param {Element | null} [target]
 */
async function execEdit(cmd, target = null) {
  const el =
    target ||
    _editTarget ||
    (document.activeElement instanceof Element && isEditableTarget(document.activeElement)
      ? document.activeElement
      : null)

  try {
    if (cmd === 'paste') {
      let text = ''
      try {
        text = await api.readClipboardText()
      } catch {
        text = (await navigator.clipboard?.readText?.()) || ''
      }
      if (text) {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.focus()
          insertTextIntoField(el, text)
          return
        }
        if (el instanceof HTMLElement && el.isContentEditable) {
          el.focus()
          document.execCommand('insertText', false, text)
          return
        }
      }
    }

    if (el instanceof HTMLElement) el.focus()

    if (cmd === 'selectAll' && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      // 避免 el.select() 在部分 WebView2 下与窗口拖拽冲突闪退；用 setSelectionRange
      try {
        const len = el.value?.length ?? 0
        el.setSelectionRange(0, len)
      } catch {
        try {
          el.select()
        } catch {
          /* ignore */
        }
      }
      return
    }

    document.execCommand(cmd)
  } catch {
    try {
      if (el instanceof HTMLElement) el.focus()
      document.execCommand(cmd)
    } catch {
      /* ignore */
    }
  }
}

function showEditMenu(x, y, { canCut, canCopy, canPaste, canSelectAll, editTarget }) {
  const menu = ensureMenu()
  hideMenu()
  _editTarget = editTarget || null
  const items = [
    canCut ? { id: 'cut', label: '剪切' } : null,
    canCopy ? { id: 'copy', label: '复制' } : null,
    canPaste ? { id: 'paste', label: '粘贴' } : null,
    canSelectAll ? { id: 'selectAll', label: '全选' } : null,
  ].filter(Boolean)

  if (!items.length) return

  menu.innerHTML = items
    .map(
      (it) =>
        `<button type="button" class="ep-desktop-ctx-item" role="menuitem" data-ep-ctx="${it.id}">${it.label}</button>`
    )
    .join('')
  menu.hidden = false

  const pad = 8
  const mw = menu.offsetWidth || 140
  const mh = menu.offsetHeight || 120
  const left = Math.min(x, window.innerWidth - mw - pad)
  const top = Math.min(y, window.innerHeight - mh - pad)
  menu.style.left = `${Math.max(pad, left)}px`
  menu.style.top = `${Math.max(pad, top)}px`

  // mousedown 阻止默认，避免菜单按钮抢走输入框焦点
  const onMenuPointerDown = (e) => {
    if (e.target instanceof Element && e.target.closest('[data-ep-ctx]')) {
      e.preventDefault()
    }
  }

  const onItem = (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-ep-ctx]') : null
    if (!btn) return
    const id = btn.getAttribute('data-ep-ctx')
    const target = _editTarget
    hideMenu()
    if (id === 'cut') void execEdit('cut', target)
    else if (id === 'copy') void execEdit('copy', target)
    else if (id === 'paste') void execEdit('paste', target)
    else if (id === 'selectAll') void execEdit('selectAll', target)
  }
  menu.addEventListener('pointerdown', onMenuPointerDown)
  menu.addEventListener('click', onItem)

  const onOutside = (e) => {
    if (_menuEl && e.target instanceof Node && _menuEl.contains(e.target)) return
    hideMenu()
  }
  const onKey = (e) => {
    if (e.key === 'Escape') hideMenu()
  }
  // 下一帧再挂，避免本次右键立刻关掉
  requestAnimationFrame(() => {
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', hideMenu)
    window.addEventListener('resize', hideMenu)
    _cleanupOutside = () => {
      menu.removeEventListener('pointerdown', onMenuPointerDown)
      menu.removeEventListener('click', onItem)
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', hideMenu)
      window.removeEventListener('resize', hideMenu)
    }
  })
}

/**
 * @param {MouseEvent} e
 */
function onContextMenu(e) {
  // 永远挡住浏览器原生菜单
  e.preventDefault()

  const target = e.target
  const editable = isEditableTarget(target instanceof Element ? target : null)
  const selected = hasTextSelection()

  if (!editable && !selected) {
    hideMenu()
    return
  }

  const editNode =
    target instanceof Element
      ? target.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')
      : null

  const canCopy = selected || editable
  const canCut = editable && selected
  const canPaste = editable
  const canSelectAll = editable

  showEditMenu(e.clientX, e.clientY, {
    canCut,
    canCopy,
    canPaste,
    canSelectAll,
    editTarget: editNode instanceof HTMLElement ? editNode : null,
  })
}

/**
 * WebView 下 password / 部分 input 的原生 Ctrl+V 常无响应；
 * 与右键菜单共用原生剪贴板读取后写入。
 * @param {KeyboardEvent} e
 */
function onEditKeydown(e) {
  if (e.defaultPrevented || e.repeat) return
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
  if (String(e.key || '').toLowerCase() !== 'v') return

  const active = document.activeElement
  if (!(active instanceof Element) || !isEditableTarget(active)) return
  if (isComposePasteField(active)) return

  e.preventDefault()
  void execEdit('paste', active)
}

export function initDesktopContextMenu() {
  if (!isTauri || typeof document === 'undefined') return
  document.addEventListener('contextmenu', onContextMenu, true)
  document.addEventListener('keydown', onEditKeydown)
}

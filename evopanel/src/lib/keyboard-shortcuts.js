/**
 * EvoPanel 快捷键：定义、持久化（panel.ui.keyboardShortcuts）、匹配与展示。
 */

import { getPanelSetting, patchPanelSettings } from './panel-settings.js'

export const KEYBOARD_SHORTCUTS_CHANGED = 'evopanel:keyboard-shortcuts-changed'

/** @typedef {{ alt?: boolean, ctrl?: boolean, shift?: boolean, meta?: boolean, code?: string, key?: string, disabled?: boolean, ctrlOrMeta?: boolean }} ShortcutBinding */

/** @type {Record<string, { id: string, label: string, description: string, category: 'chat' | 'global', editable?: boolean, pushToTalk?: boolean, defaultBinding: ShortcutBinding }>} */
export const SHORTCUT_DEFS = {
  voicePushToTalk: {
    id: 'voicePushToTalk',
    label: '语音快捷键',
    description: '桌面端全局语音输入：按住说话，松手或再按一次发送（需已配置语音）',
    category: 'global',
    editable: true,
    pushToTalk: true,
    defaultBinding: { alt: true, ctrl: false, shift: false, meta: false, code: 'KeyX', key: 'x' },
  },
  toggleTaskPanel: {
    id: 'toggleTaskPanel',
    label: '任务面板',
    description: '打开或关闭浮动任务面板',
    category: 'global',
    editable: true,
    defaultBinding: { ctrl: true, meta: true, alt: false, shift: false, code: 'KeyT', key: 't', ctrlOrMeta: true },
  },
  toggleXiaomiAssistant: {
    id: 'toggleXiaomiAssistant',
    label: '小V助手',
    description: '打开/收起小V；若已隐藏悬浮球则重新显示',
    category: 'global',
    editable: true,
    defaultBinding: {
      ctrl: true,
      meta: true,
      alt: false,
      shift: true,
      code: 'KeyM',
      key: 'm',
      ctrlOrMeta: true,
    },
  },
  sendMessage: {
    id: 'sendMessage',
    label: '发送消息',
    description: '在聊天输入框中发送当前内容',
    category: 'chat',
    editable: false,
    defaultBinding: { alt: false, ctrl: false, shift: false, meta: false, code: 'Enter', key: 'Enter' },
  },
  newlineInComposer: {
    id: 'newlineInComposer',
    label: '输入换行',
    description: '在聊天输入框中插入换行',
    category: 'chat',
    editable: false,
    defaultBinding: { alt: false, ctrl: false, shift: true, meta: false, code: 'Enter', key: 'Enter' },
  },
}

const CODE_LABELS = {
  Space: '空格',
  Enter: 'Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
}

function isMacPlatform() {
  try {
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')
  } catch {
    return false
  }
}

function normalizeEventKey(e) {
  const code = String(e?.code || '').trim()
  if (code) return code
  const key = String(e?.key || '').trim()
  if (key === ' ') return 'Space'
  return key
}

function keyLabelFromBinding(binding) {
  const code = String(binding?.code || '').trim()
  const key = String(binding?.key || '').trim()
  if (code && CODE_LABELS[code]) return CODE_LABELS[code]
  if (code.startsWith('Key') && code.length === 4) return code.slice(3).toUpperCase()
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
  if (key === ' ') return '空格'
  if (key.length === 1) return key.toUpperCase()
  if (key) return key
  return '?'
}

/** @returns {ShortcutBinding} */
export function getDefaultBinding(id) {
  const def = SHORTCUT_DEFS[id]
  if (!def) return {}
  return { ...def.defaultBinding }
}

/** @returns {Record<string, ShortcutBinding>} */
export function getKeyboardShortcuts() {
  const raw = getPanelSetting('keyboardShortcuts', {})
  const saved = raw && typeof raw === 'object' ? raw : {}
  /** @type {Record<string, ShortcutBinding>} */
  const out = {}
  for (const [id, def] of Object.entries(SHORTCUT_DEFS)) {
    const patch = saved[id]
    if (patch && typeof patch === 'object') {
      out[id] = { ...def.defaultBinding, ...patch }
    } else {
      out[id] = { ...def.defaultBinding }
    }
  }
  return out
}

/** @returns {ShortcutBinding} */
export function getShortcutBinding(id) {
  return getKeyboardShortcuts()[id] || getDefaultBinding(id)
}

/** @param {Record<string, ShortcutBinding>} patch */
export async function patchKeyboardShortcuts(patch) {
  const prev = getPanelSetting('keyboardShortcuts', {})
  const base = prev && typeof prev === 'object' ? prev : {}
  const next = { ...base, ...(patch || {}) }
  await patchPanelSettings({ keyboardShortcuts: next })
  window.dispatchEvent(new CustomEvent(KEYBOARD_SHORTCUTS_CHANGED, { detail: getKeyboardShortcuts() }))
  return getKeyboardShortcuts()
}

export async function resetKeyboardShortcut(id) {
  if (!SHORTCUT_DEFS[id]) return getKeyboardShortcuts()
  const prev = getPanelSetting('keyboardShortcuts', {})
  const base = prev && typeof prev === 'object' ? { ...prev } : {}
  delete base[id]
  await patchPanelSettings({ keyboardShortcuts: base })
  window.dispatchEvent(new CustomEvent(KEYBOARD_SHORTCUTS_CHANGED, { detail: getKeyboardShortcuts() }))
  return getKeyboardShortcuts()
}

export async function resetAllKeyboardShortcuts() {
  await patchPanelSettings({ keyboardShortcuts: {} })
  window.dispatchEvent(new CustomEvent(KEYBOARD_SHORTCUTS_CHANGED, { detail: getKeyboardShortcuts() }))
  return getKeyboardShortcuts()
}

/** @param {ShortcutBinding} binding */
export function formatShortcutDisplay(binding) {
  if (!binding || binding.disabled) return '已禁用'
  const mac = isMacPlatform()
  const parts = []
  if (binding.ctrlOrMeta) {
    parts.push(mac ? '⌘' : 'Ctrl')
  } else {
    if (binding.ctrl) parts.push(mac ? '⌃' : 'Ctrl')
    if (binding.meta) parts.push('⌘')
  }
  if (binding.alt) parts.push(mac ? '⌥' : 'Alt')
  if (binding.shift) parts.push(mac ? '⇧' : 'Shift')
  parts.push(keyLabelFromBinding(binding))
  return parts.join('+')
}

function modifiersMatch(binding, e) {
  const wantAlt = !!binding.alt
  const wantShift = !!binding.shift
  const wantCtrl = !!binding.ctrl
  const wantMeta = !!binding.meta
  const ctrlOrMeta = !!binding.ctrlOrMeta

  if (ctrlOrMeta) {
    if (!(e.ctrlKey || e.metaKey)) return false
  } else {
    if (!!e.ctrlKey !== wantCtrl) return false
    if (!!e.metaKey !== wantMeta) return false
  }
  if (!!e.altKey !== wantAlt) return false
  if (!!e.shiftKey !== wantShift) return false
  return true
}

/** @param {ShortcutBinding} binding @param {KeyboardEvent} e */
export function shortcutMatchesEvent(binding, e) {
  if (!binding || binding.disabled) return false
  if (!modifiersMatch(binding, e)) return false
  const wantCode = String(binding.code || '').trim()
  const wantKey = String(binding.key || '').trim()
  const evCode = String(e.code || '').trim()
  const evKey = String(e.key || '').trim()
  if (wantCode && evCode) return evCode === wantCode
  if (wantKey && evKey) {
    if (wantKey === ' ' && (evKey === ' ' || evCode === 'Space')) return true
    return evKey === wantKey
  }
  return false
}

/** 按住说话：任一组合键松开时结束 */
export function pushToTalkReleaseMatches(binding, e) {
  if (!binding || binding.disabled) return false
  if (shortcutMatchesEvent(binding, e)) return true
  if (binding.alt && e.key === 'Alt') return true
  if (binding.ctrl && e.key === 'Control') return true
  if (binding.meta && e.key === 'Meta') return true
  if (binding.shift && e.key === 'Shift') return true
  const code = String(binding.code || '').trim()
  const key = String(binding.key || '').trim()
  if (code && e.code === code) return true
  if (key && (e.key === key || (key === ' ' && e.code === 'Space'))) return true
  return false
}

/** @param {KeyboardEvent} e @returns {ShortcutBinding | null} */
export function bindingFromKeyboardEvent(e) {
  if (!e || e.key === 'Escape') return null
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null
  /** @type {ShortcutBinding} */
  const binding = {
    alt: e.altKey,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    meta: e.metaKey,
    code: normalizeEventKey(e),
    key: e.key,
  }
  if ((binding.ctrl || binding.meta) && !binding.alt && !binding.shift) {
    binding.ctrlOrMeta = true
    binding.ctrl = false
    binding.meta = false
  }
  return binding
}

export function voiceShortcutHintText() {
  const key = formatShortcutDisplay(getShortcutBinding('voicePushToTalk'))
  return `${key}：按住说话，松手或再按一次发送`
}

export function micVoiceHintText() {
  return '点击话筒开始，再点一次发送'
}

export function composerPlaceholderExtras() {
  const voice = getShortcutBinding('voicePushToTalk')
  if (voice?.disabled) {
    return 'Enter 发送，Shift+Enter 换行'
  }
  return `Enter 发送，Shift+Enter 换行；${micVoiceHintText()}；${voiceShortcutHintText()}`
}

/** @param {ShortcutBinding} binding */
export function shortcutConflictHint(binding) {
  if (!binding || binding.disabled) return ''
  const code = String(binding.code || '')
  const isWin = /Win/i.test(navigator.userAgent || '')
  if (isWin && binding.alt && !binding.ctrl && !binding.shift && code === 'Space') {
    return 'Windows 系统默认占用 Alt+空格（窗口菜单），建议改为 Ctrl+Shift+空格等组合。'
  }
  if ((binding.ctrlOrMeta || binding.ctrl || binding.meta) && String(binding.key || '').toLowerCase() === 't') {
    return '浏览器常用 Ctrl+T / ⌘T 打开新标签页；桌面版通常无冲突。'
  }
  return ''
}

/** @param {string} id @param {ShortcutBinding} binding */
export function findDuplicateShortcut(id, binding) {
  if (!binding || binding.disabled) return null
  const all = getKeyboardShortcuts()
  for (const [otherId, other] of Object.entries(all)) {
    if (otherId === id || other?.disabled) continue
    const def = SHORTCUT_DEFS[otherId]
    if (!def?.editable) continue
    if (
      !!other.alt === !!binding.alt &&
      !!other.shift === !!binding.shift &&
      !!other.ctrlOrMeta === !!binding.ctrlOrMeta &&
      !!other.ctrl === !!binding.ctrl &&
      !!other.meta === !!binding.meta &&
      String(other.code || other.key) === String(binding.code || binding.key)
    ) {
      return def.label
    }
  }
  return null
}

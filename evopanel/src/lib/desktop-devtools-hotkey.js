/**
 * 桌面端 DevTools 快捷键：
 * - 屏蔽单独 F12 / Ctrl+Shift+I 等浏览器默认入口
 * - 后门：Ctrl+Shift+F12 切换控制台（不依赖 enableDevtools 配置）
 */
import { isTauri } from './panel-login.js'

function isDevtoolsProbeKey(e) {
  if (e.key === 'F12' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return true
  const mod = e.ctrlKey || e.metaKey
  if (!mod || !e.shiftKey) return false
  const k = String(e.key || '').toLowerCase()
  return k === 'i' || k === 'j' || k === 'c'
}

function isBackdoorKey(e) {
  const mod = e.ctrlKey || e.metaKey
  return mod && e.shiftKey && !e.altKey && e.key === 'F12'
}

async function toggleDevtools() {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('toggle_devtools')
  } catch (err) {
    console.warn('[devtools] toggle failed:', err)
  }
}

export function initDesktopDevtoolsHotkey() {
  if (!isTauri || typeof document === 'undefined') return

  document.addEventListener(
    'keydown',
    (e) => {
      if (isBackdoorKey(e)) {
        e.preventDefault()
        e.stopPropagation()
        void toggleDevtools()
        return
      }
      if (isDevtoolsProbeKey(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    true
  )
}

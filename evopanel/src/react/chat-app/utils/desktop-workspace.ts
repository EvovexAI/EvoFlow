/**
 * Desktop / workspace helpers used by ChatApp chrome (pure + modal prompt).
 * Extracted from ChatApp.tsx module-top helpers (P0).
 */
import { showModal } from '../../../components/modal.js'

export function pathBasename(p: string): string {
  const s = String(p || '').trim()
  if (!s) return ''
  const noSlash = s.replace(/[\\/]+$/, '')
  const parts = noSlash.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || noSlash
}

/** @deprecated use pathBasename — kept for call-site parity during extract */
export const _pathBasename = pathBasename

export function isDesktopTauriRuntime(): boolean {
  return !!((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)
}

/** WebView2：拖区须标在实际被命中的节点上 */
export const TAURI_HEADER_CELL_DRAG_PROPS = { 'data-tauri-drag-region': '' } as const

export function promptWorkspacePath(current: string): Promise<string> {
  return new Promise((resolve) => {
    showModal({
      title: '设置工作空间目录',
      width: 360,
      fields: [
        {
          name: 'path',
          label: '本机工作空间目录（绝对路径）',
          value: current || '',
          placeholder: '例如：D:\\work\\project',
          hint: '提示：Web 模式请手动输入绝对路径；桌面端可直接选择系统目录。',
        },
      ],
      onConfirm: (result: any) => {
        resolve(String(result?.path || '').trim())
      },
    })
  })
}

/** Thread panel / stream state expiry window. */
export const THREAD_STATE_EXPIRY_MS = 5 * 60 * 1000

export function inferWriteStreamFormat(path: string): 'plain' | 'markdown' | 'code' {
  const lower = String(path || '').trim().toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (/\.(tsx?|jsx?|py|go|rs|java|cpp|c|h|css|scss|json|yaml|yml|toml|sh|sql)$/.test(lower)) {
    return 'code'
  }
  return 'plain'
}

/**
 * CUA / 浏览器 / 电脑控制截图 → 右侧 Side Pane 大图预览。
 *
 * 对话轮尾仍保留 NodeReplImageGrid；本入口把同一张图自动/手动开到右栏，
 * 避免只能点 lightbox。支持 browser-snapshots API、serve-file、http(s)、data URL。
 */
import { rightStageStore } from './right-stage-store.js'
import { logRightStage } from './panel-set-debug-log.js'

export type OpenRightStageScreenshotOpts = {
  sessionKey?: string | null
  title?: string
  mimeType?: string
  layout?: 'half' | 'wide' | 'narrow' | 'workspace-write'
  /** 去重键；默认用 uri */
  dedupeKey?: string
}

function basenameFromUri(uri: string): string {
  const clean = String(uri || '').split('?')[0].split('#')[0]
  const parts = clean.replace(/\\/g, '/').split('/').filter(Boolean)
  const last = parts[parts.length - 1] || ''
  if (/^[0-9a-f]{12,32}$/i.test(last)) return '截图'
  if (last && last.length < 80) return last
  return '截图'
}

function normalizeScreenshotId(uri: string): string {
  return String(uri || '')
    .trim()
    .replace(/\\/g, '/')
    .slice(0, 240)
}

/** 打开/激活右侧「截图」标签。返回 tabKey；uri 空则 noop。 */
export function showRightStageScreenshot(
  uri: string,
  opts?: OpenRightStageScreenshotOpts,
): string {
  const raw = String(uri || '').trim()
  if (!raw) return ''
  const id = normalizeScreenshotId(opts?.dedupeKey || raw) || `shot-${Date.now()}`
  const title = String(opts?.title || '').trim() || basenameFromUri(raw)
  const mimeType = String(opts?.mimeType || '').trim() || 'image/png'
  const sessionKey = String(opts?.sessionKey || '').trim() || undefined
  const layout = opts?.layout || 'half'
  const key = `screenshot:${id}`

  logRightStage('showRightStageScreenshot', {
    uri: raw.slice(0, 120),
    title,
    key,
    sessionKey: sessionKey || '(空)',
    layout,
  })

  rightStageStore.show({
    kind: 'screenshot',
    id,
    title,
    layout,
    sessionKey,
    data: {
      uri: raw,
      mimeType,
      title,
    },
  })
  return key
}

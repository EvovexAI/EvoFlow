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

  // 【self-evolution-bot · 2026-11-21 · 第105轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：没有会话归属时直接拒绝开截图标签。
  // 为什么：截图是严格会话级内容，但 store.show 的归属兜底会退回
  //   getCurrentRightStageSessionKey()，而冷启动/切会话中间态里它是空串，
  //   于是标签**不带 sessionKey** 落地。可见性规则对无归属标签一律放行
  //   (right-stage-session-visibility 里 `if (!tabSk) return true`)，
  //   表现为「A 会话的截图，B/C 会话右栏也能看到」。
  //   宁可这一帧不显示，也不能让一张图变成全局可见。
  if (!sessionKey) {
    logRightStage('showRightStageScreenshot:skip 无会话归属', {
      uri: raw.slice(0, 120),
      key,
    })
    return ''
  }

  logRightStage('showRightStageScreenshot', {
    uri: raw.slice(0, 120),
    title,
    key,
    sessionKey,
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

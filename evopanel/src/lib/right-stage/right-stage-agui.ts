/** Parse panel_set tool args/result and apply RightStage (fallback when SSE custom is missing). */
import type { RightStageSurface } from './right-stage-types.js'
import { normalizeRightStageKind } from './right-stage-types.js'
import { rightStageStore, hideRightStageIfKind } from './right-stage-store.js'
import { getPanelSetting } from '../panel-settings.js'
import { isAutoWorkPreviewEnabled, normalizeWriteStreamMode } from './write-stream-mode.js'

/** 写入面板是否允许被远端 / panel_set 自动拉开（跟随「自动打开工作预览」设置）。 */
function mayAutoShowWritePanel(): boolean {
  return isAutoWorkPreviewEnabled(normalizeWriteStreamMode(getPanelSetting('writeStreamMode')))
}

export type StageSetPayload = {
  action?: string
  surface?: Partial<RightStageSurface> | null
}

export const STAGE_SET_APPLIED_EVENT = 'evopanel:stage-set-applied'

function dispatchStageSetApplied(payload: StageSetPayload) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(STAGE_SET_APPLIED_EVENT, { detail: payload }))
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function coerceArgsData(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        /* ignore */
      }
    }
  }
  return {}
}

function surfaceFromArgs(args: Record<string, unknown>): Partial<RightStageSurface> | null {
  const kind = normalizeRightStageKind(String(args.kind || ''))
  if (!kind || kind === 'browser-live' || kind === 'browser_live') return null
  return {
    id: 'primary',
    kind,
    title: typeof args.title === 'string' ? args.title : undefined,
    layout: typeof args.layout === 'string' ? (args.layout as RightStageSurface['layout']) : undefined,
    data: coerceArgsData(args.data),
  }
}

export function buildStageSetPayload(argsText?: string, result?: string | null): StageSetPayload | null {
  const resultObj = parseJsonObject(result)
  if (resultObj?.ok === false) return null

  const action = String(resultObj?.action || '').trim().toLowerCase()
  if (action === 'hide') {
    return { action: 'hide', surface: null }
  }

  const resultSurface = resultObj?.surface
  if (resultSurface && typeof resultSurface === 'object' && !Array.isArray(resultSurface)) {
    const rs = resultSurface as Partial<RightStageSurface>
    const nk = normalizeRightStageKind(rs.kind)
    if (!nk && rs.kind) return null
    return {
      action: action || 'show',
      surface: nk ? { ...rs, kind: nk } : rs,
    }
  }

  const args = parseJsonObject(argsText)
  if (!args) return null
  const argsAction = String(args.action || 'show').trim().toLowerCase()
  if (argsAction === 'hide') {
    return { action: 'hide', surface: null }
  }
  const surface = surfaceFromArgs(args)
  if (!surface?.kind) return null
  return { action: argsAction || 'show', surface }
}

export function applyStageSetPayload(payload: StageSetPayload | null): boolean {
  if (!payload) return false
  const action = String(payload.action || 'show').trim().toLowerCase()
  if (action === 'hide' || payload.surface === null) {
    rightStageStore.applyRemote({ action: 'hide', surface: null })
    dispatchStageSetApplied({ action: 'hide', surface: null })
    return true
  }
  if (!payload.surface?.kind) return false
  const kind = normalizeRightStageKind(String(payload.surface.kind || ''))
  // 产物改由侧栏 Info Rail 呈报，不占用 Right Stage
  if (kind === 'artifacts') {
    if (action === 'hide' || payload.surface === null) {
      rightStageStore.applyRemote({ action: 'hide', surface: null })
    } else {
      hideRightStageIfKind('artifacts')
    }
    dispatchStageSetApplied(payload)
    return true
  }
  // 编辑/写入相关：未开「每次写入都打开」、且用户没在看写入面板时，忽略 AI panel_set 抢开
  if (
    kind === 'write' &&
    action !== 'hide' &&
    !mayAutoShowWritePanel() &&
    rightStageStore.currentKind !== 'write'
  ) {
    return false
  }
  rightStageStore.applyRemote({ action, surface: payload.surface })
  dispatchStageSetApplied(payload)
  return true
}

export function applyStageSetFromToolCall(argsText?: string, result?: string | null): boolean {
  return applyStageSetPayload(buildStageSetPayload(argsText, result))
}

export function applyRightStageAgUiCustom(name: string, value: unknown): boolean {
  const n = String(name || '').trim()
  if (n !== 'right_stage' && n !== 'right_stage_stream') return false
  if (!value || typeof value !== 'object') return false
  const payload = value as Record<string, unknown>
  if (n === 'right_stage_stream') {
    // 普通流式 append 不强制 show；open/show 也受 writeStreamMode 约束
    const streamAction = String(payload.action || 'write').trim().toLowerCase()
    const gatedAction =
      (streamAction === 'open' || streamAction === 'show') &&
      !mayAutoShowWritePanel() &&
      rightStageStore.currentKind !== 'write'
        ? 'write' // 降级为只灌内容，不拉开侧栏
        : streamAction
    rightStageStore.applyRemote({
      action: gatedAction,
      stream: {
        streamId: String(payload.streamId || payload.stream_id || 'write_file'),
        text: String(payload.text ?? ''),
        newline: payload.newline !== false,
        level: payload.level as 'info' | undefined,
        action: gatedAction,
        format: payload.format as 'plain' | 'markdown' | 'code' | undefined,
        path: payload.path as string | undefined,
        title: payload.title as string | undefined,
      },
    })
    return true
  }
  const stagePayload: StageSetPayload = {
    action: String(payload.action || 'show'),
    surface: payload.surface as Partial<RightStageSurface> | null | undefined,
  }
  applyStageSetPayload(stagePayload)
  return true
}

/** Build news context block for harness prompt injection. */
export function formatNewsStageContext(feeds: {
  platforms?: Record<string, { text: string }[]>
  fetchedAt?: string
  stale?: boolean
}): string {
  const lines = ['## 资讯上下文', '用户打开了右侧资讯面板。以下热榜仅供背景参考，非用户消息。']
  if (feeds.fetchedAt) {
    lines.push(`抓取时间：${feeds.fetchedAt}${feeds.stale ? '（缓存）' : ''}`)
  }
  for (const [platform, items] of Object.entries(feeds.platforms || {})) {
    const top = (items || []).slice(0, 3).map((it, i) => `${i + 1}. ${it.text}`).join('；')
    if (top) lines.push(`${platform} Top3：${top}`)
  }
  return lines.join('\n')
}

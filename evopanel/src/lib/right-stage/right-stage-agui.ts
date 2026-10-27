/** Parse panel_set tool args/result and apply RightStage (fallback when SSE custom is missing). */
import type { RightStageSurface } from './right-stage-types.js'
import { normalizeRightStageKind } from './right-stage-types.js'
import { rightStageStore, hideRightStageIfKind } from './right-stage-store.js'
import { getCurrentRightStageSessionKey, scopeOfKind } from './right-stage-scope.js'
import { upsertTabInSessionMemory } from './right-stage-session-memory.js'
import { getPanelSetting } from '../panel-settings.js'
import { isAutoWorkPreviewEnabled, normalizeWriteStreamMode } from './write-stream-mode.js'
import { logPanelSet } from './panel-set-debug-log.js'
import { isProgressStageKind, openProgressFromPanelSet } from './open-progress-from-panel-set.js'
import { isXiaomiVoiceRightStageForeground } from '../xiaomi-voice/voice-right-stage-foreground.js'

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

/**
 * 把 panel_set 落到右栏。
 *
 * `options.sessionKey` 是事件所属会话（后端 panel_set / custom 事件都带得到）。
 * 它决定"写到哪"：
 * - 与当前 UI 会话一致（或缺省）：写 live 右栏；
 * - 属于后台会话：只写该会话的冻结记忆，不抢当前 UI（对齐 ZCode「后台挂载不抢焦点」，
 *   也与 browser-panel-store 的 ensureBrowserStage 后台分支保持同一语义）。
 */
export function applyStageSetPayload(
  payload: StageSetPayload | null,
  options?: { sessionKey?: string | null },
): boolean {
  if (!payload) {
    logPanelSet('① applyStageSetPayload：payload 为空，直接返回')
    return false
  }
  const action = String(payload.action || 'show').trim().toLowerCase()
  const ownerSessionKey = String(options?.sessionKey || '').trim()
  logPanelSet('① applyStageSetPayload 入口', {
    action,
    kind: payload.surface?.kind,
    title: payload.surface?.title,
    layout: payload.surface?.layout,
    ownerSessionKey: ownerSessionKey || '(空)',
    dataKeys: payload.surface?.data ? Object.keys(payload.surface.data) : [],
  })
  if (action === 'hide' || payload.surface === null) {
    logPanelSet('① 动作=hide，收起右栏')
    rightStageStore.applyRemote({ action: 'hide', surface: null })
    dispatchStageSetApplied({ action: 'hide', surface: null })
    return true
  }
  if (!payload.surface?.kind) {
    logPanelSet('① 失败：surface.kind 缺失')
    return false
  }
  const kind = normalizeRightStageKind(String(payload.surface.kind || ''))
  // 进度类（工作流/节点/员工/壳页）：会话级归属，钉触发会话，避免新建/切会话串台
  if (isProgressStageKind(kind) && action !== 'hide') {
    const uiSessionKey = getCurrentRightStageSessionKey()
    const xiaomiVoiceFg = isXiaomiVoiceRightStageForeground(ownerSessionKey)
    const stampSk = xiaomiVoiceFg
      ? uiSessionKey || ownerSessionKey || undefined
      : ownerSessionKey || uiSessionKey || undefined
    const isBackgroundOwner =
      !xiaomiVoiceFg &&
      Boolean(ownerSessionKey && uiSessionKey && ownerSessionKey !== uiSessionKey)
    logPanelSet('① 进度面板：openProgressFromPanelSet', {
      kind,
      stampSk: stampSk || '(空)',
      isBackgroundOwner,
    })
    const opened = openProgressFromPanelSet(
      {
        ...payload.surface,
        kind,
      },
      { sessionKey: stampSk },
    )
    if (!opened) {
      logPanelSet('① 进度面板打开失败：缺必填 data')
      return false
    }
    // 后台会话：live 打开后立刻挪进该会话冻结记忆，再从当前 UI 表剔除，避免串进前台。
    if (isBackgroundOwner && ownerSessionKey) {
      const tabKey = `${kind}:${opened}`
      const tab = rightStageStore.findTab(tabKey)
      if (tab) {
        upsertTabInSessionMemory({ sessionKey: ownerSessionKey, tab })
        rightStageStore.discardTab(tabKey)
        logPanelSet('① 进度面板：已挪入后台会话记忆', { ownerSessionKey, tabKey })
      }
    }
    dispatchStageSetApplied(payload)
    return true
  }
  // 产物改由侧栏 Info Rail 呈报，不占用 Right Stage；真正开文件在 syncRemoteStageSet
  if (kind === 'artifacts') {
    logPanelSet('① kind=artifacts → 不直接挂右栏标签，派发 STAGE_SET_APPLIED 给 sync', {
      itemCount: Array.isArray((payload.surface.data as { items?: unknown })?.items)
        ? ((payload.surface.data as { items: unknown[] }).items || []).length
        : 0,
    })
    if (action === 'hide' || payload.surface === null) {
      rightStageStore.applyRemote({ action: 'hide', surface: null })
    } else {
      hideRightStageIfKind('artifacts')
    }
    // 必须带上事件归属会话：syncRemoteStageSet 要靠它解析产物路径（线程沙箱）
    // 并决定文件签钉到哪个会话（小V语音全屏时归属 ≠ 当前 UI 会话）。
    dispatchStageSetApplied({
      action: payload.action,
      surface: {
        ...payload.surface,
        sessionKey: payload.surface?.sessionKey || ownerSessionKey || undefined,
      },
    })
    return true
  }
  // 编辑/写入相关：未开「每次写入都打开」、且用户没在看写入面板时，忽略 AI panel_set 抢开
  if (
    kind === 'write' &&
    action !== 'hide' &&
    !mayAutoShowWritePanel() &&
    rightStageStore.currentKind !== 'write'
  ) {
    logPanelSet('① 拦截：write 面板被「自动打开工作预览」设置挡住')
    return false
  }
  const uiSessionKey = getCurrentRightStageSessionKey()
  // 小V语音全屏：事件归属小V会话，但右栏 UI 仍挂在主对话会话键上——
  // 必须按前台写 live，否则 web-embed/file 等会话级 kind 会被冻进 memory 看不见。
  const xiaomiVoiceFg = isXiaomiVoiceRightStageForeground(ownerSessionKey)
  const isBackgroundOwner =
    !xiaomiVoiceFg &&
    Boolean(ownerSessionKey && uiSessionKey && ownerSessionKey !== uiSessionKey)
  if (isBackgroundOwner && scopeOfKind(kind) === 'session') {
    // 后台会话：只更新它自己的冻结记忆，绝不写当前 UI 的右栏。
    logPanelSet('① 后台会话：只写冻结记忆，不抢当前右栏', {
      ownerSessionKey,
      uiSessionKey,
      kind,
    })
    upsertTabInSessionMemory({
      sessionKey: ownerSessionKey,
      tab: {
        id: String(payload.surface.id || 'primary').trim() || 'primary',
        kind,
        title: payload.surface.title,
        layout: payload.surface.layout,
        data: { ...(payload.surface.data || {}) },
        sessionKey: ownerSessionKey,
      },
    })
    dispatchStageSetApplied(payload)
    return true
  }
  logPanelSet('① 前台：applyRemote 写右栏', { kind, action, xiaomiVoiceFg })
  // 语音全屏：归属钉到当前 UI 会话，避免 tab.sessionKey=小V 被 ChatApp 过滤掉
  const stampSk = xiaomiVoiceFg
    ? uiSessionKey || undefined
    : ownerSessionKey || undefined
  rightStageStore.applyRemote({
    action,
    surface: stampSk
      ? { ...payload.surface, sessionKey: stampSk }
      : payload.surface,
  })
  dispatchStageSetApplied(payload)
  return true
}

export function applyStageSetFromToolCall(
  argsText?: string,
  result?: string | null,
  options?: { sessionKey?: string | null },
): boolean {
  const built = buildStageSetPayload(argsText, result)
  logPanelSet('⓪ 从工具调用解析 payload', {
    hasArgs: Boolean(String(argsText || '').trim()),
    hasResult: Boolean(String(result || '').trim()),
    parsed: Boolean(built),
    action: built?.action,
    kind: built?.surface?.kind,
    sessionKey: String(options?.sessionKey || '').trim() || '(空)',
    argsPreview: String(argsText || '').slice(0, 180),
    resultPreview: String(result || '').slice(0, 180),
  })
  return applyStageSetPayload(built, options)
}

export function applyRightStageAgUiCustom(
  name: string,
  value: unknown,
  options?: { sessionKey?: string | null },
): boolean {
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
  applyStageSetPayload(stagePayload, options)
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

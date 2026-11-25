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
  /**
   * 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
   * 新增：`action='activate'` 时的目标标签 key（形如 `employeeProcess:primary`）。
   * 为什么：切签只认 key，不能靠 surface 反推——surface 会被写进标签/改内容，
   * 而切签必须做到「不新建、不关闭、不改内容」，只能有一个纯 key 通道。
   */
  key?: string
  /**
   * 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
   * 新增：`action='move'` 时「移到哪个签的位置」（另一个标签的 key）。
   * 为什么：move 靠两个 key 定位（源 + 目标位置），只有 key 一个字段的话，
   * 前端 reorderTab(activeId, overId) 拿不到 overId，顺序切不动。
   */
  target?: string
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
  // 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：activate 动作从工具 result 里取 key（没有 surface，不能走下面的 kind 校验）。
  // 为什么：漏了这里，`platform ui.activate` 的返回会在解析阶段被判成「无 kind → null」，
  //   于是后端说切了、前端没动——又一个「工具回 ok 而用户屏幕没变化」。
  if (action === 'activate') {
    const targetKey = String(resultObj?.key || '').trim()
    if (!targetKey) return null
    return { action: 'activate', surface: null, key: targetKey }
  }
  // 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：工具 result 回放通道同样识别 close / move。
  // 为什么：这条通道（拿工具返回值解析）与 SSE 实时通道是**两条独立路径**，
  //   只在 SSE 里接、不在这里接，就等于「实时切得动、回放切不动」——
  //   而 ui.close / ui.move 是普通工具调用，走的就是这条 result 回放。
  //   第100轮我已在 activate 上撞过同型问题（一条通道绿不能推另一条绿）。
  if (action === 'close') {
    const targetKey = String(resultObj?.key || '').trim()
    if (!targetKey) return null
    return { action: 'close', surface: null, key: targetKey }
  }
  if (action === 'move') {
    const srcKey = String(resultObj?.key || '').trim()
    const dstKey = String(resultObj?.target || '').trim()
    if (!srcKey || !dstKey) return null
    return { action: 'move', surface: null, key: srcKey, target: dstKey }
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
  // 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：把 activate 分支提到 hide 判断**之前**。
  // 为什么（这是我本轮自己撞出来的真缺陷，测试一开始没抓到）：
  //   下面 hide 的判据是 `action === 'hide' || payload.surface === null`。
  //   而 activate **天然没有 surface**：
  //     · SSE 实时通道 → surface 是 `undefined`，`!== null` 所以侥幸没进 hide；
  //     · 工具 result 回放通道 → buildStageSetPayload 返回 `surface: null`，
  //       于是「切到某签」会被当成「收起右栏」，用户看到的是面板整个关了。
  //   两条通道一条侥幸绿、一条真坏 —— 正是「一条绿不能推另一条绿」那类缺陷。
  //   顺序改对之后，activate 无论 surface 是 null 还是 undefined 都先被自己接住。
  if (action === 'activate') {
    const targetKey = String(payload.key || '').trim()
    if (!targetKey) {
      logPanelSet('① 动作=activate 失败：缺 key')
      return false
    }
    const snap0 = rightStageStore.getSnapshot()
    const before = { activeKey: snap0.activeKey || null, tabCount: (snap0.tabs || []).length }
    rightStageStore.activateTab(targetKey)
    const snap1 = rightStageStore.getSnapshot()
    const ok = String(snap1.activeKey || '') === targetKey
    logPanelSet('① 动作=activate 已切签', {
      targetKey,
      ok,
      before,
      after: { activeKey: snap1.activeKey || null, tabCount: (snap1.tabs || []).length },
    })
    dispatchStageSetApplied({ action: 'activate', key: targetKey })
    return ok
  }
  // 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：补 close（关单个签）与 move（调签顺序）两条分发——store 里 closeTab /
  //   reorderTab 早就存在，但 SSE 这条通道从来没接，后端加了动作前端也不会动。
  // 为什么（用户当场要求）：「或者是给它关掉……或者给它调换位置。就这种像人一样的操作。」
  // 与 hide 的区别必须写清：hide 收起整栏（签还在）；close 真的删掉那一个签。
  // 判据：close 后 tabCount 减 1 且其它签 key 不变；move 后 tabCount 不变、两签顺序互换。
  if (action === 'close') {
    const targetKey = String(payload.key || '').trim()
    if (!targetKey) {
      logPanelSet('① 动作=close 失败：缺 key')
      return false
    }
    const snap0 = rightStageStore.getSnapshot()
    const beforeKeys = (snap0.tabs || []).map((t) => rightStageStore.keyOf(t))
    if (!beforeKeys.includes(targetKey)) {
      logPanelSet('① 动作=close 失败：目标签不存在', { targetKey, beforeKeys })
      return false
    }
    rightStageStore.closeTab(targetKey)
    const snap1 = rightStageStore.getSnapshot()
    const afterKeys = (snap1.tabs || []).map((t) => rightStageStore.keyOf(t))
    const ok = afterKeys.length === beforeKeys.length - 1 && !afterKeys.includes(targetKey)
    logPanelSet('① 动作=close 已关签', { targetKey, ok, beforeKeys, afterKeys })
    dispatchStageSetApplied({ action: 'close', key: targetKey })
    return ok
  }
  if (action === 'move') {
    const srcKey = String(payload.key || '').trim()
    const dstKey = String(payload.target || '').trim()
    if (!srcKey || !dstKey) {
      logPanelSet('① 动作=move 失败：缺 key/target', { srcKey, dstKey })
      return false
    }
    const snap0 = rightStageStore.getSnapshot()
    const beforeKeys = (snap0.tabs || []).map((t) => rightStageStore.keyOf(t))
    rightStageStore.reorderTab(srcKey, dstKey)
    const snap1 = rightStageStore.getSnapshot()
    const afterKeys = (snap1.tabs || []).map((t) => rightStageStore.keyOf(t))
    const ok = afterKeys.length === beforeKeys.length && afterKeys.join('|') !== beforeKeys.join('|')
    logPanelSet('① 动作=move 已调顺序', { srcKey, dstKey, ok, beforeKeys, afterKeys })
    dispatchStageSetApplied({ action: 'move', key: srcKey, target: dstKey })
    return ok
  }
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
    // 【self-evolution-bot · 2026-11-21 · 第104轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：新增 userInitiatedShow —— 本次展示是否由「用户主动喊员工干活」触发。
    // 为什么：这类动作的语义是「用户点开了它」，必须落在用户当前看的面板里；
    //   不能因为 ownerSessionKey / uiSessionKey 抖动就被当成后台会话挪走（见下方挪签判据）。
    // 判据：payload 里带 forceExpand（后端按用户发起动作置 true）即视为用户主动。
    const userInitiatedShow = payload.surface?.expand === true
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
      // 【self-evolution-bot · 2026-11-20 · 第91轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：把 surface.expand 映射成 forceExpand 透传给 openProgressFromPanelSet。
      // 为什么：用户收起右栏后 ui.show 只写标签不撑开（本轮实测 shellExists=false），
      // expand=true 是调用方明确要求「让用户看见」，语义等同用户亲手点开。
      { sessionKey: stampSk, forceExpand: payload.surface.expand === true },
    )
    if (!opened) {
      logPanelSet('① 进度面板打开失败：缺必填 data')
      return false
    }
    // 后台会话：live 打开后立刻挪进该会话冻结记忆，再从当前 UI 表剔除，避免串进前台。
    // 即便带 expand=true 也不例外——expand 只表示「所属会话里要撑开」，
    // 不能把别的对话的进度签盖到用户正在看的侧边上（侧边串台）。
    // 用户点开路径走 open*InRightStage(forceExpand) 且通常 stamp=当前 UI，不进此分支。
    if (isBackgroundOwner && ownerSessionKey) {
      const tabKey = `${kind}:${opened}`
      const tab = rightStageStore.findTab(tabKey)
      if (tab) {
        upsertTabInSessionMemory({
          sessionKey: ownerSessionKey,
          tab: { ...tab, sessionKey: ownerSessionKey },
          // expand=true → 所属会话记忆里激活撑开；切回该会话才看见，不串前台
          activate: true,
        })
        rightStageStore.discardTab(tabKey)
        logPanelSet('① 进度面板：已挪入后台会话记忆', {
          ownerSessionKey,
          tabKey,
          expand: userInitiatedShow,
        })
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
  // 后台会话（归属 ≠ 当前 UI）：会话级 kind 只写冻结记忆，绝不写当前右栏。
  // expand=true 也不例外——那只表示「所属会话里要看见」，不能盖到别的对话侧边上（串台）。
  // 小V语音全屏除外（xiaomiVoiceFg → isBackgroundOwner=false）。
  if (isBackgroundOwner && scopeOfKind(kind) === 'session') {
    logPanelSet('① 后台会话：只写冻结记忆，不抢当前右栏', {
      ownerSessionKey,
      uiSessionKey,
      kind,
      expand: payload.surface.expand === true,
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
      activate: true,
    })
    dispatchStageSetApplied(payload)
    return true
  }
  logPanelSet('① 前台：applyRemote 写右栏', { kind, action, xiaomiVoiceFg })
  // 语音全屏：归属钉到当前 UI 会话，避免 tab.sessionKey=小V 被 ChatApp 过滤掉。
  // 其余前台写入：优先事件归属会话，其次当前 UI；禁止再把「别的会话 expand」盖成当前 UI。
  const stampSk = xiaomiVoiceFg
    ? uiSessionKey || ownerSessionKey || undefined
    : ownerSessionKey || uiSessionKey || undefined
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
    // 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：SSE custom 流也把 key 透传给 applyStageSetPayload。
    // 为什么：后端 activate 走的是 stream_writer({type:'right_stage', action:'activate', key})，
    //   这里不取 key，实时通道就切不动签（只有工具 result 回放那条路能切），
    //   表现为「工具说切了、屏幕没动」。两条通道都得通。
    ...(String(payload.key || '').trim() ? { key: String(payload.key).trim() } : {}),
    // 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：``target`` 也必须透传。
    // 为什么（本轮前端测试当场抓到）：我只把 key 搬进来、漏了 target，
    //   结果 ui.move 分发时读到 ``dstKey: ''``，走「缺 key/target」直接 return false。
    //   这正是「加参数只改声明处、漏掉使用处」的老毛病 —— 第100轮 activate 也是在这里
    //   只搬了 key；这次别再漏第二个字段。
    ...(String(payload.target || '').trim() ? { target: String(payload.target).trim() } : {}),
  }
  // 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：把 applyStageSetPayload 的返回值如实返回，不再无条件 `return true`。
  // 为什么：本文件所有调用方（ws-client / 工具 result 回放）都拿这个 bool 判断「是否落地」。
  //   无条件 true 会让「activate 缺 key」「surface.kind 缺失」「进度面板缺必填 data」
  //   这些真失败全部报成完成 —— 就是「工具回 ok、用户屏幕没变化」那类假成功。
  //   本轮新加的测试一眼照出来：缺 key 时 expected false，received true。
  return applyStageSetPayload(stagePayload, options)
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

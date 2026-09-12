/**
 * Right Stage 智能弹出决策（产品文档 right-stage-intelligent-panel.md §6–§7）。
 * 所有隐式推断与 panel_set 写入前应经此门禁，避免 ChatApp 散弹式 open。
 */

import { normalizeRightStageKind, type RightStageKind } from './right-stage-types.js'

/** 轻提示 → 展开的默认延迟（可微调） */
export const RIGHT_STAGE_HINT_DELAY_MS = 300

/** 无产物时结束后延迟收起 */
export const RIGHT_STAGE_IDLE_HIDE_DELAY_MS = 1200

export type RightStageIntent =
  | 'write'
  | 'artifacts'
  | 'collab-workflow'
  | 'platform-feedback'
  | 'panel-set'
  | 'run-finished'
  | 'hide'

export type RightStageDecideAction = 'show' | 'hint' | 'stream-only' | 'noop' | 'hide'

export type RightStageDecideInput = {
  intent: RightStageIntent
  /** 目标 kind；run-finished / hide 可省略 */
  kind?: RightStageKind | string | null
  runId: string
  /** 用户钉住的 kind；钉住其他 kind 时不抢切 */
  userPinned: string | null
  /** 本 run 内用户关掉过的 kind */
  dismissedKindsThisRun: ReadonlySet<string> | Iterable<string>
  /** 「自动打开工作预览」；对应 writeStreamMode === always / incremental-only */
  autoPreviewEnabled: boolean
  /** 当前已打开的 kind */
  currentKind: string | null
  /** run-finished：本轮是否有产物 */
  hasArtifacts?: boolean
}

export type RightStageDecideResult = {
  action: RightStageDecideAction
  kind?: string
  /** hint 后自动 show 的延迟 */
  delayMs?: number
  reason: string
}

function asDismissedSet(raw: RightStageDecideInput['dismissedKindsThisRun']): Set<string> {
  if (raw instanceof Set) return raw
  return new Set(Array.from(raw || []).map((k) => normalizeRightStageKind(String(k))))
}

/**
 * 统一决策：钉住 > 关闭冷却 > 隐式 write/artifacts > 远端 panel_set(write)
 */
export function decideRightStage(input: RightStageDecideInput): RightStageDecideResult {
  const intent = input.intent
  const pinned = normalizeRightStageKind(input.userPinned || '') || null
  const dismissed = asDismissedSet(input.dismissedKindsThisRun)
  const current = normalizeRightStageKind(input.currentKind || '') || null
  const target = normalizeRightStageKind(String(input.kind || '').trim()) || null

  if (intent === 'hide') {
    return { action: 'hide', reason: 'explicit-hide' }
  }

  if (intent === 'run-finished') {
    if (input.hasArtifacts) {
      // 产物改由侧栏「产物」tab 呈报，不再弹出独立右栏
      return { action: 'noop', reason: 'artifacts-in-info-rail' }
    }
    // platform 写操作反馈是本轮有效结果，不应随 RUN_FINISHED 自动收起
    if (current === 'platform-feedback') {
      return { action: 'noop', reason: 'platform-feedback-keep-on-finish' }
    }
    if (pinned) {
      return { action: 'noop', reason: 'pinned-keep-on-idle-finish' }
    }
    return {
      action: 'hide',
      delayMs: RIGHT_STAGE_IDLE_HIDE_DELAY_MS,
      reason: 'finish-without-artifacts',
    }
  }

  if (!target) {
    return { action: 'noop', reason: 'missing-kind' }
  }

  // 产物：改由侧栏 Info Rail 呈报
  if (intent === 'artifacts' || target === 'artifacts') {
    return { action: 'noop', kind: 'artifacts', reason: 'artifacts-in-info-rail' }
  }

  // 钉住其他面板：不切换
  if (pinned && pinned !== target) {
    if (target === 'write' && intent === 'write') {
      return { action: 'stream-only', kind: target, reason: 'pinned-other-stream-only' }
    }
    return { action: 'noop', kind: target, reason: 'pinned-other' }
  }

  // 本 run 关掉过该类：不强开（已在看同 kind 时允许更新）
  if (dismissed.has(target) && current !== target) {
    if (target === 'write' && (intent === 'write' || intent === 'panel-set')) {
      return { action: 'stream-only', kind: target, reason: 'dismissed-stream-only' }
    }
    return { action: 'noop', kind: target, reason: 'dismissed-this-run' }
  }

  // 写入：设置关 → 只灌流；设置开 → 轻提示后展开
  if (intent === 'write' || (intent === 'panel-set' && target === 'write')) {
    if (!input.autoPreviewEnabled) {
      return { action: 'stream-only', kind: 'write', reason: 'auto-preview-off' }
    }
    if (current === 'write') {
      return { action: 'show', kind: 'write', reason: 'already-write' }
    }
    return {
      action: 'hint',
      kind: 'write',
      delayMs: RIGHT_STAGE_HINT_DELAY_MS,
      reason: 'write-hint-then-show',
    }
  }

  // 协作
  if (intent === 'collab-workflow' || target === 'collab-workflow') {
    if (current === 'write') {
      return { action: 'noop', kind: 'collab-workflow', reason: 'write-has-priority' }
    }
    if (current === 'collab-workflow') {
      return { action: 'show', kind: 'collab-workflow', reason: 'collab-update' }
    }
    return {
      action: 'hint',
      kind: 'collab-workflow',
      delayMs: RIGHT_STAGE_HINT_DELAY_MS,
      reason: 'collab-hint-then-show',
    }
  }

  // platform 行政写操作反馈：低于 write/artifacts/collab，高于展示型 panel_set
  if (intent === 'platform-feedback' || target === 'platform-feedback') {
    if (current === 'write' || current === 'artifacts' || current === 'collab-workflow') {
      return { action: 'noop', kind: 'platform-feedback', reason: 'higher-priority-open' }
    }
    if (pinned && pinned !== target) {
      return { action: 'noop', kind: target, reason: 'pinned-other' }
    }
    if (dismissed.has(target) && current !== target) {
      return { action: 'noop', kind: target, reason: 'dismissed-this-run' }
    }
    if (current === target) {
      return { action: 'show', kind: target, reason: 'platform-feedback-update' }
    }
    return {
      action: 'hint',
      kind: target,
      delayMs: RIGHT_STAGE_HINT_DELAY_MS,
      reason: 'platform-feedback-hint-then-show',
    }
  }

  // 展示型 panel_set（网页/资讯/导图等）
  if (intent === 'panel-set') {
    if (current === target) {
      return { action: 'show', kind: target, reason: 'panel-set-update' }
    }
    return { action: 'show', kind: target, reason: 'panel-set-show' }
  }

  return { action: 'noop', kind: target, reason: 'unhandled-intent' }
}

/** 是否应用 show / hint（最终会打开面板） */
export function decideResultWillOpenPanel(result: RightStageDecideResult): boolean {
  return result.action === 'show' || result.action === 'hint'
}
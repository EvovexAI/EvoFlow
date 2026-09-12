/**
 * 单轮 assistant turn 展示阶段。
 *
 * 产品层：运行中在中间进度区外露最新轮思考/正文/工具；完成后可收起。
 */

export type TurnDisplayPhase =
  | 'exploring'
  | 'final_streaming'
  | 'done'
  | 'done_no_final'

export type ResolveTurnDisplayPhaseInput = {
  isStreaming: boolean
  hasFinalReplyBelow: boolean
  /** 独立工具折叠（非 Exploring 时间线）：非流式时等同 done 可收起 */
  forceCollapsed?: boolean
}

export function resolveTurnDisplayPhase(input: ResolveTurnDisplayPhaseInput): TurnDisplayPhase {
  const isStreaming = !!input.isStreaming
  const hasFinalReplyBelow = !!input.hasFinalReplyBelow
  const forceCollapsed = !!input.forceCollapsed

  if (forceCollapsed && !isStreaming) return 'done'
  if (isStreaming && hasFinalReplyBelow) return 'final_streaming'
  if (isStreaming) return 'exploring'
  if (hasFinalReplyBelow) return 'done'
  return 'done_no_final'
}

/** 折叠条文案兜底（主文案由 ToolActivityFold 的 Ran N tools 覆盖） */
export function turnDisplayPhaseLabel(_phase: TurnDisplayPhase, _expanded = false): string {
  return 'Ran tools'
}

/** 流式/完成后均允许收起（默认运行中展开最新轮内容） */
export function turnDisplayPhaseMayCollapseWhenIdle(phase: TurnDisplayPhase): boolean {
  return (
    phase === 'done' ||
    phase === 'exploring' ||
    phase === 'final_streaming' ||
    phase === 'done_no_final'
  )
}

/**
 * 不再强制展开。
 * 运行中默认外露最新轮内容；用户可主动收起。
 */
export function turnDisplayPhaseForceExpanded(_phase: TurnDisplayPhase): boolean {
  return false
}

/** 是否应用 is-streaming 样式（标题高亮等） */
export function turnDisplayPhaseIsStreamingUi(phase: TurnDisplayPhase): boolean {
  return phase === 'exploring' || phase === 'final_streaming'
}

/** 是否应展示 Running 进度头（headline / token / tip） */
export function turnDisplayPhaseShowSemanticProgress(phase: TurnDisplayPhase): boolean {
  return phase === 'exploring' || phase === 'done_no_final'
}

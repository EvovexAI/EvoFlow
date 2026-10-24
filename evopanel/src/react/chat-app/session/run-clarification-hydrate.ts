// @ts-nocheck — mechanical P94 extract.
/**
 * Hydrate clarification / goal proposal from history rows. Extracted from ChatApp.tsx (P94).
 */
export type RunClarificationHydrateCtx = Record<string, any>

export function runClarificationHydrateEffect(ctx: RunClarificationHydrateCtx): void {
  const {
    findAskClarificationAwaitingUserInRows,
    extractLatestClarificationFromRows,
    extractLatestGoalProposalFromRows,
    goalProposalSuppressKey,
    historyBoundSessionKey,
    historyInstantPaint,
    historyLoading,
    mergeThreadPanelClarification,
    peekClarificationLatch,
    rows,
    rowsAwaitUserReplyAfterSend,
    scheduleClarificationPanelResolve,
    selectedSessionKey,
    selectedTurnBusy,
    setThreadPanelState,
    shouldSuppressClarificationPanel,
    suppressedGoalProposalKeysRef,
    threadPanelStateRef,
  } = ctx
  if (historyLoading) {
    return
  }
  if (!selectedSessionKey) {
    return
  }
  // 会话切换竞态守卫：切会话瞬间 rows 可能仍残留上一会话的数据，
  // 若用旧会话的 rows 计算 clarification 会污染新会话的 threadPanelState
  // （现象：A 的「询问」串显示到 B）。即时绘制时 rows 来自当前会话的
  // live/idle 缓存（未走 reload），此时 historyBoundSessionKey 为空，放行；
  // 否则要求 rows 已成功绑定当前会话才继续。
  if (!historyInstantPaint && historyBoundSessionKey !== selectedSessionKey) {
    return
  }
  const liveRows = rows || []
  const awaiting = findAskClarificationAwaitingUserInRows(liveRows)
  const rowsHaveAwaitingAsk = !!awaiting?.tool
  const userJustSent =
    selectedTurnBusy && rowsAwaitUserReplyAfterSend(liveRows) && !rowsHaveAwaitingAsk
  const restored = extractLatestClarificationFromRows(liveRows)
  const hostedProp = extractLatestGoalProposalFromRows(liveRows)
  const suppressed = suppressedGoalProposalKeysRef.current
  setThreadPanelState((prev) => {
    const suppressClarify = shouldSuppressClarificationPanel(liveRows, prev)
    let nextHosted = prev.goalProposal
    if (hostedProp) {
      const k = goalProposalSuppressKey(hostedProp)
      if (suppressed.has(k)) {
        if (prev.goalProposal && goalProposalSuppressKey(prev.goalProposal) === k) {
          nextHosted = null
        }
      } else if (!prev.goalProposal || goalProposalSuppressKey(prev.goalProposal) !== k) {
        nextHosted = hostedProp
      }
    } else {
      nextHosted = null
    }
    const nextClarification =
      suppressClarify || userJustSent
        ? null
        : mergeThreadPanelClarification(prev.clarification, restored, {
            preferPrevWhileSending: selectedTurnBusy,
            rowsHaveAwaitingAsk,
          })
    return {
      ...prev,
      clarification: nextClarification,
      goalProposal: nextHosted,
    }
  })

  if (userJustSent) {
    return
  }
  const suppressClarify = shouldSuppressClarificationPanel(liveRows, threadPanelStateRef.current)
  if (suppressClarify && !rowsHaveAwaitingAsk) {
    return
  }
  if (!rowsHaveAwaitingAsk && !peekClarificationLatch(selectedSessionKey)) {
    return
  }
  const toolCallId = awaiting?.tool
    ? String(
        (awaiting.tool as { id?: string; tool_call_id?: string }).id ||
          (awaiting.tool as { tool_call_id?: string }).tool_call_id ||
          '',
      ).trim()
    : peekClarificationLatch(selectedSessionKey)
  scheduleClarificationPanelResolve(selectedSessionKey, {
    toolCallId: toolCallId || undefined,
    localTool: awaiting?.tool,
    preferToolRetries: selectedTurnBusy,
  })
}

import type { ThreadGoalProposal } from '../chat-types.js'
import { pushTargetKey } from '../lib/goalPushTarget.js'

export function GoalProposalDock({
  proposal,
  busy,
  onDismiss,
  onApplyOnly,
  onApplyStart,
}: {
  proposal: ThreadGoalProposal
  busy?: boolean
  onDismiss: () => void
  onApplyOnly: () => void
  onApplyStart: () => void
}) {
  const goalPreview = (proposal.goal || '').trim()
  const head = goalPreview.length > 220 ? `${goalPreview.slice(0, 220)}…` : goalPreview
  const pushLabel =
    proposal.feishuPushOnComplete === false
      ? '推送 关'
      : proposal.pushChannel && proposal.pushTargetId
        ? pushTargetKey(proposal.pushChannel, proposal.pushTargetId)
        : proposal.feishuPushOnComplete
          ? '推送 开'
          : '推送 默认'

  return (
    <div className="react-chat-hosted-proposal-dock" role="region" aria-label="目标方案确认">
      <div className="react-chat-hosted-proposal-dock-inner">
        <div className="react-chat-hosted-proposal-dock-head">
          <strong>目标方案</strong>
          <span className="react-chat-hosted-proposal-dock-sub">由模型提议 · 请确认后写入面板</span>
        </div>
        <div className="react-chat-hosted-proposal-dock-body">
          <div className="react-chat-hosted-proposal-dock-row">
            <span className="react-chat-hosted-proposal-dock-k">目标</span>
            <span className="react-chat-hosted-proposal-dock-v">{head || '（空）'}</span>
          </div>
          <div className="react-chat-hosted-proposal-dock-meta">
            <span>{pushLabel}</span>
            {proposal.useEvolutionSkill ? <span>进化</span> : null}
          </div>
        </div>
        <div className="react-chat-hosted-proposal-dock-actions">
          <button type="button" className="btn btn-ghost sm" disabled={!!busy} onClick={onDismiss}>
            关闭
          </button>
          <button type="button" className="btn btn-ghost sm" disabled={!!busy} onClick={onApplyOnly}>
            填入面板
          </button>
          <button type="button" className="btn btn-primary sm" disabled={!!busy} onClick={onApplyStart}>
            填入并开始
          </button>
        </div>
      </div>
    </div>
  )
}

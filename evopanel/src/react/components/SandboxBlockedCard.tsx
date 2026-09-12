/**
 * SandboxBlockedCard — structured interception card for sandbox path blocks
 * and denylist blocks.  Visual language mirrors ToolApprovalBar / ToolApprovalDock
 * (risk-badge + header + hint) so it feels consistent with the approval UI.
 */

import { extractSandboxBlock, sandboxEventBadge } from '../../lib/sandbox-blocked-card.js'

export function SandboxBlockedCard({ tool }: { tool: Record<string, unknown> }) {
  const block = extractSandboxBlock(tool)
  if (!block) return null
  const badge = sandboxEventBadge(block.event_type)
  return (
    <div className="msg-tool-sandbox-blocked" role="alert" aria-label="沙箱拦截">
      <div className="msg-tool-sandbox-blocked-header">
        <span className={`react-chat-tool-approval-risk-badge ${badge.className}`}>
          {badge.text}
        </span>
        <div className="msg-tool-sandbox-blocked-title" title={block.reason}>
          沙箱安全拦截
        </div>
      </div>
      <div className="msg-tool-sandbox-blocked-reason">{block.reason}</div>
      {block.path ? (
        <div className="msg-tool-sandbox-blocked-path">
          <span className="msg-tool-sandbox-blocked-path-label">被拦截路径：</span>
          <code title={block.path}>{block.path}</code>
        </div>
      ) : null}
      {block.allowed_hint ? (
        <div className="msg-tool-sandbox-blocked-hint">{block.allowed_hint}</div>
      ) : null}
    </div>
  )
}

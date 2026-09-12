import { collectPlatformResultTools } from '../../lib/right-stage/platform-feedback.js'
import { PlatformActionResultCard } from './PlatformActionResultCard.js'

/** 平台 Action Result：始终渲染在 activity fold 外，避免终态折叠后看不见 */
export function PlatformResultCards({
  tools,
  filterIds,
}: {
  tools: unknown[]
  filterIds?: readonly string[] | null
}) {
  const rows = collectPlatformResultTools(tools, filterIds)
  if (!rows.length) return null
  return (
    <div className="msg-platform-results">
      {rows.map((tool, i) => {
        const id =
          tool.tool_call_id != null && String(tool.tool_call_id).trim() !== ''
            ? String(tool.tool_call_id).trim()
            : tool.id != null && String(tool.id).trim() !== ''
              ? String(tool.id).trim()
              : `platform-result-${i}`
        return (
          <div key={id} className="msg-tool-entry msg-tool-entry--platform-result">
            <PlatformActionResultCard tool={tool} />
          </div>
        )
      })}
    </div>
  )
}

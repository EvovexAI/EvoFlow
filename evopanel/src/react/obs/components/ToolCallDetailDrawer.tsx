import type { ToolCallRecord } from '../types'
import { ThreadLabel } from './ThreadLabel'
import { StatusBadge } from './StatusBadge'
import { JsonViewer } from './JsonViewer'

const DRAWER_TABS = ['Overview', 'Input', 'Output', 'Metadata'] as const
// @ts-ignore
type DrawerTab = (typeof DRAWER_TABS)[number]

export function ToolCallDetailDrawer({ record, onClose }: { record: ToolCallRecord | null; onClose: () => void }) {
  if (!record) return null

  return (
    <aside className="detail-drawer">
      <div className="drawer-header">
        <div>
          <h2>Tool Call Detail</h2>
          <p>
            <StatusBadge status={record.status} /> · {record.time}
          </p>
        </div>
        <button type="button" className="icon-button" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="kv-list">
        <div>
          <span>Tool</span>
          <strong>{record.toolName}</strong>
        </div>
        <div>
          <span>Agent</span>
          <strong>{record.agent}</strong>
        </div>
        <div>
          <span>Latency</span>
          <strong>{record.latency}</strong>
        </div>
        <div>
          <span>Status</span>
          <StatusBadge status={record.status} />
        </div>
        <div>
          <span>Request</span>
          <strong>{record.requestId}</strong>
        </div>
        <div>
          <span>Trace</span>
          <strong>
            <ThreadLabel threadId={record.traceId} showId />
          </strong>
        </div>
      </div>

      {record.error && (
        <JsonViewer title="Error" value={record.error} mode="text" maxHeight={2000} />
      )}

      <JsonViewer
        title="Input"
        value={record.input}
        mode="text"
        emptyHint="无输入数据"
        maxHeight={4000}
      />

      <JsonViewer
        title="Output"
        value={record.output}
        mode="text"
        emptyHint="无输出数据"
        maxHeight={5000}
      />

      <div className="drawer-actions">
        <button type="button">复制 Request ID</button>
        <button type="button">导出 JSON</button>
      </div>
    </aside>
  )
}
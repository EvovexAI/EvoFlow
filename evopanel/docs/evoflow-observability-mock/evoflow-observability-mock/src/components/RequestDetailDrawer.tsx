import type { RequestRecord } from '../types';
import { jsonPreview } from '../data/mock';
import { JsonBlock } from './JsonBlock';
import { StatusBadge } from './StatusBadge';

export function RequestDetailDrawer({ request, onClose }: { request: RequestRecord | null; onClose: () => void }) {
  if (!request) return null;
  return (
    <aside className="detail-drawer">
      <div className="drawer-header">
        <div>
          <h2>Request Detail</h2>
          <p><span className="danger-dot" />{request.status === 'failed' ? '失败' : request.status === 'warning' ? '警告' : '成功'} · {request.relativeTime} ({request.time})</p>
        </div>
        <button className="icon-button" onClick={onClose}>×</button>
      </div>
      <div className="request-id-box">
        <span>Request ID</span>
        <code>{request.id}</code>
        <button>复制</button>
      </div>
      <div className="tabs slim">
        {['Overview', 'Prompt', 'Response', 'Token', 'Metadata', 'Trace', 'Errors'].map((tab, index) => <button className={index === 0 ? 'active' : ''} key={tab}>{tab}</button>)}
      </div>
      <div className="kv-list">
        <div><span>Agent</span><strong>{request.agent}</strong></div>
        <div><span>Model</span><strong>{request.model}</strong></div>
        <div><span>Provider</span><strong>{request.provider}</strong></div>
        <div><span>Latency</span><strong className={request.status === 'failed' ? 'text-danger' : ''}>{request.latency}</strong></div>
        <div><span>Tokens</span><strong>{request.tokens.toLocaleString()} tokens</strong><em>Prompt {request.promptTokens} · Completion {request.completionTokens}</em></div>
        <div><span>Cost</span><strong>${request.cost.toFixed(4)} USD</strong></div>
        <div><span>Status</span><StatusBadge status={request.status} /></div>
        <div><span>Thread</span><strong>{request.threadId}</strong></div>
        <div><span>Run</span><strong>{request.runId}</strong></div>
        <div><span>Region</span><strong>{request.region}</strong></div>
      </div>
      <div className="drawer-section-title">请求元数据 (JSON)</div>
      <JsonBlock value={{ ...jsonPreview, request_id: request.id, agent: request.agent, model: request.model, provider: request.provider, status: request.status, latency_ms: request.latencyMs, tokens: { prompt: request.promptTokens, completion: request.completionTokens, total: request.tokens }, cost_usd: request.cost, error: request.error ?? null }} />
      <div className="drawer-actions">
        <button>在 Trace 中查看</button>
        <button>复制 curl</button>
        <button>导出 JSON</button>
      </div>
    </aside>
  );
}

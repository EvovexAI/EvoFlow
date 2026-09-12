import type { CodeIndexStatus } from '../types/code-index'

function statusLabel(st: CodeIndexStatus | null, building: boolean): string {
  if (building || st?.building) return '构建中'
  if (st?.ready) return '已就绪'
  if (st?.status === 'scheduled') return '已排队'
  return '未就绪'
}

function formatUpdatedAt(iso?: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try {
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function CodeIndexProgress({
  status,
  building,
}: {
  status: CodeIndexStatus | null
  building: boolean
}) {
  const isBuilding = building || !!status?.building
  const pct = status?.build_progress_pct
  const total = status?.build_total_files
  const done = status?.build_indexed_files
  const files = status?.files
  const symbols = status?.symbols
  const phase = status?.build_phase || (isBuilding ? 'indexing' : '')
  const updatedLabel = formatUpdatedAt(status?.updated_at)

  const progressWidth =
    pct != null ? `${Math.min(100, Math.max(0, pct))}%` : isBuilding ? '12%' : status?.ready ? '100%' : '0%'

  return (
    <div className="code-index-progress-card">
      <div className="code-index-progress-header">
        <span className="code-index-progress-title">索引状态</span>
        <span className={`code-index-progress-badge ${isBuilding ? 'building' : status?.ready ? 'ready' : 'idle'}`}>
          {statusLabel(status, building)}
        </span>
      </div>
      <div className="code-index-progress-bar-track">
        <div
          className={`code-index-progress-bar-fill ${isBuilding && pct == null ? 'indeterminate' : ''}`}
          style={{ width: progressWidth }}
        />
      </div>
      <div className="code-index-progress-stats">
        {isBuilding && total != null && total > 0 ? (
          <span>
            进度 <strong>{done ?? 0}</strong> / <strong>{total}</strong> 文件
            {pct != null ? `（${pct}%）` : ''}
          </span>
        ) : (
          <span>
            已索引 <strong>{files ?? 0}</strong> 文件
            {symbols != null ? (
              <>
                {' '}
                · <strong>{symbols}</strong> 符号
              </>
            ) : null}
          </span>
        )}
        {updatedLabel ? <span className="code-index-progress-phase">更新于 {updatedLabel}</span> : null}
        {phase ? <span className="code-index-progress-phase">阶段: {phase}</span> : null}
      </div>
    </div>
  )
}

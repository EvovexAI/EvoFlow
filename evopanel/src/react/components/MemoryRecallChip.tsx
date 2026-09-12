import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/tauri-api.js'

type Hit = {
  id?: string
  content?: string
  layer?: string
  kind?: string
  namespace_id?: string
}

type Snapshot = {
  hit_count?: number
  hits?: Hit[]
  standing_preview?: string
  query?: string
  updated_at?: string
}

type Props = {
  threadId?: string | null
  /** Bump after each assistant turn to refresh */
  refreshKey?: number | string
}

/** Chat transparency: 「用了 N 条记忆」— default on (Phase C). */
const SHOW_MEMORY_RECALL_CHIP = true

/**
 * Chat transparency chip: 「用了 N 条记忆」→ read-only drawer.
 */
export function MemoryRecallChip({ threadId, refreshKey = 0 }: Props) {
  const tid = String(threadId || '').trim()
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    if (!SHOW_MEMORY_RECALL_CHIP || !tid) {
      setSnap(null)
      return
    }
    try {
      const data = await api.getMemoryRecallSnapshot(tid)
      setSnap(data || null)
    } catch {
      setSnap(null)
    }
  }, [tid])

  useEffect(() => {
    if (!SHOW_MEMORY_RECALL_CHIP) return
    void load()
  }, [load, refreshKey])

  if (!SHOW_MEMORY_RECALL_CHIP) return null

  const hits = Array.isArray(snap?.hits) ? snap!.hits! : []
  const standing = String(snap?.standing_preview || '').trim()
  const n = Number(snap?.hit_count || hits.length || 0)
  const hasStanding = !!standing
  if (!tid || (!n && !hasStanding)) return null

  const label = n > 0 ? `用了 ${n} 条记忆` : '已注入常驻记忆'

  return (
    <div className="memory-recall-chip-wrap">
      <button
        type="button"
        className={`memory-recall-chip${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="本轮实际注入的记忆（只读）"
      >
        {label}
      </button>
      {open ? (
        <div className="memory-recall-drawer" role="dialog" aria-label="本轮召回">
          <div className="memory-recall-drawer__head">
            <strong>本轮召回</strong>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setOpen(false)}>
              关闭
            </button>
          </div>
          {snap?.query ? <p className="memory-muted">查询：{snap.query}</p> : null}
          {hasStanding ? (
            <div className="memory-recall-drawer__block">
              <h5>常驻 Core（摘要）</h5>
              <pre className="memory-recall-drawer__pre">{standing}</pre>
            </div>
          ) : null}
          {hits.length ? (
            <ul className="memory-recall-drawer__list">
              {hits.map((h, i) => (
                <li key={h.id || `${i}-${h.content?.slice(0, 24)}`}>
                  <div className="memory-fact-meta">
                    <span className="memory-fact-tag">{h.layer || h.kind || 'memory'}</span>
                    {h.namespace_id ? <span className="memory-fact-meta-item">{h.namespace_id}</span> : null}
                  </div>
                  <p>{h.content}</p>
                  {h.id ? (
                    <a className="memory-recall-drawer__link" href={`#/assets?tab=memory`} title="打开资产中心">
                      在资产中心查看
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="memory-muted">本轮无 archival 召回；仅常驻记忆。</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

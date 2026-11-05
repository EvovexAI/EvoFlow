/**
 * 运维观测 · 部门群聊审计
 * 谁说了什么 / @ 点名 / wake 排队·回复·完成·失败 / 成员最近态
 */
import { useEffect, useMemo, useState } from 'react'
import {
  ObsBanner,
  ObsPage,
  ObsSegmentTabs,
  ObsStatItem,
  ObsStatStrip,
  ObsTablePanel,
} from '../components/ObsLayout'
import { StatusBadge } from '../components/StatusBadge'
import { TopFilterBar } from '../components/TopFilterBar'
import { CustomSelect } from '../components/CustomSelect'
import {
  listDeptGroupSessions,
  loadDeptGroupAuditTrail,
  type DeptGroupAuditTrail,
  type DeptGroupSessionSummary,
  type DeptGroupWakeEvent,
  type DeptMemberAuditStatus,
} from '../../lib/dept-group-audit.js'
import type { DeptGroupTimelineMsg } from '../../lib/dept-group-transcript.js'
import type { Status } from '../types'

function fmtTime(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function kindLabel(kind: string): string {
  if (kind === 'user') return '用户'
  if (kind === 'agent') return '成员'
  if (kind === 'system') return '系统'
  return kind || '—'
}

function phaseStatus(phase: DeptMemberAuditStatus['phase']): Status {
  if (phase === 'running') return 'warning'
  if (phase === 'queued') return 'normal'
  if (phase === 'done') return 'success'
  if (phase === 'failed') return 'failed'
  return 'normal'
}

function phaseLabel(phase: DeptMemberAuditStatus['phase']): string {
  if (phase === 'running') return '回复中'
  if (phase === 'queued') return '排队中'
  if (phase === 'done') return '已完成'
  if (phase === 'failed') return '失败'
  return '空闲'
}

function wakeStatus(status: string): Status {
  if (status === 'running') return 'warning'
  if (status === 'done') return 'success'
  if (status === 'failed') return 'failed'
  return 'normal'
}

function msgStatus(m: DeptGroupTimelineMsg): Status {
  if (m.error) return 'failed'
  if (m.streaming) return 'warning'
  return 'success'
}

type TimelineRow =
  | { kind: 'msg'; key: string; ts: number; msg: DeptGroupTimelineMsg }
  | { kind: 'wake'; key: string; ts: number; ev: DeptGroupWakeEvent }

export function DeptGroupChat() {
  const [sessions, setSessions] = useState<DeptGroupSessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionsError, setSessionsError] = useState('')
  const [deptId, setDeptId] = useState('')
  const [trail, setTrail] = useState<DeptGroupAuditTrail | null>(null)
  const [trailLoading, setTrailLoading] = useState(false)
  const [trailError, setTrailError] = useState('')
  const [view, setView] = useState<'merged' | 'messages' | 'wake' | 'members'>('merged')
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setSessionsLoading(true)
    setSessionsError('')
    void listDeptGroupSessions(120)
      .then((rows) => {
        if (cancelled) return
        setSessions(rows)
        setDeptId((prev) => prev || rows[0]?.deptId || '')
      })
      .catch((err) => {
        if (cancelled) return
        setSessionsError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadTick])

  useEffect(() => {
    if (!deptId) {
      setTrail(null)
      return
    }
    let cancelled = false
    setTrailLoading(true)
    setTrailError('')
    const title = sessions.find((s) => s.deptId === deptId)?.title
    void loadDeptGroupAuditTrail(deptId, { deptName: title, limit: 500 })
      .then((t) => {
        if (!cancelled) setTrail(t)
      })
      .catch((err) => {
        if (!cancelled) setTrailError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setTrailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [deptId, sessions, reloadTick])

  const selected = sessions.find((s) => s.deptId === deptId) || null

  const stats = useMemo(() => {
    const msgs = trail?.messages || []
    const wakes = trail?.wakeEvents || []
    const members = trail?.memberStatus || []
    return {
      msgCount: msgs.length,
      userCount: msgs.filter((m) => m.kind === 'user').length,
      agentCount: msgs.filter((m) => m.kind === 'agent').length,
      wakeCount: wakes.length,
      running: members.filter((m) => m.phase === 'running' || m.phase === 'queued').length,
      failed: members.filter((m) => m.phase === 'failed').length,
    }
  }, [trail])

  const mergedRows: TimelineRow[] = useMemo(() => {
    const rows: TimelineRow[] = []
    for (const m of trail?.messages || []) {
      rows.push({ kind: 'msg', key: `m-${m.id}`, ts: m.ts, msg: m })
    }
    for (const ev of trail?.wakeEvents || []) {
      rows.push({ kind: 'wake', key: `w-${ev.id}`, ts: ev.ts, ev })
    }
    rows.sort((a, b) => a.ts - b.ts)
    return rows
  }, [trail])

  const deptOptions = useMemo(
    () =>
      sessions.length
        ? sessions.map((s) => ({
            value: s.deptId,
            label: `${s.title}${s.messageCount != null ? ` · ${s.messageCount}` : ''}`,
          }))
        : [{ value: '', label: sessionsLoading ? '加载部门…' : '暂无部门群' }],
    [sessions, sessionsLoading],
  )

  return (
    <>
      <TopFilterBar
        title="部门群聊审计"
        subtitle="谁说了什么 · @点名流水 · wake 排队/回复/完成 · 成员最近态"
      >
        <CustomSelect
          className="compact-select-wrap"
          value={deptId}
          onChange={setDeptId}
          options={deptOptions}
        >
          <span>{selected?.title || (deptId ? deptId : '选择部门群')}</span>
        </CustomSelect>
        <button
          type="button"
          className="primary"
          onClick={() => setReloadTick((n) => n + 1)}
          disabled={trailLoading || sessionsLoading}
        >
          刷新
        </button>
      </TopFilterBar>

      {(sessionsLoading || trailLoading) && !trail && <ObsBanner>加载群聊审计…</ObsBanner>}
      {sessionsError && !sessionsLoading && <ObsBanner tone="error">{sessionsError}</ObsBanner>}
      {trailError && !trailLoading && <ObsBanner tone="error">{trailError}</ObsBanner>}

      <ObsPage>
        <ObsStatStrip>
          <ObsStatItem label="气泡" value={stats.msgCount} hint="用户+成员+系统" variant="accent" />
          <ObsStatItem label="用户发言" value={stats.userCount} />
          <ObsStatItem label="成员回复" value={stats.agentCount} />
          <ObsStatItem label="Wake 事件" value={stats.wakeCount} hint="状态机落盘" />
          <ObsStatItem
            label="进行中"
            value={stats.running}
            hint="排队/回复"
            variant={stats.running ? 'accent' : 'default'}
          />
          <ObsStatItem
            label="失败成员"
            value={stats.failed}
            hint="最近态"
            variant={stats.failed ? 'danger' : 'default'}
          />
        </ObsStatStrip>

        <div className="compact-filter-bar span-3">
          <ObsSegmentTabs
            value={view}
            options={[
              { value: 'merged' as const, label: '合并流水' },
              { value: 'messages' as const, label: '气泡' },
              { value: 'wake' as const, label: 'Wake' },
              { value: 'members' as const, label: '成员态' },
            ]}
            onChange={setView}
          />
          {selected ? (
            <span className="obs-muted" title={selected.sessionKey}>
              {selected.title} · {selected.sessionKey}
            </span>
          ) : null}
        </div>

        {view === 'members' ? (
          <ObsTablePanel
            title="成员最近态（由 wake 事件推导）"
            className="span-3"
            rows={trail?.memberStatus || []}
            rowKey={(r) => r.agentCode}
            emptyText="尚无 wake 事件；在群里 @ 点名后会出现状态轨迹"
            columns={[
              {
                key: 'role',
                label: '成员',
                render: (r) => (
                  <div>
                    <strong>{r.roleName}</strong>
                    <div className="obs-muted">{r.agentCode}</div>
                  </div>
                ),
              },
              {
                key: 'phase',
                label: '状态',
                render: (r) => (
                  <span>
                    <StatusBadge status={phaseStatus(r.phase)} />{' '}
                    <span className="obs-muted">{phaseLabel(r.phase)}</span>
                  </span>
                ),
              },
              {
                key: 'attempts',
                label: '次数',
                render: (r) => String(r.attempts ?? '—'),
              },
              {
                key: 'job',
                label: '最近 job',
                render: (r) => <code className="obs-mono">{r.lastJobId || '—'}</code>,
              },
              {
                key: 'err',
                label: '错误',
                render: (r) => r.lastError || '—',
              },
              {
                key: 'ts',
                label: '更新',
                render: (r) => fmtTime(r.lastTs),
              },
            ]}
          />
        ) : null}

        {view === 'wake' ? (
          <ObsTablePanel
            title="Wake 状态机"
            className="span-3"
            rows={trail?.wakeEvents || []}
            rowKey={(r) => r.id}
            emptyText="无 wake 落盘（重新 @ 点名后会出现新事件）"
            columns={[
              {
                key: 'ts',
                label: '时间',
                render: (r) => fmtTime(r.ts),
              },
              {
                key: 'who',
                label: '谁',
                render: (r) => (
                  <div>
                    <strong>{r.roleName || r.agentCode}</strong>
                    <div className="obs-muted">{r.agentCode}</div>
                  </div>
                ),
              },
              {
                key: 'st',
                label: '状态',
                render: (r) => (
                  <span>
                    <StatusBadge status={wakeStatus(r.status)} />{' '}
                    <span className="obs-muted">{r.status}</span>
                  </span>
                ),
              },
              {
                key: 'att',
                label: '尝试',
                render: (r) => String(r.attempts),
              },
              {
                key: 'goal',
                label: '目标',
                render: (r) => <span title={r.goal || ''}>{(r.goal || '—').slice(0, 80)}</span>,
              },
              {
                key: 'src',
                label: '来源消息',
                render: (r) => <code className="obs-mono">{r.sourceMsgId || '—'}</code>,
              },
              {
                key: 'job',
                label: 'job',
                render: (r) => <code className="obs-mono">{r.jobId}</code>,
              },
              {
                key: 'err',
                label: '错误',
                render: (r) => r.error || '—',
              },
            ]}
          />
        ) : null}

        {view === 'messages' ? (
          <ObsTablePanel
            title="群气泡"
            className="span-3"
            rows={trail?.messages || []}
            rowKey={(r) => r.id}
            emptyText="该群尚无气泡"
            columns={[
              {
                key: 'ts',
                label: '时间',
                render: (r) => fmtTime(r.ts),
              },
              {
                key: 'kind',
                label: '类型',
                render: (r) => kindLabel(r.kind),
              },
              {
                key: 'who',
                label: '发言人',
                render: (r) =>
                  r.kind === 'user'
                    ? '用户'
                    : r.fromAgentName
                      ? `${r.agentName || r.agentCode} ← ${r.fromAgentName}`
                      : r.agentName || r.agentCode || '—',
              },
              {
                key: 'st',
                label: '态',
                render: (r) => (
                  <span>
                    <StatusBadge status={msgStatus(r)} />{' '}
                    <span className="obs-muted">
                      {r.error ? 'error' : r.streaming ? 'streaming' : 'final'}
                    </span>
                  </span>
                ),
              },
              {
                key: 'text',
                label: '内容',
                render: (r) => <span title={r.text}>{(r.text || '').slice(0, 120) || '—'}</span>,
              },
              {
                key: 'mentions',
                label: '@',
                render: (r) => (r.mentions?.length ? r.mentions.join(', ') : '—'),
              },
              {
                key: 'work',
                label: '工作会话',
                render: (r) => <code className="obs-mono">{r.workSessionKey || '—'}</code>,
              },
              {
                key: 'job',
                label: 'wake job',
                render: (r) => <code className="obs-mono">{r.wakeJobId || '—'}</code>,
              },
            ]}
          />
        ) : null}

        {view === 'merged' ? (
          <ObsTablePanel
            title="合并流水（气泡 + wake）"
            className="span-3"
            rows={mergedRows}
            rowKey={(r) => r.key}
            emptyText={deptId ? '暂无记录' : '暂无部门群会话（key 形如 dept:{id}:chat）'}
            columns={[
              {
                key: 'ts',
                label: '时间',
                render: (r) => fmtTime(r.ts),
              },
              {
                key: 'type',
                label: '类型',
                render: (r) => (r.kind === 'wake' ? 'Wake' : kindLabel(r.msg.kind)),
              },
              {
                key: 'who',
                label: '谁',
                render: (r) => {
                  if (r.kind === 'wake') {
                    return `${r.ev.roleName || r.ev.agentCode} · ${r.ev.status}`
                  }
                  if (r.msg.kind === 'user') return '用户'
                  return r.msg.fromAgentName
                    ? `${r.msg.agentName || r.msg.agentCode} ← ${r.msg.fromAgentName}`
                    : r.msg.agentName || r.msg.agentCode || '—'
                },
              },
              {
                key: 'st',
                label: '态',
                render: (r) =>
                  r.kind === 'wake' ? (
                    <StatusBadge status={wakeStatus(r.ev.status)} />
                  ) : (
                    <StatusBadge status={msgStatus(r.msg)} />
                  ),
              },
              {
                key: 'body',
                label: '内容 / 目标',
                render: (r) => {
                  if (r.kind === 'wake') {
                    const t = [r.ev.goal, r.ev.error].filter(Boolean).join(' · ')
                    return <span title={t}>{(t || '—').slice(0, 140)}</span>
                  }
                  return <span title={r.msg.text}>{(r.msg.text || '').slice(0, 140) || '—'}</span>
                },
              },
              {
                key: 'link',
                label: '关联',
                render: (r) => {
                  if (r.kind === 'wake') {
                    return (
                      <code className="obs-mono">
                        {[r.ev.jobId, r.ev.sourceMsgId].filter(Boolean).join(' ← ') || '—'}
                      </code>
                    )
                  }
                  return (
                    <code className="obs-mono">
                      {[r.msg.wakeJobId, r.msg.workSessionKey].filter(Boolean).join(' · ') || '—'}
                    </code>
                  )
                },
              },
            ]}
          />
        ) : null}
      </ObsPage>
    </>
  )
}

export default DeptGroupChat

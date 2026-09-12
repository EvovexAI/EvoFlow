import { useMemo, useState } from 'react';
import {
  listEvalRuns,
  getEvalRun,
  rerunEval,
  runEval,
  listEvalCases
} from '../api/evalApi';
import { useEvalData } from '../hooks/useEvalData';
import { Card } from '../components/Card';
import { DataTable } from '../components/DataTable';
import { DataSourceBadge, EmptyState, ErrorBanner, LoadingBlock, Modal } from '../components/EvalShared';
import type { EvalCase, EvalRun, EvalRunDetail, EvalType } from '../types';

const typeLabel: Record<string, string> = {
  smoke: '冒烟',
  full: '全量',
  security: '安全',
  performance: '性能',
  custom: '自定义'
};

const statusLabel: Record<string, string> = {
  pending: '等待中',
  running: '进行中',
  completed: '已完成',
  failed: '失败'
};

const statusClass: Record<string, string> = {
  pending: 'status-normal',
  running: 'status-warning',
  completed: 'status-success',
  failed: 'status-failed'
};

const PAGE_SIZE = 5;

function runStatusBadge(status: EvalRun['status']) {
  return <span className={`status-badge ${statusClass[status]}`}>{statusLabel[status]}</span>;
}

function caseStatusBadge(status: string) {
  const cls = status === 'success' ? 'status-success' : status === 'warning' ? 'status-warning' : 'status-failed';
  const label = status === 'success' ? '通过' : status === 'warning' ? '告警' : '失败';
  return <span className={`status-badge ${cls}`}>{label}</span>;
}

/* 评测详情抽屉 */
function DetailDrawer({ run, onClose, onRerun }: { run: EvalRunDetail | null; onClose: () => void; onRerun: () => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!run) return null;
  return (
    <div className="detail-drawer">
      <div className="drawer-header">
        <div>
          <h2>{run.name}</h2>
          <p>{typeLabel[run.type]} · {run.startedAt} · 触发方式：{run.triggeredBy}</p>
        </div>
        <button className="icon-button" onClick={onClose}>×</button>
      </div>

      <div className="drawer-section-title">基本信息</div>
      <div className="kv-list">
        <div><span>状态</span><strong>{runStatusBadge(run.status)}</strong></div>
        <div><span>通过率</span><strong>{run.passRate}%</strong></div>
        <div><span>耗时</span><strong>{run.duration}</strong></div>
        <div><span>执行时间</span><strong>{run.startedAt}</strong></div>
      </div>

      <div className="drawer-section-title">各维度得分</div>
      <div className="dimension-scores">
        {run.dimensions.map((d) => (
          <div className={`dimension-score ${d.status}`} key={d.name}>
            <span>{d.name}</span>
            <strong>{d.score}</strong>
            <em>{caseStatusBadge(d.status)}</em>
          </div>
        ))}
      </div>

      <div className="drawer-section-title">失败 / 告警用例</div>
      <div className="case-list">
        {run.cases.filter((c) => c.status !== 'success').map((c) => (
          <div className={`case-item ${expanded === c.id ? 'expanded' : ''}`} key={c.id}>
            <div className="case-item-head" onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
              <span>{caseStatusBadge(c.status)}</span>
              <strong>{c.name}</strong>
              <em>{c.category}</em>
              <button className="icon-button small">{expanded === c.id ? '−' : '+'}</button>
            </div>
            {expanded === c.id && c.message && <p className="case-message">{c.message}</p>}
          </div>
        ))}
        {run.cases.filter((c) => c.status !== 'success').length === 0 && <p className="muted-text">全部用例通过 ✅</p>}
      </div>

      <div className="drawer-actions">
        <button onClick={onRerun}>重新执行</button>
        <button onClick={() => alert('报告导出（演示）')}>导出报告</button>
        <button onClick={() => alert('版本对比（演示）')}>与另一版本对比</button>
      </div>
    </div>
  );
}

/* 新建评测弹窗 */
function NewEvalModal({ onClose, onCreate, cases }: { onClose: () => void; onCreate: (d: { name: string; type: string; case_ids: string[] }) => void; cases: EvalCase[] }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<EvalType>('smoke');
  const [selected, setSelected] = useState<string[]>(cases.filter((c) => c.enabled).map((c) => c.id));
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <Modal
      title="新建评测"
      onClose={onClose}
      footer={
        <>
          <button className="ghost-btn" onClick={onClose}>取消</button>
          <button className="primary-btn" onClick={() => onCreate({ name, type, case_ids: selected })} disabled={!name}>开始评测 ▶</button>
        </>
      }
    >
      <div className="form-grid">
        <label>评测名称
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：v0.4.2 冒烟测试" />
        </label>
        <label>评测类型
          <select value={type} onChange={(e) => setType(e.target.value as EvalType)}>
            {Object.entries(typeLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <div className="drawer-section-title">选择用例（{selected.length} 已选）</div>
      <div className="case-select-list">
        {cases.map((c) => (
          <label className={`case-select ${selected.includes(c.id) ? 'checked' : ''}`} key={c.id}>
            <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
            <strong>{c.name}</strong>
            <em>{c.level} · {c.severity}</em>
          </label>
        ))}
      </div>
    </Modal>
  );
}

export function EvalHistory() {
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const runs = useEvalData<EvalRun[]>(() => listEvalRuns({ limit: 50, type: typeFilter === 'all' ? undefined : typeFilter, status: statusFilter === 'all' ? undefined : statusFilter }), [typeFilter, statusFilter]);
  const detail = useEvalData<EvalRunDetail | null>(() => (detailId ? getEvalRun(detailId) : Promise.resolve({ data: null, dataSource: 'demo' })), [detailId]);
  const cases = useEvalData<EvalCase[]>(() => listEvalCases({}), []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (runs.data ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.type.includes(q));
  }, [runs.data, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleCreate = async (d: { name: string; type: string; case_ids: string[] }) => {
    await runEval({ name: d.name, type: d.type, case_ids: d.case_ids });
    setShowNew(false);
    runs.reload();
  };

  const handleRerun = async (id: string) => {
    await rerunEval(id);
    detail.reload();
    runs.reload();
  };

  return (
    <>
      <header className="topbar">
        <div className="page-title">
          <h1>评测历史 Evaluation History</h1>
          <p>所有评测任务的执行记录与报告归档</p>
        </div>
        <div className="filter-row">
          <DataSourceBadge source={runs.dataSource} />
          <button className="filter-pill primary-btn" onClick={() => setShowNew(true)}>
            <span>＋</span><strong>新建评测</strong>
          </button>
        </div>
      </header>

      {runs.error && <ErrorBanner message={runs.error} onRetry={runs.reload} />}

      <div className="filter-panel eval-filter-panel">
        <input placeholder="搜索评测名称 / 类型..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <select className="mini-select" value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}>
          <option value="all">全部类型</option>
          {Object.entries(typeLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="mini-select" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
          <option value="all">全部状态</option>
          <option value="completed">已完成</option>
          <option value="running">进行中</option>
          <option value="failed">失败</option>
        </select>
      </div>

      <div className="page-grid">
        <Card title="评测列表" subtitle={`共 ${filtered.length} 条记录`} className="span-3">
          {runs.loading ? (
            <LoadingBlock rows={4} className="" />
          ) : filtered.length === 0 ? (
            <EmptyState title="暂无评测记录" hint="点击「新建评测」创建第一个评测任务" />
          ) : (
            <>
              <DataTable
                rows={pageRows}
                rowKey={(r) => r.id}
                onRowClick={(r) => setDetailId(r.id)}
                columns={[
                  { key: 'name', label: '评测名称' },
                  { key: 'type', label: '类型', render: (r) => <span>{typeLabel[r.type]}</span> },
                  { key: 'passRate', label: '通过率', render: (r) => r.status === 'completed' ? <strong>{r.passRate}%</strong> : <span className="muted-text">—</span> },
                  { key: 'duration', label: '耗时' },
                  { key: 'executedAt', label: '执行时间' },
                  { key: 'status', label: '状态', render: (r) => runStatusBadge(r.status) },
                  { key: 'op', label: '操作', render: (r) => <span className="text-link" onClick={(e) => { e.stopPropagation(); setDetailId(r.id); }}>详情</span> }
                ]}
              />
              <div className="pagination">
                <button className="page-btn" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>‹</button>
                {Array.from({ length: totalPages }).map((_, i) => (
                  <button key={i} className={`page-btn ${page === i + 1 ? 'active' : ''}`} onClick={() => setPage(i + 1)}>{i + 1}</button>
                ))}
                <button className="page-btn" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>›</button>
              </div>
            </>
          )}
        </Card>
      </div>

      {detailId && <DetailDrawer run={detail.data} onClose={() => setDetailId(null)} onRerun={() => handleRerun(detailId)} />}
      {showNew && <NewEvalModal onClose={() => setShowNew(false)} onCreate={handleCreate} cases={cases.data ?? []} />}
    </>
  );
}

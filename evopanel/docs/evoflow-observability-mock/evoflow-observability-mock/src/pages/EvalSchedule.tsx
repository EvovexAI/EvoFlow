import { useState } from 'react';
import { listSchedules, createSchedule, toggleSchedule } from '../api/evalApi';
import { useEvalData } from '../hooks/useEvalData';
import { Card } from '../components/Card';
import { DataTable } from '../components/DataTable';
import { DataSourceBadge, EmptyState, ErrorBanner, LoadingBlock, Modal } from '../components/EvalShared';
import type { EvalSchedule, EvalType } from '../types';

const typeLabel: Record<string, string> = {
  smoke: '冒烟',
  full: '全量',
  security: '安全',
  performance: '性能',
  custom: '自定义'
};

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return <button className={`toggle ${on ? 'on' : ''}`} onClick={onChange}><i /></button>;
}

export function EvalSchedule() {
  const [showNew, setShowNew] = useState(false);
  const schedules = useEvalData<EvalSchedule[]>(() => listSchedules(), []);

  const handleToggle = async (id: string) => {
    await toggleSchedule(id);
    schedules.reload();
  };

  const handleCreate = async (d: { name: string; type: string; frequency: string }) => {
    await createSchedule(d);
    setShowNew(false);
    schedules.reload();
  };

  return (
    <>
      <header className="topbar">
        <div className="page-title">
          <h1>评测计划 Schedule</h1>
          <p>自动化定时评测任务管理</p>
        </div>
        <div className="filter-row">
          <DataSourceBadge source={schedules.dataSource} />
          <button className="filter-pill primary-btn" onClick={() => setShowNew(true)}>
            <span>＋</span><strong>新建计划</strong>
          </button>
        </div>
      </header>

      {schedules.error && <ErrorBanner message={schedules.error} onRetry={schedules.reload} />}

      <div className="page-grid">
        <Card title="计划列表" subtitle="定时评测任务" className="span-3">
          {schedules.loading ? (
            <LoadingBlock rows={3} className="" />
          ) : (schedules.data ?? []).length === 0 ? (
            <EmptyState title="暂无评测计划" hint="点击「新建计划」创建定时评测" />
          ) : (
            <DataTable
              rows={schedules.data ?? []}
              rowKey={(r) => r.id}
              columns={[
                { key: 'name', label: '计划名称' },
                { key: 'type', label: '类型', render: (r) => <span>{typeLabel[r.type]}</span> },
                { key: 'frequency', label: '执行频率' },
                { key: 'lastRun', label: '上次执行', render: (r) => r.lastRun ?? '—' },
                { key: 'nextRun', label: '下次执行' },
                { key: 'enabled', label: '状态', render: (r) => <Toggle on={r.enabled} onChange={() => handleToggle(r.id)} /> },
                { key: 'op', label: '操作', render: () => <span className="text-link">编辑</span> }
              ]}
            />
          )}
        </Card>
      </div>

      {showNew && (
        <NewScheduleModal
          onClose={() => setShowNew(false)}
          onCreate={handleCreate}
        />
      )}
    </>
  );
}

function NewScheduleModal({ onClose, onCreate }: { onClose: () => void; onCreate: (d: { name: string; type: string; frequency: string }) => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<EvalType>('smoke');
  const [frequency, setFrequency] = useState('每天 9:00');
  return (
    <Modal
      title="新建评测计划"
      onClose={onClose}
      footer={
        <>
          <button className="ghost-btn" onClick={onClose}>取消</button>
          <button className="primary-btn" onClick={() => onCreate({ name, type, frequency })} disabled={!name}>保存</button>
        </>
      }
    >
      <div className="form-grid">
        <label>计划名称
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：每日冒烟测试" />
        </label>
        <label>评测类型
          <select value={type} onChange={(e) => setType(e.target.value as EvalType)}>
            {Object.entries(typeLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>执行频率
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            <option>每天 9:00</option>
            <option>每周一 10:00</option>
            <option>每月 1 号 02:00</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}

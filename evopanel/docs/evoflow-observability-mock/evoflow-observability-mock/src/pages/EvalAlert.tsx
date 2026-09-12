import { useState } from 'react';
import { listAlertRules, createAlertRule, toggleAlertRule } from '../api/evalApi';
import { useEvalData } from '../hooks/useEvalData';
import { Card } from '../components/Card';
import { DataTable } from '../components/DataTable';
import { DataSourceBadge, EmptyState, ErrorBanner, LoadingBlock, Modal } from '../components/EvalShared';
import type { AlertRule } from '../types';

const severityLabel: Record<string, string> = {
  critical: '严重',
  warning: '警告',
  info: '提示'
};

const severityClass: Record<string, string> = {
  critical: 'status-failed',
  warning: 'status-warning',
  info: 'status-normal'
};

function severityBadge(s: string) {
  return <span className={`status-badge ${severityClass[s]}`}>{severityLabel[s]}</span>;
}

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return <button className={`toggle ${on ? 'on' : ''}`} onClick={onChange}><i /></button>;
}

export function EvalAlert() {
  const [showNew, setShowNew] = useState(false);
  const rules = useEvalData<AlertRule[]>(() => listAlertRules(), []);

  const handleToggle = async (id: string) => {
    await toggleAlertRule(id);
    rules.reload();
  };

  const handleCreate = async (d: { name: string; metric: string; threshold: string }) => {
    await createAlertRule(d);
    setShowNew(false);
    rules.reload();
  };

  return (
    <>
      <header className="topbar">
        <div className="page-title">
          <h1>告警配置 Alert</h1>
          <p>评测异常自动告警与通知</p>
        </div>
        <div className="filter-row">
          <DataSourceBadge source={rules.dataSource} />
          <button className="filter-pill primary-btn" onClick={() => setShowNew(true)}>
            <span>＋</span><strong>新建规则</strong>
          </button>
        </div>
      </header>

      {rules.error && <ErrorBanner message={rules.error} onRetry={rules.reload} />}

      <div className="page-grid">
        <Card title="告警规则列表" subtitle="评测异常触发通知" className="span-3">
          {rules.loading ? (
            <LoadingBlock rows={3} className="" />
          ) : (rules.data ?? []).length === 0 ? (
            <EmptyState title="暂无告警规则" hint="点击「新建规则」创建告警规则" />
          ) : (
            <DataTable
              rows={rules.data ?? []}
              rowKey={(r) => r.id}
              columns={[
                { key: 'name', label: '规则名称' },
                { key: 'metric', label: '指标' },
                { key: 'threshold', label: '阈值', render: (r) => <span>{r.condition} {r.threshold}</span> },
                { key: 'severity', label: '级别', render: (r) => severityBadge(r.severity) },
                { key: 'channels', label: '通知渠道' },
                { key: 'enabled', label: '状态', render: (r) => <Toggle on={r.enabled} onChange={() => handleToggle(r.id)} /> },
                { key: 'op', label: '操作', render: () => <span className="text-link">编辑</span> }
              ]}
            />
          )}
        </Card>
      </div>

      {showNew && <NewRuleModal onClose={() => setShowNew(false)} onCreate={handleCreate} />}
    </>
  );
}

function NewRuleModal({ onClose, onCreate }: { onClose: () => void; onCreate: (d: { name: string; metric: string; threshold: string }) => void }) {
  const [name, setName] = useState('');
  const [metric, setMetric] = useState('任务完成率');
  const [threshold, setThreshold] = useState('< 80%');
  return (
    <Modal
      title="新建告警规则"
      onClose={onClose}
      footer={
        <>
          <button className="ghost-btn" onClick={onClose}>取消</button>
          <button className="primary-btn" onClick={() => onCreate({ name, metric, threshold })} disabled={!name}>保存</button>
        </>
      }
    >
      <div className="form-grid">
        <label>规则名称
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：任务完成率骤降告警" />
        </label>
        <label>监控指标
          <select value={metric} onChange={(e) => setMetric(e.target.value)}>
            <option>任务完成率</option>
            <option>安全高危漏洞数</option>
            <option>对话 P95 延迟</option>
            <option>工具成功率</option>
          </select>
        </label>
        <label>阈值
          <select value={threshold} onChange={(e) => setThreshold(e.target.value)}>
            <option>&lt; 80%</option>
            <option>&gt; 5s</option>
            <option>&gt; 0</option>
            <option>&lt; 90%</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}

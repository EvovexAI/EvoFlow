import { useState } from 'react';
import { traces } from '../data/mock';
import type { TraceRecord } from '../types';
import { Card } from '../components/Card';
import { StatusBadge } from '../components/StatusBadge';
import { TopFilterBar } from '../components/TopFilterBar';

function TraceTimeline({ trace }: { trace: TraceRecord }) {
  return (
    <div className="trace-timeline">
      {trace.items.map((step, index) => (
        <div className="trace-step" key={step.id}>
          <div className="trace-index">{index + 1}</div>
          <div className="trace-node">
            <div className="trace-step-head"><strong>{step.title}</strong><StatusBadge status={step.status} /></div>
            <p>{step.type} · {step.duration} · {step.meta}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Trace() {
  const [selected, setSelected] = useState(traces[0]);
  return (
    <>
      <TopFilterBar title="会话追踪 Trace" subtitle="完整会话链路、多轮上下文、Agent 内部调用链和调试信息" />
      <div className="trace-layout">
        <Card title="Trace 列表" subtitle="Search trace_id / thread_id / run_id">
          <div className="trace-search"><input placeholder="搜索 trace_id / thread_id / request_id" /></div>
          <div className="trace-list">
            {traces.map((trace) => (
              <button className={selected.id === trace.id ? 'trace-list-item active' : 'trace-list-item'} key={trace.id} onClick={() => setSelected(trace)}>
                <div><strong>{trace.id}</strong><StatusBadge status={trace.status} /></div>
                <p>{trace.summary}</p>
                <span>{trace.agent} · {trace.duration} · {trace.steps} steps</span>
              </button>
            ))}
          </div>
        </Card>
        <Card title={`Trace: ${selected.id}`} subtitle={`${selected.agent} · ${selected.threadId} · ${selected.startedAt}`} actions={<div className="tabs"><button className="active">Timeline</button><button>Tree</button><button>Message</button></div>} className="trace-detail-card">
          <div className="trace-summary-strip">
            <span>Duration <strong>{selected.duration}</strong></span>
            <span>Steps <strong>{selected.steps}</strong></span>
            <span>Status <StatusBadge status={selected.status} /></span>
            <span>Agent <strong>{selected.agent}</strong></span>
          </div>
          <TraceTimeline trace={selected} />
        </Card>
      </div>
    </>
  );
}

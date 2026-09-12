import { OBS_TIME_RANGE_OPTIONS, type ObsStatusFilter } from '../lib/obs-types'
import { useObsContext } from '../hooks/ObsContext'
import { CustomSelect } from './CustomSelect'

export function TopFilterBar({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: React.ReactNode; children?: React.ReactNode }) {
  const obs = useObsContext()
  const timeLabel = OBS_TIME_RANGE_OPTIONS.find((o) => o.key === obs.timeRange)?.label ?? obs.timeRange
  const agentLabel = obs.agentFilter === 'all' ? '全部' : obs.agentFilter

  const timeOptions = OBS_TIME_RANGE_OPTIONS.map((o) => ({ value: o.key, label: o.label }))
  const agentOptions = [
    { value: 'all', label: '全部' },
    ...obs.agents
      .map((agent) => {
        const value = agent.id || agent.name || ''
        if (!value) return null
        return { value, label: agent.display_name || agent.name || value }
      })
      .filter(Boolean) as { value: string; label: string }[],
    { value: 'main', label: 'main' },
  ]
  // 从最近的请求记录中提取唯一的 models 和 providers
  const recentRequests = obs.recentRequests || []
  const uniqueModels = Array.from(new Set(recentRequests.map(r => r.model).filter(Boolean)))
  const uniqueProviders = Array.from(new Set(recentRequests.map(r => r.provider).filter(Boolean)))
  
  const modelOptions = [
    { value: 'all', label: '全部' },
    ...uniqueModels.map(m => ({ value: m, label: m })),
  ]
  const providerOptions = [
    { value: 'all', label: '全部' },
    ...uniqueProviders.map(p => ({ value: p, label: p })),
  ]
  const statusOptions = [
    { value: 'all', label: '全部' },
    { value: 'success', label: '成功' },
    { value: 'warning', label: '警告' },
    { value: 'error', label: '失败' },
  ]

  return (
    <header className="topbar">
      <div className="topbar-head">
        <div className="page-title">
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions}
      </div>
      <div className="filter-row">
        <CustomSelect
          className="filter-pill"
          value={obs.timeRange}
          onChange={(v) => obs.setTimeRange(v as typeof obs.timeRange)}
          options={timeOptions}
          label="时间范围"
        >
          <strong>{timeLabel}</strong>
        </CustomSelect>
        <CustomSelect
          className="filter-pill"
          value={obs.agentFilter}
          onChange={(v) => obs.setAgentFilter(v)}
          options={agentOptions}
          label="Agent 类型"
        >
          <strong>{agentLabel}</strong>
        </CustomSelect>
        <CustomSelect
          className="filter-pill"
          value={obs.modelFilter}
          onChange={(v) => obs.setModelFilter(v)}
          options={modelOptions}
          label="模型"
        >
          <strong>{obs.modelFilter === 'all' ? '全部' : obs.modelFilter}</strong>
        </CustomSelect>
        <CustomSelect
          className="filter-pill"
          value={obs.providerFilter}
          onChange={(v) => obs.setProviderFilter(v)}
          options={providerOptions}
          label="厂商"
        >
          <strong>{obs.providerFilter === 'all' ? '全部' : obs.providerFilter}</strong>
        </CustomSelect>
        <CustomSelect
          className="filter-pill"
          value={obs.statusFilter}
          onChange={(v) => obs.setStatusFilter(v as ObsStatusFilter)}
          options={statusOptions}
          label="状态"
        >
          <strong>{obs.statusFilter === 'all' ? '全部' : obs.statusFilter}</strong>
        </CustomSelect>
        <button type="button" className={`filter-pill refresh${obs.loading ? ' spinning' : ''}`} onClick={() => obs.reload()}>
          <i className="refresh-icon">↻</i><span>刷新</span>
        </button>
        {children ? <div className="filter-inline-search">{children}</div> : null}
      </div>
    </header>
  )
}

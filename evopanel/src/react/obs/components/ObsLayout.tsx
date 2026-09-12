import type { ReactNode } from 'react'

/**
 * Obs 页面布局 — 全站统一「统计卡片 + 内容卡片/表格」模式：
 *
 * ```tsx
 * <ObsPage>
 *   <ObsStatStrip>
 *     <ObsStatItem label="指标" value={n} hint="说明" />
 *   </ObsStatStrip>
 *   <ObsSection title="图表/列表">...</ObsSection>
 *   <ObsTablePanel title="明细表" columns={...} rows={...} rowKey={...} />
 * </ObsPage>
 * ```
 */
export function ObsPage({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`page-grid page-grid-modern obs-page ${className}`.trim()}>{children}</div>
}

export type ObsStatItemProps = {
  label: string
  value: ReactNode
  hint?: ReactNode
  variant?: 'default' | 'accent' | 'savings' | 'danger'
}

/** 单个统计卡片 */
export function ObsStatItem({ label, value, hint, variant = 'default' }: ObsStatItemProps) {
  return (
    <div className={`obs-stat-item obs-stat-item--${variant}`}>
      <span className="obs-stat-item__label">{label}</span>
      <span className="obs-stat-item__value">{value}</span>
      {hint != null && hint !== '' && <em className="obs-stat-item__hint">{hint}</em>}
    </div>
  )
}

/** 顶部统计条 — 横向排列多个 ObsStatItem */
export function ObsStatStrip({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`obs-stat-strip ${className}`.trim()}>{children}</div>
}

export type ObsSectionProps = {
  title?: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** 无 padding 内容区（表格/list 自带圆角时使用） */
  flush?: boolean
  empty?: ReactNode
  isEmpty?: boolean
}

/**
 * 内容卡片 — 白底圆角区块，带标题/副标题/操作区。
 * 列表、图表、表格等都应包在此组件内。
 */
export function ObsSection({
  title,
  subtitle,
  actions,
  children,
  className = '',
  flush = false,
  empty,
  isEmpty = false,
}: ObsSectionProps) {
  return (
    <section className={`obs-section ${flush ? 'obs-section--flush' : ''} ${className}`.trim()}>
      {(title || actions) && (
        <div className="obs-section__header">
          <div className="obs-section__titles">
            {title && <h3 className="obs-section__title">{title}</h3>}
            {subtitle && <p className="obs-section__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="obs-section__actions">{actions}</div>}
        </div>
      )}
      <div className="obs-section__body">
        {isEmpty && empty != null ? empty : children}
      </div>
    </section>
  )
}

/** iOS 分组列表容器 */
export function ObsGroup({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`obs-group ${className}`.trim()}>
      {title && <h2 className="obs-group__title">{title}</h2>}
      <div className="obs-group__card">{children}</div>
    </div>
  )
}

export type ObsListRowMetric = {
  label: string
  value: ReactNode
  tone?: 'default' | 'highlight' | 'savings'
}

/** 分组列表中的一行（厂商 / Agent 概览） */
export function ObsListRow({
  title,
  badge,
  metrics,
}: {
  title: ReactNode
  badge?: ReactNode
  metrics: ObsListRowMetric[]
}) {
  return (
    <div className="obs-list-row">
      <div className="obs-list-row__head">
        <h4 className="obs-list-row__title">{title}</h4>
        {badge}
      </div>
      <div className="obs-list-row__metrics">
        {metrics.map((m) => (
          <div key={String(m.label)} className={`obs-metric-cell obs-metric-cell--${m.tone ?? 'default'}`}>
            <span>{m.label}</span>
            <strong>{m.value}</strong>
          </div>
        ))}
      </div>
    </div>
  )
}

export type ObsTableColumn<T> = {
  key: string
  label: string
  render?: (row: T) => ReactNode
}

/**
 * 表格卡片 — ObsSection + 标准表格样式 + 空状态。
 * 各页明细表统一用此组件。
 */
export function ObsTablePanel<T extends object>({
  title,
  subtitle,
  actions,
  footer,
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyText = '暂无数据',
  className = '',
  compact = false,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
  /** 表格底部分页等区域 */
  footer?: ReactNode
  columns: ObsTableColumn<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string
  onRowClick?: (row: T) => void
  emptyText?: string
  className?: string
  compact?: boolean
}) {
  const isEmpty = rows.length === 0
  return (
    <ObsSection
      title={title}
      subtitle={subtitle}
      actions={actions}
      className={className}
      flush
      isEmpty={isEmpty}
      empty={<div className="obs-empty-state">{emptyText}</div>}
    >
      <div className={`obs-table-wrap ${compact ? 'obs-table-wrap--compact' : ''}`}>
        <table className="obs-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={rowKey(row, index)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={onRowClick ? 'obs-table__row--clickable' : undefined}
              >
                {columns.map((col) => (
                  <td key={col.key}>{col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer && !isEmpty && <div className="obs-table-footer">{footer}</div>}
    </ObsSection>
  )
}

export type ObsPaginationProps = {
  page: number
  pageSize: number
  total?: number
  totalPages?: number
  onPageChange: (page: number) => void
}

/** 表格底部分页 — 显示总条数、每页大小、页码 */
export function ObsPagination({ page, pageSize, total, totalPages, onPageChange }: ObsPaginationProps) {
  const pages =
    totalPages != null && totalPages > 0
      ? totalPages
      : total != null && total > 0
        ? Math.max(1, Math.ceil(total / pageSize))
        : null
  const canPrev = page > 1
  const canNext = pages != null ? page < pages : false

  const rangeStart = total != null && total > 0 ? (page - 1) * pageSize + 1 : null

  const info =
    total != null && total > 0 && rangeStart != null
      ? `共 ${total.toLocaleString()} 条 · 每页 ${pageSize} 条 · 显示 ${rangeStart}–${Math.min(page * pageSize, total)}`
      : `每页 ${pageSize} 条`

  return (
    <div className="obs-pagination">
      <span className="obs-pagination__info">{info}</span>
      <div className="obs-pagination__controls">
        <button type="button" className="obs-pagination__btn" disabled={!canPrev} onClick={() => onPageChange(page - 1)}>
          上一页
        </button>
        <span className="obs-pagination__page">
          {pages != null ? `第 ${page} / ${pages} 页` : `第 ${page} 页`}
        </span>
        <button type="button" className="obs-pagination__btn" disabled={!canNext} onClick={() => onPageChange(page + 1)}>
          下一页
        </button>
      </div>
    </div>
  )
}

/** iOS 分段切换 */
export function ObsSegmentTabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="obs-segment-tabs" role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          className={value === opt.value ? 'active' : ''}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

/** 加载 / 错误横幅 */
export function ObsBanner({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' }) {
  return <div className={`obs-banner obs-banner--${tone}`}>{children}</div>
}

/** 空状态 */
export function ObsEmpty({ children }: { children: ReactNode }) {
  return <div className="obs-empty-state">{children}</div>
}

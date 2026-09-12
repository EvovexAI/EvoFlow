const filters = [
  ['时间范围', '7d'],
  ['Agent', '全部'],
  ['Model', '全部'],
  ['Provider', '全部'],
  ['Status', '全部']
];

export function TopFilterBar({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="topbar">
      <div className="page-title">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="filter-row">
        {filters.map(([label, value]) => (
          <button className="filter-pill" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <i>⌄</i>
          </button>
        ))}
        <button className="filter-pill refresh"><span>↻ 自动刷新</span><strong>30s</strong><i>⌄</i></button>
      </div>
    </header>
  );
}

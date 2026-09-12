import type { NavKey } from '../types';

const items: Array<{ key: NavKey; label: string; icon: string }> = [
  { key: 'dashboard', label: '总览', icon: '⌂' },
  { key: 'requests', label: '调用记录', icon: '☷' },
  { key: 'agents', label: 'Agent', icon: '♙' },
  { key: 'models', label: '模型与厂商', icon: '◇' },
  { key: 'tools', label: '工具', icon: '⚒' },
  { key: 'tool-calls', label: '工具调用', icon: '⚙' },
  { key: 'mcp', label: 'MCP', icon: '⬡' },
  { key: 'gateway', label: '网关', icon: '◎' },
  { key: 'trace', label: '链路追踪', icon: '⌁' },
  { key: 'analytics', label: '分析', icon: '▥' },
  { key: 'code-index', label: '代码索引', icon: '⌘' },
  { key: 'settings', label: '设置', icon: '⚙' }
];

export function Sidebar({ active, onChange }: { active: NavKey; onChange: (key: NavKey) => void }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">E</div>
        <div>
          <strong>EvoFlow</strong>
          <span>Observability</span>
        </div>
      </div>
      <nav className="nav-list">
        {items.map((item) => (
          <button key={item.key} className={active === item.key ? 'nav-item active' : 'nav-item'} onClick={() => onChange(item.key)}>
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="team-card">
        <div className="team-avatar">E</div>
        <div>
          <strong>EvoFlow Team</strong>
          <span>Enterprise Plan</span>
        </div>
        <span className="chevron">⌄</span>
      </div>
    </aside>
  );
}

import type { NavKey } from '../types';

interface SidebarItem {
  key: NavKey;
  label: string;
  icon: string;
}

interface SidebarGroup {
  label?: string;
  items: SidebarItem[];
}

const groups: SidebarGroup[] = [
  {
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: '⌂' },
      { key: 'requests', label: 'Requests', icon: '☷' },
      { key: 'agents', label: 'Agents', icon: '♙' },
      { key: 'models', label: 'Models', icon: '◇' },
      { key: 'tools', label: 'Tools', icon: '⚒' },
      { key: 'gateway', label: 'Gateway', icon: '◎' },
      { key: 'trace', label: 'Trace', icon: '⌁' },
      { key: 'analytics', label: 'Analytics', icon: '▥' }
    ]
  },
  {
    label: '评测中心',
    items: [
      { key: 'eval-dashboard', label: '健康总览', icon: '📊' },
      { key: 'eval-business', label: '业务质量', icon: '📈' },
      { key: 'eval-security', label: '安全中心', icon: '🔒' },
      { key: 'eval-performance', label: '性能基准', icon: '⚡' },
      { key: 'eval-history', label: '评测历史', icon: '📋' },
      { key: 'eval-schedule', label: '评测计划', icon: '⏰' },
      { key: 'eval-alert', label: '告警配置', icon: '🔔' }
    ]
  },
  {
    items: [
      { key: 'settings', label: 'Settings', icon: '⚙' }
    ]
  }
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
        {groups.map((group, groupIndex) => (
          <div className="nav-group" key={groupIndex}>
            {group.label && <div className="nav-group-label">{group.label}</div>}
            {group.items.map((item) => (
              <button key={item.key} className={active === item.key ? 'nav-item active' : 'nav-item'} onClick={() => onChange(item.key)}>
                <span className="nav-icon">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
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

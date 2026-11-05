import type { NavKey } from '../types';

const items: Array<{ key: NavKey; label: string; icon: string }> = [
  { key: 'dashboard', label: '总览', icon: '⌂' },
  { key: 'requests', label: '调用记录', icon: '☷' },
  { key: 'channel-messages', label: '渠道消息', icon: '✉' },
  { key: 'channel-bindings', label: '渠道绑定', icon: '☍' },
  { key: 'dept-group-chat', label: '部门群聊', icon: '☰' },
  { key: 'media-generation', label: '生图生视频', icon: '▤' },
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

function leaveObservability() {
  // Hash 路由：回到主对话；cleanup 会恢复被隐藏的侧栏 / main-col。
  window.location.hash = '/chat'
}

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
      <button
        type="button"
        className="nav-item obs-back-to-chat"
        onClick={leaveObservability}
        title="返回对话"
        aria-label="返回对话"
      >
        <span className="nav-icon" aria-hidden>
          ←
        </span>
        <span>返回对话</span>
      </button>
      <nav className="nav-list">
        {items.map((item) => (
          <button key={item.key} className={active === item.key ? 'nav-item active' : 'nav-item'} onClick={() => onChange(item.key)}>
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <button
        type="button"
        className="team-card obs-back-to-chat-card"
        onClick={leaveObservability}
        title="返回对话"
        aria-label="返回对话"
      >
        <div className="team-avatar" aria-hidden>
          ←
        </div>
        <div>
          <strong>返回对话</strong>
          <span>离开运维观测</span>
        </div>
      </button>
    </aside>
  );
}

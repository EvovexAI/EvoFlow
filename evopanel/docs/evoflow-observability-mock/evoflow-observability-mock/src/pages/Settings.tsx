import { Card } from '../components/Card';
import { TopFilterBar } from '../components/TopFilterBar';

function SettingRow({ label, desc, control }: { label: string; desc: string; control: string }) {
  return (
    <div className="setting-row">
      <div><strong>{label}</strong><span>{desc}</span></div>
      <button>{control}</button>
    </div>
  );
}

export function Settings() {
  return (
    <>
      <TopFilterBar title="设置 Settings" subtitle="数据源、主题、刷新、脱敏、导出和观测平台配置" />
      <div className="settings-grid">
        <Card title="General" subtitle="默认视图与刷新策略">
          <SettingRow label="默认时间范围" desc="进入平台时默认展示的时间范围" control="7d⌄" />
          <SettingRow label="默认刷新间隔" desc="用于 Dashboard 和实时请求流" control="30s⌄" />
          <SettingRow label="默认首页" desc="打开观测平台时首先进入的页面" control="Dashboard⌄" />
          <SettingRow label="全屏模式" desc="脱离主界面，以独立窗口展示" control="Enabled" />
        </Card>
        <Card title="Data Source" subtitle="SQLite 与数据保留策略">
          <SettingRow label="SQLite 路径" desc="后端观测数据文件路径" control="/data/evoflow.db" />
          <SettingRow label="数据保留周期" desc="超过周期的数据将进入归档或清理" control="90 days⌄" />
          <SettingRow label="自动清理" desc="定期清理低价值日志和中间态数据" control="Disabled" />
        </Card>
        <Card title="Observability" subtitle="记录范围与脱敏规则">
          <SettingRow label="记录 Prompt" desc="保存模型请求体，支持详情抽屉查看" control="Enabled" />
          <SettingRow label="记录 Response" desc="保存模型返回体，便于复盘和调试" control="Enabled" />
          <SettingRow label="记录 Tool Input / Output" desc="保存工具调用入参与返回摘要" control="Enabled" />
          <SettingRow label="敏感字段脱敏" desc="自动屏蔽 api_key、token、password 等字段" control="Strict⌄" />
        </Card>
        <Card title="Theme & Export" subtitle="界面主题与数据导出">
          <SettingRow label="主题" desc="支持亮色、暗色和跟随系统" control="Dark⌄" />
          <SettingRow label="Accent Color" desc="主色用于按钮、选中态和图表重点线" control="Blue⌄" />
          <SettingRow label="Compact Mode" desc="提高表格和卡片信息密度" control="Enabled" />
          <SettingRow label="导出格式" desc="支持 JSON、CSV、Parquet" control="JSON / CSV⌄" />
        </Card>
      </div>
    </>
  );
}

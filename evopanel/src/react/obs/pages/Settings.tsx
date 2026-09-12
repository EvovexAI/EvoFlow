import { useEffect, useState } from 'react'
import { getThemePreference, setThemePreference } from '../../../lib/theme.js'
import { fetchObsStatus } from '../lib/obs-api'
import { ObsPage, ObsSection } from '../components/ObsLayout'
import { TopFilterBar } from '../components/TopFilterBar'

const THEME_LABELS: Record<'light' | 'dark' | 'system', string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
}

function SettingRow({
  label,
  desc,
  control,
  onControlClick,
}: {
  label: string
  desc: string
  control: string
  onControlClick?: () => void
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{label}</strong>
        <span>{desc}</span>
      </div>
      <button type="button" onClick={onControlClick} disabled={!onControlClick}>
        {control}
      </button>
    </div>
  )
}

function ThemeSettingRow() {
  const [pref, setPref] = useState<'light' | 'dark' | 'system'>(() => getThemePreference())

  useEffect(() => {
    const sync = () => setPref(getThemePreference())
    window.addEventListener('evopanel-theme-pref-changed', sync)
    return () => window.removeEventListener('evopanel-theme-pref-changed', sync)
  }, [])

  return (
    <div className="setting-row setting-row--theme">
      <div>
        <strong>主题</strong>
        <span>与 EvoPanel 全局主题同步，支持亮色、暗色和跟随系统</span>
      </div>
      <div className="obs-theme-row" role="group" aria-label="主题">
        {(['light', 'dark', 'system'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={`obs-theme-btn${pref === key ? ' obs-theme-btn--active' : ''}`}
            onClick={() => {
              setThemePreference(key)
              setPref(key)
            }}
          >
            {THEME_LABELS[key]}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Settings() {
  const [status, setStatus] = useState<{ enabled?: boolean; sqlite_path?: string }>({})

  useEffect(() => {
    void fetchObsStatus().then((res) => setStatus(res as { enabled?: boolean; sqlite_path?: string }))
  }, [])

  return (
    <>
      <TopFilterBar title="设置" subtitle="数据源、观测记录范围与平台配置" />
      <ObsPage className="settings-grid">
        <ObsSection title="常规" subtitle="默认视图与刷新策略">
          <SettingRow label="默认时间范围" desc="进入平台时默认展示的时间范围" control="7d⌄" />
          <SettingRow label="默认刷新间隔" desc="用于 Dashboard 和实时请求流" control="手动刷新" />
          <SettingRow label="默认首页" desc="打开观测平台时首先进入的页面" control="Dashboard⌄" />
          <SettingRow label="全屏模式" desc="脱离主界面，以独立窗口展示" control="已启用" />
        </ObsSection>
        <ObsSection title="数据源" subtitle="SQLite 与数据保留策略">
          <SettingRow label="SQLite 路径" desc="后端观测数据文件路径" control={status.sqlite_path || '—'} />
          <SettingRow
            label="观测状态"
            desc="观测服务连接状态"
            control={status.enabled ? '已启用' : '未启用'}
          />
          <SettingRow label="数据保留周期" desc="超过周期的数据将进入归档或清理" control="见 backend 配置" />
        </ObsSection>
        <ObsSection title="观测记录" subtitle="记录范围与脱敏规则">
          <SettingRow label="记录 Prompt" desc="保存模型请求体，支持详情抽屉查看" control="已启用" />
          <SettingRow label="记录 Response" desc="保存模型返回体，便于复盘和调试" control="已启用" />
          <SettingRow label="记录 Tool Input / Output" desc="保存工具调用入参与返回摘要" control="已启用" />
          <SettingRow label="敏感字段脱敏" desc="自动屏蔽 api_key、token、password 等字段" control="严格⌄" />
        </ObsSection>
        <ObsSection title="主题与导出" subtitle="界面主题与数据导出">
          <ThemeSettingRow />
          <SettingRow label="成本估算" desc="需要模型单价配置后启用" control="待接入" />
          <SettingRow label="导出格式" desc="支持 JSON、CSV" control="JSON / CSV⌄" />
        </ObsSection>
      </ObsPage>
    </>
  )
}

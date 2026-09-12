import { useCallback, useState, type ComponentType } from 'react'
import { AlertPage } from './pages/AlertPage'
import { BusinessPage } from './pages/BusinessPage'
import { CasesPage } from './pages/CasesPage'
import { DashboardPage } from './pages/DashboardPage'
import { EmployeesEvalPage } from './pages/EmployeesEvalPage'
import { HistoryPage } from './pages/HistoryPage'
import { PerformancePage } from './pages/PerformancePage'
import { SchedulePage } from './pages/SchedulePage'
import { SecurityPage } from './pages/SecurityPage'
import { WorkflowEvalPage } from './pages/WorkflowEvalPage'
import './styles/eval.css'

export type EvalNavKey =
  | 'dashboard'
  | 'cases'
  | 'employees'
  | 'workflow'
  | 'business'
  | 'security'
  | 'performance'
  | 'history'
  | 'schedule'
  | 'alert'

const NAV: { key: EvalNavKey; label: string; icon: string; hint?: string }[] = [
  { key: 'dashboard', label: '健康总览', icon: '🏠', hint: '跑评测' },
  { key: 'cases', label: '① 测什么', icon: '📚', hint: '用例内容' },
  { key: 'employees', label: '智能体员工', icon: '👤', hint: '能不能用 / 协同' },
  { key: 'workflow', label: '工作流', icon: '🔀', hint: '规则 / 真跑任务' },
  { key: 'history', label: '②③ 结果详情', icon: '📋', hint: '结果+证据' },
  { key: 'business', label: '业务质量', icon: '💡' },
  { key: 'security', label: '安全中心', icon: '🛡️' },
  { key: 'performance', label: '性能基准', icon: '⚡' },
  { key: 'schedule', label: '评测计划', icon: '📅' },
  { key: 'alert', label: '告警配置', icon: '🔔' },
]

const PAGES: Record<EvalNavKey, ComponentType<{ onNavigate?: (k: string) => void }>> = {
  dashboard: DashboardPage,
  cases: CasesPage,
  employees: EmployeesEvalPage,
  workflow: WorkflowEvalPage,
  business: BusinessPage,
  security: SecurityPage,
  performance: PerformancePage,
  history: HistoryPage,
  schedule: SchedulePage,
  alert: AlertPage,
}

const STORAGE_KEY = 'eval_active_page'

function initialNav(): EvalNavKey {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY)
    if (saved && NAV.some((n) => n.key === saved)) return saved as EvalNavKey
  } catch {
    /* ignore */
  }
  return 'dashboard'
}

export default function EvalApp() {
  const [active, setActive] = useState<EvalNavKey>(initialNav)

  const navigate = useCallback((key: string) => {
    if (!NAV.some((n) => n.key === key)) return
    const k = key as EvalNavKey
    setActive(k)
    try {
      sessionStorage.setItem(STORAGE_KEY, k)
    } catch {
      /* ignore */
    }
  }, [])

  const Page = PAGES[active]

  return (
    <div className="eval-root">
      <aside className="eval-sidebar">
        <div className="eval-brand">
          🧪 评测中心
          <span>真实业务回归 · 可核验证据</span>
        </div>
        <nav className="eval-sidebar-nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              type="button"
              className={`eval-nav-btn ${active === n.key ? 'active' : ''}`}
              onClick={() => navigate(n.key)}
            >
              <span className="nav-ico" aria-hidden>
                {n.icon}
              </span>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="eval-back">
          <a href="#/chat">← 返回工作台</a>
        </div>
      </aside>
      <main className="eval-main">
        <Page onNavigate={navigate} />
      </main>
    </div>
  )
}

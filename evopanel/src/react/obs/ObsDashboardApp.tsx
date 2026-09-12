import { useCallback, useState, type ComponentType, type ReactNode } from 'react'
import { Shell } from './components/Shell'
import { ObsProvider } from './hooks/ObsContext'
import { ThreadTitleProvider } from './hooks/useThreadTitles'
import { Analytics } from './pages/Analytics'
import { Agents } from './pages/Agents'
import { CodeIndex } from './pages/CodeIndex'
import { Dashboard } from './pages/Dashboard'
import { Gateway } from './pages/Gateway'
import { McpServers } from './pages/McpServers'
import { Models } from './pages/Models'
import { Requests } from './pages/Requests'
import { Settings } from './pages/Settings'
import { Tools } from './pages/Tools'
import { ToolCallsTable } from './pages/ToolCallsTable'
import { Trace } from './pages/Trace'
import type { NavKey } from './types'
import './styles/global.css'
import './styles/modern-panel.css'

const OBS_ACTIVE_PAGE_KEY = 'obs_active_page'

const VALID_NAV_KEYS: NavKey[] = [
  'dashboard',
  'requests',
  'agents',
  'models',
  'tools',
  'tool-calls',
  'mcp',
  'gateway',
  'trace',
  'analytics',
  'settings',
  'code-index',
]

function getInitialActivePage(): NavKey {
  try {
    const saved = sessionStorage.getItem(OBS_ACTIVE_PAGE_KEY)
    if (saved && (VALID_NAV_KEYS as readonly string[]).includes(saved)) {
      return saved as NavKey
    }
  } catch {
    /* ignore */
  }
  return 'dashboard'
}

type PageProps = { onNavigate?: (key: string) => void }

const PAGE_COMPONENTS: Record<NavKey, ComponentType<PageProps>> = {
  dashboard: Dashboard,
  requests: Requests,
  agents: Agents,
  models: Models,
  tools: Tools,
  'tool-calls': ToolCallsTable,
  mcp: McpServers,
  gateway: Gateway,
  trace: Trace,
  analytics: Analytics,
  settings: Settings,
  'code-index': CodeIndex,
}

/** 已访问过的页面保持挂载，切换菜单时不再重复请求 */
function ObsKeepAlivePages({
  active,
  mounted,
  onNavigate,
}: {
  active: NavKey
  mounted: ReadonlySet<NavKey>
  onNavigate: (key: string) => void
}) {
  const layers: ReactNode[] = []
  for (const key of mounted) {
    const Page = PAGE_COMPONENTS[key]
    const hidden = key !== active
    layers.push(
      <div
        key={key}
        className={hidden ? 'obs-page-layer obs-page-layer--hidden' : 'obs-page-layer'}
        aria-hidden={hidden}
      >
        <Page onNavigate={onNavigate} />
      </div>,
    )
  }
  return <>{layers}</>
}

export default function ObsDashboardApp() {
  const initial = getInitialActivePage()
  const [active, setActive] = useState<NavKey>(initial)
  const [mounted, setMounted] = useState<ReadonlySet<NavKey>>(() => new Set([initial]))

  const setActiveAndPersist = useCallback((key: NavKey) => {
    setMounted((prev) => {
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      return next
    })
    setActive(key)
    try {
      sessionStorage.setItem(OBS_ACTIVE_PAGE_KEY, key)
    } catch {
      /* ignore */
    }
  }, [])

  const handleNavigate = useCallback(
    (key: string) => {
      setActiveAndPersist(key as NavKey)
    },
    [setActiveAndPersist],
  )

  return (
    <div className="obs-dashboard-root">
      <ThreadTitleProvider>
        <ObsProvider>
          <Shell active={active} onChange={setActiveAndPersist}>
            <ObsKeepAlivePages active={active} mounted={mounted} onNavigate={handleNavigate} />
          </Shell>
        </ObsProvider>
      </ThreadTitleProvider>
    </div>
  )
}

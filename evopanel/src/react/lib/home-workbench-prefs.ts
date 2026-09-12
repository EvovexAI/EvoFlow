const PREFS_KEY = 'evopanel_home_workbench_prefs_v1'

export type HomeWorkbenchPrefs = {
  modules: {
    composer: boolean
    kpis: boolean
    trend: boolean
    source: boolean
    todos: boolean
    recent: boolean
    quick: boolean
    apps: boolean
  }
  /** 卡片顺序：top 三栏 / bottom 三栏 */
  topOrder: Array<'trend' | 'source' | 'todos'>
  bottomOrder: Array<'recent' | 'quick' | 'apps'>
  defaultRange: '7d' | '14d' | '30d'
  listLimit: number
}

export const DEFAULT_HOME_PREFS: HomeWorkbenchPrefs = {
  modules: {
    composer: true,
    kpis: true,
    trend: true,
    source: true,
    todos: true,
    recent: true,
    quick: true,
    apps: true,
  },
  topOrder: ['trend', 'source', 'todos'],
  bottomOrder: ['recent', 'quick', 'apps'],
  defaultRange: '7d',
  listLimit: 6,
}

export function loadHomeWorkbenchPrefs(): HomeWorkbenchPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...DEFAULT_HOME_PREFS, modules: { ...DEFAULT_HOME_PREFS.modules } }
    const parsed = JSON.parse(raw) as Partial<HomeWorkbenchPrefs>
    return {
      ...DEFAULT_HOME_PREFS,
      ...parsed,
      modules: { ...DEFAULT_HOME_PREFS.modules, ...(parsed.modules || {}) },
      topOrder: parsed.topOrder?.length === 3 ? parsed.topOrder : DEFAULT_HOME_PREFS.topOrder,
      bottomOrder: parsed.bottomOrder?.length === 3 ? parsed.bottomOrder : DEFAULT_HOME_PREFS.bottomOrder,
      listLimit: Math.min(20, Math.max(3, Number(parsed.listLimit) || 6)),
    }
  } catch {
    return { ...DEFAULT_HOME_PREFS, modules: { ...DEFAULT_HOME_PREFS.modules } }
  }
}

export function saveHomeWorkbenchPrefs(prefs: HomeWorkbenchPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
}

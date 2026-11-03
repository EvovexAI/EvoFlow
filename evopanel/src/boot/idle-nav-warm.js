/**
 * Boot 完成后的空闲预热：把高频菜单页模块 chunk 提前拉进 _moduleCache。
 *
 * 背景：路由模块是首次点击才动态 import（_moduleCache 未命中即冷加载），
 * 侧栏 hover 预热覆盖不到键盘/快速点击路径。boot 完成后短延迟逐个 warm，
 * 用户之后首次点击各菜单页免等模块加载。
 *
 * 动态段（/apps/:id 等）按 pattern 缓存；warm 任一 id 即可覆盖同 pattern。
 *
 * 只 warm 模块（不预取数据）：数据有 TTL 与时新鲜度问题，交给 nav-panel-prefetch
 * 的 hover 路径继续负责。串行 + 短间隔，避免抢占首屏带宽。
 */
import { prefetchRoute } from '../router.js'

/** 高频菜单 + 常见二级页 pattern（占位 id 仅用于命中 resolveLoader） */
const IDLE_WARM_ROUTES = [
  '/tasks',
  '/apps',
  '/apps/__warm__',
  '/proactive',
  '/knowledge',
  '/assets',
  '/cron',
  '/expert',
  '/models',
  '/settings',
  '/logs',
  '/observability',
]

let _warmed = false

export function warmFrequentMenuModules() {
  if (_warmed) return
  _warmed = true

  const run = () => {
    let i = 0
    const next = () => {
      if (i >= IDLE_WARM_ROUTES.length) return
      const path = IDLE_WARM_ROUTES[i++]
      void prefetchRoute(path)
        .catch(() => {})
        .finally(() => {
          // Stagger so ChatApp first paint / gateway traffic stay responsive.
          setTimeout(next, 180)
        })
    }
    next()
  }

  // Prefer idle, but don't wait up to 10s — users click menus within ~1–2s of boot.
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 1800 })
  } else {
    setTimeout(run, 900)
  }
}

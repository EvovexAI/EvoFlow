/**
 * EvoFlow 启动期 3 个兜底机制（v3.5 阶段 F1 commit 2 抽出）。
 *
 * 1. **syncAppOccluded** — 窗口失焦时给 <html data-app-occluded="1">，
 *    CSS 用这个属性暂停无限动画（Mac 省电 / 合成器优化）。
 *    visibilitychange 监听 + 启动时立即同步一次。
 *
 * 2. **killSkillhubEmbed** — 关掉历史遗留的 SkillHub 原生悬浮 WebView
 *    （曾遮挡整个客户端）。hashchange 时也重杀一次,防止路由跳转后
 *    SkillHub 又挂回来。仅 Tauri 桌面端生效。
 *
 * 3. **DYNAMIC_IMPORT_RECOVERY** — 监听 unhandledrejection,
 *    检测到 "Failed to fetch dynamically imported module"
 *    (Vite HMR/缓存失效/网络抖动典型症状) 时,自动 reload 一次。
 *    reload 后 15 秒内不再二次 reload（避免 reload 风暴）。
 *    sessionStorage 标记防止页面重载前后的循环。
 *
 * 这 3 块都是"启动期一次性副作用,不需要 export,不需要被外部调用",
 * 所以 module body 顶层副作用即可,不放 init() 包装。
 */
import { isTauri } from '../lib/panel-login.js'

// === 1. visibility 兜底 ===
const syncAppOccluded = () => {
  try {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    if (hidden) document.documentElement.setAttribute('data-app-occluded', '1')
    else document.documentElement.removeAttribute('data-app-occluded')
  } catch {
    /* ignore */
  }
}
syncAppOccluded()
document.addEventListener('visibilitychange', syncAppOccluded)

// === 2. SkillHub 兜底（仅 Tauri） ===
if (isTauri) {
  const killSkillhubEmbed = () =>
    import('../lib/browser-embed-client.js')
      .then((m) => m.browserEmbedClose('skillhub-store'))
      .catch(() => {})
  void killSkillhubEmbed()
  window.addEventListener('hashchange', () => { void killSkillhubEmbed() })
}

// === 3. dynamic import 失败兜底 ===
const DYNAMIC_IMPORT_RECOVERY_KEY = 'evopanel_dynamic_import_recovered'
window.addEventListener('unhandledrejection', (ev) => {
  const msg = String((ev && ev.reason && (ev.reason.message || ev.reason)) || '')
  if (!/Failed to fetch dynamically imported module/i.test(msg)) return
  const recovered = sessionStorage.getItem(DYNAMIC_IMPORT_RECOVERY_KEY) === '1'
  if (recovered) return
  try {
    sessionStorage.setItem(DYNAMIC_IMPORT_RECOVERY_KEY, '1')
  } catch {}

  console.warn('[boot] dynamic import failed, reloading once:', msg)
  window.location.reload()
})
window.setTimeout(() => {
  try { sessionStorage.removeItem(DYNAMIC_IMPORT_RECOVERY_KEY) } catch {}
}, 15000)

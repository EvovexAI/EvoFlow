// 统一浏览器调试日志（前端上报）。
//
// 排「两个浏览器窗口 / 面板不贴合 / 导航不显示」需要把前端时间线和
// Rust（logs/plugin-control.log 里的 [rust] 行）、Python（[py] 行）对齐。
//
// 写入策略（桌面优先本地，避免 Gateway 端口错了整段 FE 时间线静默丢失）：
// 1. Tauri `append_plugin_control_log` → 直接追加同一文件
// 2. 非桌面 / Tauri 失败时再 POST `/api/browser/log`（网关侧也会装 mirror）

import { apiUrlAsync } from './api-client.js'

type UnifiedEntry = { ts: string; level: string; msg: string }

const queue: UnifiedEntry[] = []
let timer: ReturnType<typeof setTimeout> | null = null

export type BrowserLogLevel = 'info' | 'warn' | 'error'

function isDesktopTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  )
}

async function writeViaTauri(entries: UnifiedEntry[]): Promise<boolean> {
  if (!isDesktopTauri() || !entries.length) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await Promise.all(
      entries.map((e) =>
        invoke('append_plugin_control_log', {
          source: 'web',
          level: e.level,
          message: e.msg,
        }),
      ),
    )
    return true
  } catch {
    return false
  }
}

async function writeViaHttp(entries: UnifiedEntry[]): Promise<void> {
  if (!entries.length) return
  try {
    const url = await apiUrlAsync('browser/log')
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ source: 'web', entries }),
      keepalive: true,
    })
  } catch {
    // 丢弃这批，不重试——统一日志只是排查辅助。
  }
}

export function blog(level: BrowserLogLevel, msg: string): void {
  try {
    queue.push({ ts: new Date().toISOString(), level, msg: String(msg).slice(0, 2000) })
    if (queue.length >= 20) {
      void flushBrowserUnifiedLog()
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null
        void flushBrowserUnifiedLog()
      }, 500)
    }
  } catch {
    /* ignore — logging must never throw */
  }
}

/**
 * 浏览器打开全流程时间线（在 plugin-control.log 搜 `[浏览器时间线]`）。
 *
 * 阶段：
 * 1. 工具准备开页 — FE 从工具参数认出要开浏览器
 * 2. 后台导航 — Rust CDP Page.navigate 发出 / 成功
 * 3. 侧栏打开 — 右栏浏览器标签展开
 * 4. 窗口贴位 — 嵌入窗贴进槽位（或失败原因）
 * 5. 页面内容就绪 — 目标 URL 的 document 已可读（或失败原因）
 */
export type BrowserTimelinePhase =
  | '工具准备开页'
  | '后台导航'
  | '侧栏打开'
  | '窗口贴位'
  | '页面内容就绪'
  | '失败'

export function blogTimeline(
  phase: BrowserTimelinePhase,
  detail: string,
  level: BrowserLogLevel = phase === '失败' ? 'warn' : 'info',
): void {
  blog(level, `[浏览器时间线] ${phase}｜${String(detail || '').slice(0, 1800)}`)
}

export async function flushBrowserUnifiedLog(): Promise<void> {
  if (!queue.length) return
  const entries = queue.splice(0, queue.length)
  // Desktop: local file first (same path Rust uses). HTTP only as fallback so
  // we do not double-write when both succeed.
  if (await writeViaTauri(entries)) return
  await writeViaHttp(entries)
}

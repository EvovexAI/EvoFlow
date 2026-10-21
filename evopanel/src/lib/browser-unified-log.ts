// 统一浏览器调试日志（前端上报）。
//
// 排「两个浏览器窗口 / 面板不贴合 / 导航不显示」需要把前端时间线和
// Rust（logs/plugin-control.log 里的 [rust] 行）、Python（[py] 行）对齐。
// 这里把日志批量 POST 到 /api/browser/log，由网关追加进同一个文件。
// 上报是 fire-and-forget：失败静默丢弃，绝不阻塞面板逻辑。

import { apiUrlAsync } from './api-client.js'

type UnifiedEntry = { ts: string; level: string; msg: string }

const queue: UnifiedEntry[] = []
let timer: ReturnType<typeof setTimeout> | null = null

export type BrowserLogLevel = 'info' | 'warn' | 'error'

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

export async function flushBrowserUnifiedLog(): Promise<void> {
  if (!queue.length) return
  const entries = queue.splice(0, queue.length)
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

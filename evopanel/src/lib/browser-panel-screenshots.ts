import { parseBrowserLiveToolOutput, parseBrowserScreenshotToolOutput } from './chat-normalize.js'
import type { DisplayRow } from '../react/chat-types.js'

export type BrowserScreenshotEntry = {
  id: string
  src: string
  pageUrl?: string
  summary?: string
  toolName?: string
  timestamp?: number
}

export type BrowserPanelState = {
  pageUrl?: string
  snapshotText?: string
  liveStreamUrl?: string
  browserMode?: 'headed' | 'cdp' | 'headless' | 'embed'
  sharedBrowser?: boolean
  screenshots: BrowserScreenshotEntry[]
  activityCount: number
}

const BROWSER_TOOL_NAMES = new Set([
  'browser',
  'browser_snapshot',
  'preview_url',
  'browser_get_images',
])

function readToolName(tool: unknown): string {
  if (!tool || typeof tool !== 'object') return ''
  const o = tool as Record<string, unknown>
  return String(o.name || o.tool_name || o.toolName || '')
    .trim()
    .toLowerCase()
}

function readToolOutput(tool: unknown): unknown {
  if (!tool || typeof tool !== 'object') return null
  const o = tool as Record<string, unknown>
  return o.output ?? o.output_text ?? o.result ?? o.content ?? null
}

function readBrowserMeta(tool: unknown): {
  screenshot?: { src: string; pageUrl?: string; summary?: string }
  pageUrl?: string
  snapshotText?: string
  liveStreamUrl?: string
  browserMode?: 'headed' | 'cdp' | 'headless' | 'embed'
  sharedBrowser?: boolean
} {
  if (!tool || typeof tool !== 'object') return {}
  const o = tool as Record<string, unknown>
  const preserved = o.browser_screenshot as { src?: string; pageUrl?: string; summary?: string } | undefined
  const preservedLive = o.browser_live as {
    streamWs?: string
    pageUrl?: string
    mode?: string
    headed?: boolean
  } | undefined
  const out: {
    screenshot?: { src: string; pageUrl?: string; summary?: string }
    pageUrl?: string
    snapshotText?: string
    liveStreamUrl?: string
    browserMode?: 'headed' | 'cdp' | 'headless' | 'embed'
    sharedBrowser?: boolean
  } = {}
  if (preservedLive?.streamWs) {
    out.liveStreamUrl = preservedLive.streamWs
    if (preservedLive.pageUrl) out.pageUrl = preservedLive.pageUrl
    if (preservedLive.mode === 'headed' || preservedLive.mode === 'cdp' || preservedLive.mode === 'headless' || preservedLive.mode === 'embed') {
      out.browserMode = preservedLive.mode
    }
    if (preservedLive.headed || preservedLive.mode === 'headed' || preservedLive.mode === 'cdp' || preservedLive.mode === 'embed') {
      out.sharedBrowser = true
    }
  }
  if (preserved?.src) {
    out.screenshot = {
      src: preserved.src,
      pageUrl: typeof preserved.pageUrl === 'string' ? preserved.pageUrl : undefined,
      summary: typeof preserved.summary === 'string' ? preserved.summary : undefined,
    }
  }
  if (typeof o.browser_page_url === 'string' && o.browser_page_url.trim()) {
    out.pageUrl = o.browser_page_url.trim()
  }
  if (typeof o.browser_snapshot_text === 'string' && o.browser_snapshot_text.trim()) {
    out.snapshotText = o.browser_snapshot_text.trim()
  }
  return out
}

function pushScreenshot(
  out: BrowserScreenshotEntry[],
  seen: Set<string>,
  shot: { src: string; pageUrl?: string; summary?: string },
  opts: { toolName?: string; timestamp?: number },
) {
  const id = shot.src
  if (!id || seen.has(id)) return
  seen.add(id)
  out.push({
    id,
    src: shot.src,
    pageUrl: shot.pageUrl,
    summary: shot.summary,
    toolName: opts.toolName,
    timestamp: opts.timestamp,
  })
}

/** Collect browser screenshot entries from chat rows (newest last). */
export function collectBrowserScreenshotsFromRows(rows: DisplayRow[]): BrowserScreenshotEntry[] {
  return collectBrowserPanelState(rows).screenshots
}

/** Collect browser side-panel state from chat rows. */
export function collectBrowserPanelState(rows: DisplayRow[]): BrowserPanelState {
  const screenshots: BrowserScreenshotEntry[] = []
  const seen = new Set<string>()
  let pageUrl = ''
  let snapshotText = ''
  let liveStreamUrl = ''
  let browserMode: BrowserPanelState['browserMode']
  let sharedBrowser = false
  let activityCount = 0

  for (const row of Array.isArray(rows) ? rows : []) {
    const ts = typeof row.timestamp === 'number' ? row.timestamp : undefined
    const tools = Array.isArray(row.tools) ? row.tools : []
    for (const tool of tools) {
      const name = readToolName(tool)
      if (!BROWSER_TOOL_NAMES.has(name) && !name.startsWith('browser_')) continue
      activityCount += 1

      const meta = readBrowserMeta(tool)
      if (meta.pageUrl) pageUrl = meta.pageUrl
      if (meta.snapshotText) snapshotText = meta.snapshotText
      if (meta.liveStreamUrl) liveStreamUrl = meta.liveStreamUrl
      if (meta.browserMode) browserMode = meta.browserMode
      if (meta.sharedBrowser) sharedBrowser = true

      const output = readToolOutput(tool)
      const live = parseBrowserLiveToolOutput(output)
      if (live?.streamWs) {
        liveStreamUrl = live.streamWs
        if (live.pageUrl) pageUrl = live.pageUrl
        if (live.mode === 'headed' || live.mode === 'cdp' || live.mode === 'headless' || live.mode === 'embed') {
          browserMode = live.mode
        }
        if (live.headed || live.mode === 'headed' || live.mode === 'cdp' || live.mode === 'embed') {
          sharedBrowser = true
        }
      }

      if (meta.screenshot?.src) {
        pushScreenshot(screenshots, seen, meta.screenshot, { toolName: name || undefined, timestamp: ts })
        continue
      }

      const shot = parseBrowserScreenshotToolOutput(output)
      if (!shot?.src) continue
      if (name && !BROWSER_TOOL_NAMES.has(name)) {
        try {
          const raw = typeof output === 'string' ? output : JSON.stringify(output)
          if (!raw.includes('"browser_screenshot"')) continue
        } catch {
          continue
        }
      }
      pushScreenshot(screenshots, seen, shot, { toolName: name || undefined, timestamp: ts })
      if (shot.pageUrl) pageUrl = shot.pageUrl
    }
  }

  return {
    pageUrl: pageUrl || undefined,
    snapshotText: snapshotText || undefined,
    liveStreamUrl: liveStreamUrl || undefined,
    browserMode,
    sharedBrowser: sharedBrowser || undefined,
    screenshots,
    activityCount,
  }
}

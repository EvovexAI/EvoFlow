import { registerRightStageKind } from '../../lib/right-stage/right-stage-registry.js'
import { rightStageStore } from '../../lib/right-stage/right-stage-store.js'
import { NewsDashboardKind } from './kinds/NewsDashboardKind.js'
import { PlatformFeedbackKind } from './kinds/PlatformFeedbackKind.js'
import { ScreenshotStage } from './kinds/ScreenshotStage.js'
import { WebEmbedKind } from './kinds/WebEmbedKind.js'
import { XiaomiRightStagePane } from './kinds/XiaomiRightStagePane.js'
import { ShellPageKind } from './kinds/ShellPageKind.js'
import { BrowserPanel } from '../components/BrowserPanel.js'
import { closeBrowserStage } from '../../lib/browser-panel-store.js'

let registered = false

export function ensureRightStageKindsRegistered() {
  if (registered) return
  registered = true

  registerRightStageKind({
    kind: 'xiaomi',
    render: () => <XiaomiRightStagePane />,
  })

  registerRightStageKind({
    kind: 'platform-feedback',
    render: ({ surface, onClose }) => (
      <aside
        className="react-chat-right-stage-panel react-chat-platform-feedback-panel"
        role="region"
        aria-label={surface.title || '平台操作'}
      >
        <PlatformFeedbackKind surface={surface} onClose={onClose} />
      </aside>
    ),
  })

  registerRightStageKind({
    kind: 'news-dashboard',
    render: ({ onClose }) => (
      <aside
        className="react-chat-right-stage-panel react-chat-news-dashboard-panel"
        role="region"
        aria-label="热榜"
      >
        <NewsDashboardKind onClose={onClose} />
      </aside>
    ),
  })

  registerRightStageKind({
    kind: 'browser',
    render: ({ surface, onClose, active }) => {
      const tabUrl = String(surface.data?.pageUrl || '').trim()
      return (
        <BrowserPanel
          isOpen
          stageId={surface.id}
          surfaceActive={active !== false}
          // 每标签各自的 URL；不能读全局 runtime，否则后台标签地址栏会跟前台串页。
          pageUrl={tabUrl || undefined}
          onClose={() => {
            closeBrowserStage(surface.id)
            onClose()
          }}
        />
      )
    },
  })

  registerRightStageKind({
    kind: 'screenshot',
    render: (props) => <ScreenshotStage {...props} />,
  })

  registerRightStageKind({
    kind: 'shell-page',
    render: ({ surface, onClose }) => <ShellPageKind surface={surface} onClose={onClose} />,
  })

  registerRightStageKind({
    kind: 'web-embed',
    render: ({ surface, onClose, active }) => {
      const data = surface.data || {}
      const url = String(data.url || data.href || data.link || '').trim()
      const extensionId = String(data.extensionId || data.extension_id || '').trim()
      // 老 web-embed 浏览器已退役：非扩展（无 extensionId）一律路由到新 BrowserPanel。
      // web-embed kind 仅保留给已安装的 UI Agent应用（extensionId 存在）。
      // 不要在外面再套一层 ``react-chat-right-stage-panel`` aside —— BrowserPanel
      // 自带 ``react-chat-browser-panel`` 壳，重复壳会叠出双背景 + 双边框 + 50% 宽度。
      if (!extensionId) {
        const tabUrl = String(data.pageUrl || data.url || data.href || '').trim()
        return (
          <BrowserPanel
            isOpen
            stageId={surface.id || 'primary'}
            surfaceActive={active !== false}
            pageUrl={tabUrl || undefined}
            onClose={() => {
              closeBrowserStage(surface.id || 'primary')
              onClose()
            }}
          />
        )
      }
      // Default editable so AI-opened panels keep a working address bar (iframe often blocked).
      // Extension embeds stay read-only unless explicitly opted in.
      const editable = extensionId ? data.editable === true : data.editable !== false
      const sandboxRaw = data.sandbox
      const sandbox = Array.isArray(sandboxRaw)
        ? sandboxRaw.map((s) => String(s || '').trim()).filter(Boolean)
        : typeof sandboxRaw === 'string'
          ? sandboxRaw
          : undefined
      const manifest =
        data.extensionManifest && typeof data.extensionManifest === 'object'
          ? (data.extensionManifest as Record<string, unknown>)
          : data.manifest && typeof data.manifest === 'object'
            ? (data.manifest as Record<string, unknown>)
            : null
      const titleLabel = String(data.titleLabel || surface.title || '').trim()
      return (
        <aside
          className="react-chat-right-stage-panel react-chat-web-embed-panel"
          role="region"
          aria-label={surface.title || displayUrlFromEmbed(url) || '浏览器'}
        >
          <WebEmbedKind
            url={url}
            editable={editable}
            extensionId={extensionId}
            extensionManifest={manifest}
            sandbox={sandbox}
            titleLabel={extensionId ? titleLabel : ''}
            onUrlChange={(next) => rightStageStore.updateData({ url: next })}
            onClose={onClose}
          />
        </aside>
      )
    },
  })
}

function displayUrlFromEmbed(raw: string): string {
  const url = String(raw || '').trim()
  if (!url) return ''
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.origin : undefined)
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
    return `${u.hostname}${path}${u.search || ''}`
  } catch {
    return url
  }
}

export { registerRightStageKind } from '../../lib/right-stage/right-stage-registry.js'

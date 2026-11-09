/**
 * 右栏「Agent 应用」选择器：列出已安装的 UI Agent 应用（/extensions 装的那批）。
 *
 * 与「工作流」选择器同构：先列应用，点一个即在右侧开一个 web-embed 标签。
 * 只列可打开的（enabled + 有 ui.entry），套件（suite）不出现。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  listEnabledUiExtensions,
  onUiExtensionsChanged,
  resolveUiExtensionIconSrc,
} from '../../lib/ui-extensions.js'
import { cn } from '@zcode/ui/components/lib/utils.js'

export type RightStageAgentAppOption = {
  id: string
  title: string
  description: string
  version: string
  /** 已解析好的图标：img 用 src，glyph 用文字。 */
  iconKind: 'img' | 'glyph' | 'none'
  iconSrc: string
  iconText: string
}

type RawRow = {
  id: string
  title: string
  description: string
  version: string
  iconKind: 'img' | 'glyph' | 'none'
  iconSrc: string
  iconText: string
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function rowFromExtension(raw: unknown): RawRow | null {
  const row = asRecord(raw)
  const id = String(row.id || row.app_id || '').trim()
  if (!id) return null
  const manifest = asRecord(row.manifest)
  const nav = asRecord(manifest.nav)
  const ui = asRecord(manifest.ui)
  const title = String(nav.title || manifest.name || id).trim() || id
  const description = String(manifest.description || '').trim()
  const version = String(manifest.version || '').trim()
  const resolved = resolveUiExtensionIconSrc(
    manifest.icon,
    String(row.install_path || ''),
    String(row.icon_src || ''),
  )
  return {
    id,
    title,
    description,
    version,
    iconKind: resolved.kind === 'none' ? 'none' : resolved.kind,
    iconSrc: resolved.kind === 'img' ? resolved.src : '',
    iconText: resolved.kind === 'glyph' ? resolved.text : '',
  }
}

/** 稳定图标色调（0..5）：让图标底色各有个性，避免一排灰块。 */
function iconToneClass(id: string): string {
  const tones = [
    'react-chat-stage-app-icon--violet',
    'react-chat-stage-app-icon--sky',
    'react-chat-stage-app-icon--amber',
    'react-chat-stage-app-icon--emerald',
    'react-chat-stage-app-icon--rose',
    'react-chat-stage-app-icon--cyan',
  ]
  let hash = 0
  const s = String(id || '')
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i)
    hash |= 0
  }
  return tones[Math.abs(hash) % tones.length]
}

function AgentAppIcon({ app }: { app: RightStageAgentAppOption }) {
  if (app.iconKind === 'img') {
    return (
      <span className={cn('react-chat-stage-app-icon', iconToneClass(app.id))} aria-hidden>
        <img src={app.iconSrc} alt="" />
      </span>
    )
  }
  const text = app.iconKind === 'glyph' ? app.iconText : '📦'
  return (
    <span className={cn('react-chat-stage-app-icon', iconToneClass(app.id))} aria-hidden>
      {text}
    </span>
  )
}

export function RightStageAgentAppPickList({
  onPick,
}: {
  /** 选中应用 → 在右侧开标签。 */
  onPick: (appId: string) => void
}) {
  const [apps, setApps] = useState<RightStageAgentAppOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const rows = await listEnabledUiExtensions()
        if (cancelled) return
        const list = (Array.isArray(rows) ? rows : [])
          .map(rowFromExtension)
          .filter(Boolean) as RawRow[]
        list.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
        setApps(list)
        setError('')
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e || '加载失败'))
        setApps([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    setLoading(true)
    void load()
    // 装/卸应用后列表要跟着变；否则新装的 App 要重开面板才看得到。
    const off = onUiExtensionsChanged(() => {
      void load()
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return apps
    return apps.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q),
    )
  }, [apps, query])

  if (loading) {
    return <div className="px-1 py-4 text-center text-ui-sm text-foreground-subtlest">加载 Agent 应用…</div>
  }
  if (error) {
    return (
      <div className="px-1 py-4 text-center text-ui-sm text-foreground-subtlest">
        加载失败：{error}
      </div>
    )
  }
  if (!apps.length) {
    return (
      <div className="px-1 py-4 text-center text-ui-sm text-foreground-subtlest">
        暂无 Agent 应用。先到「Agent 应用」页安装一个。
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 px-1 pb-1">
      <input
        type="search"
        className="react-chat-stage-app-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索应用名称、描述、ID…"
        aria-label="搜索 Agent 应用"
      />
      <div className="react-chat-stage-open-tab-list" role="listbox" aria-label="选择 Agent 应用">
        {visible.length ? (
          visible.map((app) => (
            <button
              key={app.id}
              type="button"
              role="option"
              data-side-pane-agent-app-pick={app.id}
              className="react-chat-stage-open-tab-button"
              onClick={() => onPick(app.id)}
            >
              <AgentAppIcon app={app} />
              <span className="min-w-0 flex-1 truncate text-left">
                <span className="block truncate">{app.title}</span>
                {app.description ? (
                  <span className="block truncate text-[11px] text-foreground-subtlest">
                    {app.description}
                  </span>
                ) : null}
              </span>
            </button>
          ))
        ) : (
          <div className="px-3 py-6 text-center text-ui-sm text-foreground-subtlest">
            没有匹配的 Agent 应用
          </div>
        )}
      </div>
    </div>
  )
}

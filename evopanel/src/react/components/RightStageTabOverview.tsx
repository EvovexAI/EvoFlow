import { useMemo, useState } from 'react'
import { defaultTitleForKind, normalizeRightStageKind, type RightStageSurface } from '../../lib/right-stage/right-stage-types.js'
import type { RecentClosedRightStageTab } from '../../lib/right-stage/right-stage-store.js'
import { KindTabIcon } from './RightStageTabIcon.js'

function formatRelativeTime(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

type TabEntry = {
  key: string
  title: string
  kind: string
  searchText: string
}

/** 大小写不敏感子串匹配；kind 的本地化标题也参与匹配，便于「浏览器」直接搜到。 */
function matches(entry: TabEntry, query: string): boolean {
  if (!query) return true
  return entry.searchText.includes(query)
}

/**
 * ZCode 式标签总览：搜索全部打开的标签 + 最近关闭的标签。
 *
 * 与 zcode 的 Command 组件职责一致，但 EvoFlow 未引入 cmdk，这里用原生
 * input + 过滤实现，保留 Radix Popover 提供的 focus trap 与 Esc 关闭。
 */
export function RightStageTabOverview({
  tabs,
  activeKey,
  recentClosed,
  onActivateTab,
  onCloseTab,
  onReopenClosedTab,
}: {
  tabs: RightStageSurface[]
  activeKey: string | null
  recentClosed: RecentClosedRightStageTab[]
  onActivateTab: (key: string) => void
  onCloseTab: (key: string) => void
  onReopenClosedTab: (key: string) => void
}) {
  const [query, setQuery] = useState('')
  const [now] = useState(() => Date.now())

  const normalized = query.trim().toLowerCase()

  const openEntries = useMemo<TabEntry[]>(
    () =>
      tabs.map((t) => {
        const kind = normalizeRightStageKind(t.kind)
        const kindLabel = defaultTitleForKind(kind)
        const title = t.title?.trim() || kindLabel
        return {
          key: `${kind}:${t.id}`,
          title,
          kind,
          searchText: `${title} ${kindLabel} ${t.id}`.toLowerCase(),
        }
      }),
    [tabs],
  )

  const closedEntries = useMemo<TabEntry[]>(
    () =>
      recentClosed.map((entry) => {
        const kind = normalizeRightStageKind(entry.tab.kind)
        const kindLabel = defaultTitleForKind(kind)
        const title = entry.tab.title?.trim() || kindLabel
        return {
          key: entry.key,
          title,
          kind,
          searchText: `${title} ${kindLabel} ${entry.tab.id}`.toLowerCase(),
        }
      }),
    [recentClosed],
  )

  const filteredOpen = useMemo(
    () => openEntries.filter((e) => matches(e, normalized)),
    [openEntries, normalized],
  )
  const filteredClosed = useMemo(
    () => closedEntries.filter((e) => matches(e, normalized)),
    [closedEntries, normalized],
  )
  const hasResults = filteredOpen.length > 0 || filteredClosed.length > 0

  const groupStyle: React.CSSProperties = { borderColor: 'var(--border)' }

  return (
    <div className="flex flex-col gap-2" data-testid="right-stage-tab-overview">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索标签页"
        aria-label="搜索标签页"
        className="h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
      />

      {!hasResults ? (
        <p className="px-1 py-4 text-center text-sm text-[var(--text-secondary)]">未找到匹配的标签</p>
      ) : null}

      {filteredOpen.length > 0 ? (
        <section className="flex flex-col gap-0.5">
          <h3 className="px-1 pb-1 text-xs font-medium text-[var(--text-secondary)]">打开的标签</h3>
          {filteredOpen.map((entry) => (
            <div
              key={entry.key}
              role="button"
              tabIndex={0}
              aria-current={entry.key === activeKey || undefined}
              className={`flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm ${
                entry.key === activeKey ? 'bg-[var(--bg-selected)]' : 'hover:bg-[var(--bg-hover)]'
              }`}
              onClick={() => onActivateTab(entry.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onActivateTab(entry.key)
                }
              }}
            >
              <KindTabIcon kind={entry.kind} />
              <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{entry.title}</span>
              <button
                type="button"
                aria-label={`关闭 ${entry.title}`}
                className="shrink-0 rounded-md p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                onPointerDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onCloseTab(entry.key)
                }}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
          ))}
        </section>
      ) : null}

      {filteredClosed.length > 0 ? (
        <section className="flex flex-col gap-0.5 border-t pt-2" style={groupStyle}>
          <h3 className="px-1 pb-1 text-xs font-medium text-[var(--text-secondary)]">最近关闭</h3>
          {filteredClosed.map((entry) => {
            const closedAt = recentClosed.find((e) => e.key === entry.key)?.closedAt ?? now
            return (
              <div
                key={entry.key}
                role="button"
                tabIndex={0}
                className="flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm hover:bg-[var(--bg-hover)]"
                onClick={() => onReopenClosedTab(entry.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onReopenClosedTab(entry.key)
                  }
                }}
              >
                <KindTabIcon kind={entry.kind} />
                <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{entry.title}</span>
                <span className="shrink-0 text-xs text-[var(--text-secondary)]">
                  {formatRelativeTime(closedAt, now)}
                </span>
              </div>
            )
          })}
        </section>
      ) : null}
    </div>
  )
}

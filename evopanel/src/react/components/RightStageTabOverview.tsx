import { useMemo, useState } from 'react'
import { defaultTitleForKind, describeOpenedBy, normalizeRightStageKind, parseOpenedBy, type RightStageSurface } from '../../lib/right-stage/right-stage-types.js'
// 【self-evolution-bot · 2026-11-23 · 第128轮续 · 模型:deepseek-v4.1-flash】
// 悬停展开的归属文本要按三态拼 className，与本仓其它面板同一入口（不自己拼字符串）。
import { cn } from '@zcode/ui/components/lib/utils.js'
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
  /** 「谁打开的」原始取值（`user` / `agent:*` / `session:*`）；空串表示未知。 */
  openedBy: string
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
  agentLabelMap,
  onActivateTab,
  onCloseTab,
  onReopenClosedTab,
}: {
  tabs: RightStageSurface[]
  activeKey: string | null
  recentClosed: RecentClosedRightStageTab[]
  /**
   * 【self-evolution-bot · 2026-11-23 · 第128轮 · 模型:deepseek-v4.1-flash】
   * 改了什么：总览列表每行加「谁打开的」归属文本。
   * 为什么（用户原话）：「我在 A 打开了一个截图，但在其他地方看到这个截图，
   *   却不知道是谁打开的。」总览就是那个「其他地方」——这里不给溯源，等于没解决。
   * 判据：openedBy 为空的行不占位（不显示空角标）。
   */
  agentLabelMap?: Record<string, string> | null
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
          openedBy: String(t.openedBy || ''),
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
          openedBy: String(entry.tab.openedBy || ''),
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
          {filteredOpen.map((entry) => {
            const byText = describeOpenedBy(entry.openedBy, agentLabelMap)
            return (
            <div
              key={entry.key}
              role="button"
              tabIndex={0}
              aria-current={entry.key === activeKey || undefined}
              // 【self-evolution-bot · 2026-11-23 · 第128轮续 · 模型:deepseek-v4.1-flash】
              // 悬停这一行才显出「谁打开的」：整行 title 承载全量文案（鼠标移上去即见），
              // 行内常显只留极短三态字、且悬停才显形（用户：不需要很明显地显示，不然很占空间）。
              title={byText ? `${entry.title} — ${byText}打开的` : entry.title}
              className={`group flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm ${
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
              {/* 【self-evolution-bot · 2026-11-23 · 第128轮续 · 模型:deepseek-v4.1-flash】
                  改了什么：归属文本从「常显」改成「悬停该行才显示」，且只显示极短三态字。
                  为什么（用户原话）：「这个鼠标移动上去再显示就行了，不需要很明显地显示，
                    不然的话很占空间」——列表行本来就紧，一枝「智能体：某某某」会白占 9rem。
                  判据：
                    ① 常显态占位 0：`w-0 opacity-0` + `group-hover:w-auto opacity-100`，
                       悬停时**才撑开**（不是一开始就留着空位）；
                    ② 悬停给全量文案（整行 title），行内只给三态首字（我 / AI / 会话），
                       不给「智能体：某某某」这种长串；
                    ③ `data-opened-by-text` 保留原始值、`aria-hidden` 不让读屏念两遍。
                  为什么不做浮层：签根节点与内容容器都带 `overflow-hidden` + 右端
                    `mask-image` 渐隐，浮层会被裁掉或淡到看不清。 */}
              {(() => {
                const byText = describeOpenedBy(entry.openedBy, agentLabelMap)
                if (!byText) return null
                const kind = parseOpenedBy(entry.openedBy)?.kind
                const short = kind === 'user' ? '我' : kind === 'agent' ? 'AI' : '会话'
                return (
                  <span
                    aria-hidden
                    data-opened-by-text={entry.openedBy}
                    title={byText}
                    className={cn(
                      'ml-auto w-0 shrink-0 overflow-hidden whitespace-nowrap text-[10px]',
                      'opacity-0 transition-all duration-100 group-hover:w-auto group-hover:px-1 group-hover:opacity-100',
                      kind === 'user' && 'text-[#8ec5ff]',
                      kind === 'agent' && 'text-[#ffcf8a]',
                      kind === 'session' && 'text-[#b9b9c4]',
                    )}
                  >
                    {short}
                  </span>
                )
              })()}
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
            )
          })}
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
                {/* 最近关闭的行也带归属：重开前就该知道当初是谁开的。 */}
                {describeOpenedBy(entry.openedBy, agentLabelMap) ? (
                  <span
                    className="shrink-0 max-w-[7rem] truncate text-xs text-[var(--text-secondary)]"
                    title={describeOpenedBy(entry.openedBy, agentLabelMap)}
                  >
                    {describeOpenedBy(entry.openedBy, agentLabelMap)}
                  </span>
                ) : null}
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

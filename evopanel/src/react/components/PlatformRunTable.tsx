import { memo, useMemo } from 'react'
import {
  navigatePlatformFeedbackRoute,
  platformDomainLabel,
  type PlatformRunEntry,
} from '../../lib/right-stage/platform-feedback.js'
import {
  formatInfoRailTime,
  type InfoRailScope,
} from '../lib/info-rail-format.js'

function scopeForEntry(
  entry: PlatformRunEntry,
  recentIds: Set<string>,
  latestId: string,
): InfoRailScope {
  if (latestId && entry.id === latestId) return 'latest'
  if (recentIds.has(entry.id)) return 'turn'
  return 'existing'
}

function partitionPlatformEntries(
  entries: PlatformRunEntry[],
  recentEntries: PlatformRunEntry[],
  focusEntryId: string,
) {
  const recentIds = new Set(recentEntries.map((e) => e.id))
  let latestId = String(focusEntryId || '').trim()
  if (!latestId && entries.length) {
    latestId = entries.reduce((best, row) => (row.appliedAt >= best.appliedAt ? row : best)).id
  }
  // 最新通知单独置顶展示后，就不再重复出现在「当前轮次 / 已有通知」分区
  const existing = entries.filter((e) => e.id !== latestId && !recentIds.has(e.id))
  const latestItem = latestId ? entries.find((e) => e.id === latestId) || null : null
  const turnItems = recentEntries.filter((e) => e.id !== latestId)
  return { recentIds, existing, turnItems, latestItem, latestId }
}

function PlatformRunCard({
  entry,
  scope,
  active,
}: {
  entry: PlatformRunEntry
  scope: InfoRailScope
  active: boolean
}) {
  const primaryAction = entry.actions?.find((a) => a.route)
  const status = entry.kind === 'warning' ? 'warning' : entry.kind === 'error' ? 'error' : 'success'
  const domain = platformDomainLabel(entry.domain)
  const timeStr = formatInfoRailTime(entry.appliedAt)

  const openEntry = () => {
    const route = primaryAction?.route
    if (route) navigatePlatformFeedbackRoute(route)
  }

  return (
    <li
      className={`react-chat-platform-run-card react-chat-platform-run-card--${status}${
        active ? ' is-active' : ''
      }`}
    >
      <div className="react-chat-platform-run-card-head">
        <span className="react-chat-platform-run-domain" title={domain}>
          {domain}
        </span>
        <div className="react-chat-platform-run-card-head-right">
          {timeStr ? (
            <span className="react-chat-platform-run-time" title={timeStr}>
              {timeStr}
            </span>
          ) : null}
          {primaryAction?.route ? (
            <button type="button" className="react-chat-platform-run-action" onClick={openEntry}>
              {primaryAction.label || '查看'}
            </button>
          ) : null}
        </div>
      </div>
      <div className="react-chat-platform-run-title" title={entry.title}>
        {entry.title}
      </div>
      {entry.subtitle ? (
        <div className="react-chat-platform-run-subtitle" title={entry.subtitle}>
          {entry.subtitle}
        </div>
      ) : null}
    </li>
  )
}

function PlatformRunSection({
  label,
  entries,
  recentIds,
  latestId,
  focusEntryId,
}: {
  label: string
  entries: PlatformRunEntry[]
  recentIds: Set<string>
  latestId: string
  focusEntryId: string
}) {
  if (!entries.length) return null
  return (
    <>
      <div className="react-chat-info-rail-subsection-label">{label}</div>
      <ul className="react-chat-platform-run-list">
        {entries.map((entry) => (
          <PlatformRunCard
            key={entry.id}
            entry={entry}
            scope={scopeForEntry(entry, recentIds, latestId)}
            active={!!focusEntryId && focusEntryId === entry.id}
          />
        ))}
      </ul>
    </>
  )
}

export const PlatformRunTable = memo(function PlatformRunTable({
  entries,
  recentEntries = [],
  focusEntryId = '',
  emptyText = '本次对话暂无平台操作。',
}: {
  entries: PlatformRunEntry[]
  recentEntries?: PlatformRunEntry[]
  focusEntryId?: string
  emptyText?: string
}) {
  const partitioned = useMemo(
    () => partitionPlatformEntries(entries, recentEntries, focusEntryId),
    [entries, recentEntries, focusEntryId],
  )

  if (!entries.length) {
    return <div className="react-chat-info-rail-empty">{emptyText}</div>
  }

  const { recentIds, existing, turnItems, latestItem, latestId } = partitioned
  const hasSections = !!(latestItem || turnItems.length || existing.length)

  if (!hasSections) {
    return (
      <ul className="react-chat-platform-run-list">
        {entries.map((entry) => (
          <PlatformRunCard
            key={entry.id}
            entry={entry}
            scope="existing"
            active={!!focusEntryId && focusEntryId === entry.id}
          />
        ))}
      </ul>
    )
  }

  return (
    <>
      <PlatformRunSection
        label="最新通知"
        entries={latestItem ? [latestItem] : []}
        recentIds={recentIds}
        latestId={latestId}
        focusEntryId={focusEntryId}
      />
      <PlatformRunSection
        label="当前轮次"
        entries={turnItems}
        recentIds={recentIds}
        latestId={latestId}
        focusEntryId={focusEntryId}
      />
      <PlatformRunSection
        label="已有通知"
        entries={existing}
        recentIds={recentIds}
        latestId={latestId}
        focusEntryId={focusEntryId}
      />
    </>
  )
})

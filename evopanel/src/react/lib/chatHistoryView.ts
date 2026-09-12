import {
  messagesToDisplayRows,
  parseUsageToStats,
  extractLatestScenarioSceneKeyFromHistoryMessages,
  filterToolsForChatPanelDisplay,
  filterDisplaySegmentsForChatPanel,
} from '../../lib/chat-normalize.js'
import { stripResolvedAskClarificationFromRows } from '../../lib/ask-clarification-pending.js'
import type { DisplayRow, TokenTotals } from '../chat-types.js'
import { sanitizeHistoryRowsForTurnIsolation } from './turn-text-isolation.js'
import { collapseSameTurnAssistantsInRows } from './collapse-same-turn-assistants.js'
import { applyPreferredSkillDisplayToUserRow } from './preferred-skill-display.js'
import { omitWorkerParentWhenExpanded, prepareWorkerToolsForDisplayRow } from '../worker-file-tools.js'

export function buildHistoryViewFromRaw(raw: unknown[]) {
  const usageTotals = raw.reduce<TokenTotals>(
    (acc, m) => {
      const u = parseUsageToStats(m) as TokenTotals | null | undefined
      if (!u) return acc
      acc.input += u.input
      acc.output += u.output
      acc.total += u.total
      if (u.cacheRead) acc.cacheRead = (acc.cacheRead ?? 0) + u.cacheRead
      if (u.cacheCreation) acc.cacheCreation = (acc.cacheCreation ?? 0) + u.cacheCreation
      if (u.cacheMiss) acc.cacheMiss = (acc.cacheMiss ?? 0) + u.cacheMiss
      return acc
    },
    { input: 0, output: 0, total: 0 },
  )
  const tokenTotals = usageTotals.total > 0 ? usageTotals : null
  const rawRows = collapseSameTurnAssistantsInRows(
    sanitizeHistoryRowsForTurnIsolation(
      stripResolvedAskClarificationFromRows(messagesToDisplayRows(raw) as DisplayRow[]),
    ),
  )
  const rows = rawRows.map((row: DisplayRow) => {
    if (row.role === 'user') return applyPreferredSkillDisplayToUserRow(row)
    if (row.role !== 'assistant') return row
    const sourceTools = Array.isArray(row.tools) ? row.tools : []
    const workerPrepared = prepareWorkerToolsForDisplayRow(sourceTools, row.segments)
    const panelToolsSource = omitWorkerParentWhenExpanded(workerPrepared.tools)
    const tools = filterToolsForChatPanelDisplay(panelToolsSource)
    const segments = filterDisplaySegmentsForChatPanel(workerPrepared.segments, panelToolsSource)
    if (tools === row.tools && segments === row.segments) return row
    return { ...row, tools, ...(segments != null ? { segments } : {}) }
  })
  const restoredScenarioScene = extractLatestScenarioSceneKeyFromHistoryMessages(raw)
  return { rows, tokenTotals, restoredScenarioScene }
}

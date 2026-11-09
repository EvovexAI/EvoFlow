import type { BackgroundWorkStreamItem } from '../chat-types.js'

export function mergeBackgroundWorkEvent(
  map: Record<string, BackgroundWorkStreamItem>,
  ev: Record<string, unknown>,
): void {
  const workId = String(ev.workId || ev.work_id || '').trim()
  if (!workId) return
  const prev = map[workId]
  const startedAt = Number(ev.startedAt ?? ev.started_at ?? prev?.startedAt ?? Date.now())
  const status = String(ev.status || prev?.status || 'running')
  const row: BackgroundWorkStreamItem = {
    workId,
    kind: 'bash',
    title: String(ev.title || prev?.title || ev.command || workId).trim() || workId,
    status,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    cancellable: status === 'running' ? ev.cancellable !== false : false,
    toolCallId: String(ev.toolCallId || ev.tool_call_id || prev?.toolCallId || workId).trim(),
    command: String(ev.command || prev?.command || '').trim() || undefined,
  }
  if (status !== 'running') {
    row.endedAt = Date.now()
  }
  map[workId] = row
}

/**
 * After a runningOnly poll: local rows still ``running`` but absent from the
 * server list are finished — mark completed so the process tab stops spinning.
 */
export function pruneFinishedBackgroundWorks(
  map: Record<string, BackgroundWorkStreamItem>,
  stillRunningIds: Iterable<string>,
  now = Date.now(),
): number {
  const alive = new Set(
    [...stillRunningIds].map((id) => String(id || '').trim()).filter(Boolean),
  )
  let pruned = 0
  for (const [id, row] of Object.entries(map)) {
    if (!row || String(row.status || '') !== 'running') continue
    if (alive.has(id)) continue
    map[id] = {
      ...row,
      status: 'completed',
      endedAt: row.endedAt || now,
      cancellable: false,
    }
    pruned += 1
  }
  return pruned
}

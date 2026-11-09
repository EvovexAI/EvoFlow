/**
 * Soft-creep display progress while server only stamps discrete 10% → 100%.
 * Floor = stored progress; asymptote ~92% until terminal success.
 */

const SOFT_CEILING = 92
const TAU_MS = 120_000

const RUNNING = new Set(['in_progress', 'running', 'executing', 'active'])
const DONE = new Set(['completed', 'done', 'success', 'succeeded'])
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled', 'timed_out', 'skipped', 'blocked'])

function normalizeStatus(status?: string | null): string {
  return String(status || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, Math.round(n)))
}

/** Parse ISO / epoch-ms into unix ms; null if missing. */
export function parseProgressStartMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 1e12 ? raw * 1000 : raw
  }
  const s = String(raw || '').trim()
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/**
 * Pure soft progress for one node / main task.
 * `runningForMs` = how long this entity has been executing (client or startedAt).
 */
export function softDisplayProgressPercent(input: {
  stored?: number | null
  status?: string | null
  runningForMs: number
}): number | null {
  const st = normalizeStatus(input.status)
  const storedRaw =
    typeof input.stored === 'number' && !Number.isNaN(input.stored) ? input.stored : null
  const stored = storedRaw == null ? null : clampPct(storedRaw)

  if (DONE.has(st)) return 100
  if (FAILED.has(st)) return stored
  if (!RUNNING.has(st)) return stored

  const floor = stored != null && stored > 0 ? stored : 8
  if (floor >= SOFT_CEILING) return Math.min(99, floor)

  const elapsed = Math.max(0, Number(input.runningForMs) || 0)
  const span = SOFT_CEILING - floor
  const crept = floor + span * (1 - Math.exp(-elapsed / TAU_MS))
  return Math.max(floor, Math.min(SOFT_CEILING, Math.round(crept)))
}

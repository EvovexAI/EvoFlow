/**
 * Desktop / web cold-start milestones + end-to-end boot-cycle log.
 *
 * - Console / frontend-*.log: search ``[BOOT]``
 * - Unified cycle: ``~/.evoflow/logs/boot-cycle.log`` (search ``[BOOT-CYCLE]``)
 * - Align with Gateway ``[STARTUP-TRACE]`` / ``gateway-startup.log`` and Tauri ``evopanel-startup.log``.
 */

const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
/** @type {{ tag: string, ms: number, extra?: Record<string, unknown> }[]} */
const marks = []

let _engineReadyCycleLogged = false
let _bootCycleInvoke = null

function getBootCycleInvoke() {
  if (_bootCycleInvoke) return _bootCycleInvoke
  _bootCycleInvoke = import('@tauri-apps/api/core')
    .then((m) => m.invoke)
    .catch(() => null)
  return _bootCycleInvoke
}

/**
 * Mirror a mark into ~/.evoflow/logs/boot-cycle.log (desktop only).
 * @param {string} phase
 * @param {string} tag
 * @param {Record<string, unknown>} [extra]
 * @param {number} uiElapsedMs
 */
function mirrorBootCycle(phase, tag, extra, uiElapsedMs) {
  try {
    if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return
  } catch {
    return
  }
  const detail =
    extra && Object.keys(extra).length > 0 ? JSON.stringify(extra).slice(0, 350) : undefined
  void getBootCycleInvoke().then((invoke) => {
    if (typeof invoke !== 'function') return
    return invoke('boot_cycle_mark', {
      phase,
      tag,
      detail,
      uiElapsedMs,
    }).catch(() => {})
  })
}

/**
 * @param {string} tag
 * @param {Record<string, unknown>} [extra]
 */
export function bootMark(tag, extra) {
  const ms = Math.round(
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
  )
  marks.push({ tag, ms, extra: extra || undefined })
  const line = `[BOOT] tag=${tag} total_ms=${ms}${extra ? ` ${JSON.stringify(extra)}` : ''}`
  if (extra && Object.keys(extra).length > 0) {
    console.info(line, extra)
  } else {
    console.info(line)
  }
  mirrorBootCycle('ui', tag, extra, ms)
}

/** Call when desktop engineReady flips true (composer unlock). */
export function bootMarkEngineReady(extra) {
  if (_engineReadyCycleLogged) {
    bootMark('engineReady (repeat)', extra)
    return
  }
  _engineReadyCycleLogged = true
  bootMark('engineReady', extra)
  mirrorBootCycle('ui', 'ENGINE_READY', extra, bootElapsedMs())
}

function slowestGaps(limit = 5) {
  const gaps = []
  for (let i = 1; i < marks.length; i += 1) {
    gaps.push({
      from: marks[i - 1].tag,
      to: marks[i].tag,
      delta_ms: marks[i].ms - marks[i - 1].ms,
    })
  }
  gaps.sort((a, b) => b.delta_ms - a.delta_ms)
  return gaps.slice(0, limit)
}

/** Print delta between consecutive marks (helps spot slow gaps). */
export function bootPrintSummary() {
  const total = marks.length ? marks[marks.length - 1].ms : 0
  const lines = [
    '',
    `========== EVOPANEL BOOT SUMMARY total=${total}ms marks=${marks.length} ==========`,
  ]
  for (let i = 0; i < marks.length; i += 1) {
    const m = marks[i]
    const prev = i > 0 ? marks[i - 1].ms : 0
    const delta = m.ms - prev
    const extra = m.extra ? ` ${JSON.stringify(m.extra)}` : ''
    lines.push(`  +${delta}ms → ${m.tag} (total ${m.ms}ms)${extra}`)
  }
  const slow = slowestGaps()
  if (slow.length) {
    lines.push('SLOWEST GAPS:')
    for (const g of slow) {
      lines.push(`  +${g.delta_ms}ms  ${g.from} → ${g.to}`)
    }
  }
  lines.push(
    'DIAGNOSTIC FILES:',
    '  boot-cycle.log → ~/.evoflow/logs/boot-cycle.log  ★ open→engineReady 全周期',
    '  evopanel-startup.log → ~/.evoflow/logs/evopanel-startup.log (Tauri sidecar spawn)',
    '  gateway-startup.log → ~/.evoflow/logs/gateway-startup.log',
    '  Gateway API → GET /health/startup (timeline JSON)',
    '  grep: [BOOT-CYCLE] [BOOT] [STARTUP-TRACE] [STARTUP]',
    '='.repeat(72),
    '',
  )
  console.info(lines.join('\n'))
  mirrorBootCycle('ui', 'BOOT_SUMMARY', { total_ms: total, marks: marks.length }, total)
  return marks.slice()
}

export function bootElapsedMs() {
  return Math.round(
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
  )
}

export function getBootMarks() {
  return marks.slice()
}

if (typeof window !== 'undefined') {
  window.__evopanelStartupTrace = {
    marks: getBootMarks,
    mark: bootMark,
    markEngineReady: bootMarkEngineReady,
    summary: bootPrintSummary,
    elapsedMs: bootElapsedMs,
  }
}

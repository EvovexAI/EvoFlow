/**
 * Offline perf verification report — no backend, no browser, no real LLM.
 * Agent/CI: npm run verify:perf
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EventSchemas } from '@ag-ui/core'
import { checkStreamSimBudgets, CLIENT_PERF_BUDGETS } from '../src/react/lib/client-perf.ts'
import {
  compareStreamPaths,
  simulateTextOnlyStream,
} from '../src/react/lib/client-perf-scenarios.ts'
import {
  generateReasoningThenAnswerEvents,
  generateTextDeltaEvents,
  replayStreamEvents,
} from '../src/react/lib/stream-perf-replay.ts'

const __dir = dirname(fileURLToPath(import.meta.url))
const lines = []

function report(label, detail, ok) {
  const mark = ok ? 'PASS' : 'FAIL'
  const row = `[${mark}] ${label} — ${detail}`
  lines.push(row)
  // eslint-disable-next-line no-console
  console.log(row)
  return ok
}

function loadAgUiFixture(name) {
  const raw = readFileSync(join(__dir, 'fixtures', 'agui', name), 'utf8')
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => EventSchemas.parse(JSON.parse(l)))
}

describe('verify-perf-report (offline)', () => {
  it('prints regression gates and enforces budgets', () => {
    lines.length = 0
    // eslint-disable-next-line no-console
    console.log('\n=== EvoPanel offline perf verification (no API) ===\n')

    const textOnly = simulateTextOnlyStream(500, { livePath: true })
    const textOnlyOk =
      report(
        'text-only 500 deltas',
        `displayTick=${textOnly.displayTicks} liveEpoch=${textOnly.liveEpoch} ratio=${textOnly.displayTickPerDelta.toFixed(3)}`,
        checkStreamSimBudgets(textOnly).ok,
      ) && textOnly.displayTicks === 0

    const cmp = compareStreamPaths(500)
    const compareOk = report(
      'live vs legacy A/B',
      `live=${cmp.live.displayTicks} legacy=${cmp.legacy.displayTicks} reduction=${cmp.displayTickReductionPct}%`,
      cmp.displayTickReductionPct >= 90 && cmp.liveMeetsBudget,
    )

    const thinkLive = replayStreamEvents(loadAgUiFixture('think-tool-body.jsonl'), { livePath: true })
    const thinkLegacy = replayStreamEvents(loadAgUiFixture('think-tool-body.jsonl'), { livePath: false })
    const thinkOk =
      report(
        'agui fixture think-tool-body (live)',
        `${thinkLive.textDeltaCount} text + ${thinkLive.structuralCount} structural → displayTick=${thinkLive.displayTicks}`,
        thinkLive.displayTicks <= thinkLive.structuralCount + 1 &&
          thinkLive.displayTicks < thinkLive.eventCount,
      ) &&
      report(
        'agui fixture think-tool-body (legacy)',
        `displayTick=${thinkLegacy.displayTicks} (expect > live ${thinkLive.displayTicks})`,
        thinkLegacy.displayTicks > thinkLive.displayTicks,
      )

    const heavyFixture = replayStreamEvents(loadAgUiFixture('heavy-text-stream.jsonl'), { livePath: true })
    const heavyOk = report(
      'agui fixture heavy-text-stream',
      `${heavyFixture.textDeltaCount} text deltas → displayTick=${heavyFixture.displayTicks}`,
      heavyFixture.displayTicks <= 2 && heavyFixture.textDeltaCount >= 8,
    )

    const gen2k = replayStreamEvents(generateTextDeltaEvents(2000, 12), { livePath: true })
    const gen2kOk = report(
      'synthetic 2KB markdown stream',
      `${gen2k.textDeltaCount} text deltas → displayTick=${gen2k.displayTicks} ratio=${gen2k.displayTickPerTextDelta.toFixed(3)}`,
      gen2k.displayTickPerTextDelta <= CLIENT_PERF_BUDGETS.displayTickPerDeltaLiveMax,
    )

    const deepSeek = replayStreamEvents(generateReasoningThenAnswerEvents(4000, 2000, 12), {
      livePath: true,
    })
    const deepSeekOk = report(
      'synthetic reasoning+answer stream',
      `${deepSeek.textDeltaCount} text deltas → displayTick=${deepSeek.displayTicks}`,
      deepSeek.displayTickPerTextDelta <= CLIENT_PERF_BUDGETS.displayTickPerDeltaLiveMax,
    )

    const allOk = textOnlyOk && compareOk && thinkOk && heavyOk && gen2kOk && deepSeekOk
    // eslint-disable-next-line no-console
    console.log(`\n=== Overall: ${allOk ? 'PASS' : 'FAIL'} ===\n`)

    expect(allOk).toBe(true)
  })
})

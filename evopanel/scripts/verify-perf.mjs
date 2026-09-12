#!/usr/bin/env node
/**
 * Perf verification:
 *   node scripts/verify-perf.mjs           — L1 + L2 standard
 *   node scripts/verify-perf.mjs --offline — L1 only
 *   node scripts/verify-perf.mjs --stress  — L1 + L2 + stress (2k–10k deltas, 2k tool rounds)
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const stress = args.includes('--stress')
const skipBrowser = process.env.EVOFLOW_VERIFY_BROWSER === '0' || args.includes('--offline')

const offlineTests = [
  'tests/verify-perf-report.test.js',
  'tests/client-perf.test.js',
  'tests/client-perf-scenarios.test.js',
  'tests/live-stream-path.test.js',
  'tests/live-stream-tail.test.js',
]
if (stress) offlineTests.push('tests/verify-perf-stress.test.js')

console.log(`[verify:perf] L1 offline${stress ? ' + stress' : ''} (no API)\n`)

const vitestBin = join(root, 'node_modules', 'vitest', 'vitest.mjs')
const offline = spawnSync(process.execPath, [vitestBin, 'run', ...offlineTests, '--reporter=verbose'], {
  cwd: root,
  stdio: 'inherit',
})

if ((offline.status ?? 1) !== 0) {
  process.exit(offline.status ?? 1)
}

if (skipBrowser) {
  console.log('\n[verify:perf] L2 browser skipped\n')
  process.exit(0)
}

const playwrightCli = join(root, 'node_modules', '@playwright', 'test', 'cli.js')
if (!existsSync(playwrightCli)) {
  console.warn('[verify:perf] Playwright missing — L1 only PASS')
  process.exit(0)
}

const browserSpecs = stress
  ? ['e2e/stream-perf.spec.js', 'e2e/stream-perf-stress.spec.js']
  : ['e2e/stream-perf.spec.js']

console.log(`\n[verify:perf] L2 browser DOM${stress ? ' + stress' : ''} (Playwright, no LLM)\n`)

const browser = spawnSync(
  process.execPath,
  [playwrightCli, 'test', ...browserSpecs, '--reporter=list'],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      EVOFLOW_E2E_HEADED: process.env.EVOFLOW_E2E_HEADED || '0',
    },
  },
)

process.exit(browser.status ?? 1)

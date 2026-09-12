#!/usr/bin/env node
/**
 * Run evopanel/*.ps1 on Windows or matching shell script on macOS/Linux.
 * Usage: node scripts/run-platform-script.js <dev|build|package|serve> [args...]
 */
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EVOPANEL_ROOT = path.join(__dirname, '..')
const isWin = process.platform === 'win32'

const name = process.argv[2]
const rest = process.argv.slice(3)

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    cwd: EVOPANEL_ROOT,
    shell: false,
    ...opts,
  })
  child.on('exit', (code) => process.exit(code ?? 1))
}

function ps1(file, extra = []) {
  const script = path.join(__dirname, file)
  run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', script, ...extra], { shell: isWin })
}

function bashScript(file, extra = []) {
  const script = file.startsWith('/') || /^[A-Za-z]:/.test(file)
    ? file
    : path.join(__dirname, file)
  run('bash', [script, ...extra])
}

function bashRoot(file, extra = []) {
  run('bash', [path.join(EVOPANEL_ROOT, file), ...extra])
}

if (!name) fail('Usage: node scripts/run-platform-script.js <dev|build|package|serve> [args...]')

switch (name) {
  case 'dev':
    if (isWin) ps1('dev.ps1', rest)
    else bashScript('dev.sh', rest.length ? rest : ['tauri'])
    break

  case 'build': {
    if (isWin) {
      const psArgs = []
      for (const a of rest) {
        if (a === '--debug' || a === '-Debug') psArgs.push('-Debug')
        else if (a === '--clean' || a === '-Clean') psArgs.push('-Clean')
        else psArgs.push(a)
      }
      ps1('build.ps1', psArgs)
    } else {
      bashRoot('build.sh', rest)
    }
    break
  }

  case 'package':
    if (isWin) {
      const psArgs = []
      for (const a of rest) {
        if (a === '--exe-only' || a === '-ExeOnly') psArgs.push('-ExeOnly')
        else if (a === '--both' || a === '-Both') psArgs.push('-Both')
        else psArgs.push(a)
      }
      ps1('package.ps1', psArgs)
    } else if (process.platform === 'darwin') {
      bashScript('build-installer-mac.sh', rest)
    } else {
      fail(
        'package is Windows/macOS only. On Linux use: ./build.sh (desktop) or repo-root scripts/deploy.sh (Docker server).',
      )
    }
    break

  case 'serve':
    if (isWin) ps1('serve.ps1', rest)
    else fail('Use "npm run serve" (node scripts/serve.js) on macOS/Linux.')
    break

  default:
    fail(`Unknown script "${name}". Expected dev|build|package|serve.`)
}

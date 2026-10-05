#!/usr/bin/env node
/**
 * 起本地栈（gateway + vite 1521）并保持前台等待，供 Playwright 验证脚本复用。
 * 用法：node scripts/ensure-stack.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'

const GW_PORT = 8012
const VITE_PORT = 1521
const REPO = 'D:/dev/github/EvoFlow'
const PANEL = `${REPO}/evopanel`

function alive(port) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (r) => {
      r.resume()
      res(true)
    })
    req.on('error', () => res(false))
    req.on('timeout', () => {
      req.destroy()
      res(false)
    })
  })
}

async function waitPort(port, ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await alive(port)) return true
    await new Promise((r) => setTimeout(r, 700))
  }
  return false
}

const gwUp = await alive(GW_PORT)
console.log(`gateway :${GW_PORT} -> ${gwUp ? 'up' : 'down'}`)
if (!gwUp) {
  const gw = spawn(`${REPO}/backend/dist/evoflow-gateway/evoflow-gateway.exe`, [], {
    cwd: REPO,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, EVOFLOW_GATEWAY_PORT: String(GW_PORT) },
  })
  gw.unref()
  console.log('  started gateway pid', gw.pid)
  console.log('  gateway ready ->', await waitPort(GW_PORT))
}

const viteUp = await alive(VITE_PORT)
console.log(`vite    :${VITE_PORT} -> ${viteUp ? 'up' : 'down'}`)
if (!viteUp) {
  // Windows 下用 npx.cmd 拉起 vite，并固定指向 gateway 端口
  const vite = spawn('npx.cmd', ['vite'], {
    cwd: PANEL,
    detached: true,
    stdio: 'ignore',
    shell: true,
    env: {
      ...process.env,
      EVOFLOW_VITE_PORT: String(VITE_PORT),
      EVOFLOW_GATEWAY_URL: `http://127.0.0.1:${GW_PORT}`,
    },
  })
  vite.unref()
  console.log('  started vite pid', vite.pid)
  console.log('  vite ready ->', await waitPort(VITE_PORT))
}

console.log('OK: stack ready')

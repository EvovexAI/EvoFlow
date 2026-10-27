/**
 * Bundle a portable Node binary into kws-sidecar/runtime/ for desktop packaging.
 * Prefer copying the current process Node (dev/CI machines); fall back to official dist zip.
 *
 * Usage: node scripts/ensure-kws-runtime-node.js
 */
import {
  copyFileSync,
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { get } from 'https'
import { pipeline } from 'stream/promises'
import { execSync } from 'child_process'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const RUNTIME = join(ROOT, 'kws-sidecar', 'runtime')
const NODE_VER = process.env.EVOFLOW_KWS_NODE_VERSION || '20.18.1'

function exeName() {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

function runtimeNodePath() {
  return join(RUNTIME, exeName())
}

function okBinary(p) {
  try {
    return existsSync(p) && statSync(p).size > 1_000_000
  } catch {
    return false
  }
}

function download(url, dest) {
  return new Promise((resolvePromise, reject) => {
    get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const next = res.headers.location
        if (!next) {
          reject(new Error(`Redirect without location for ${url}`))
          return
        }
        download(next, dest).then(resolvePromise).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      const file = createWriteStream(dest)
      pipeline(res, file).then(resolvePromise).catch(reject)
    }).on('error', reject)
  })
}

function platformDist() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') {
    return {
      url: `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-win-${arch}.zip`,
      kind: 'zip',
      member: `node-v${NODE_VER}-win-${arch}/node.exe`,
    }
  }
  if (process.platform === 'darwin') {
    return {
      url: `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-darwin-${arch}.tar.gz`,
      kind: 'tar',
      member: `node-v${NODE_VER}-darwin-${arch}/bin/node`,
    }
  }
  return {
    url: `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-${arch}.tar.xz`,
    kind: 'tar',
    member: `node-v${NODE_VER}-linux-${arch}/bin/node`,
  }
}

function tryCopyCurrentNode() {
  const src = process.execPath
  // Skip if somehow running under a weird host that isn't node
  if (!/node(\.exe)?$/i.test(src)) return false
  try {
    mkdirSync(RUNTIME, { recursive: true })
    const dest = runtimeNodePath()
    copyFileSync(src, dest)
    if (process.platform !== 'win32') chmodSync(dest, 0o755)
    console.log(`[kws-node] copied current Node → ${dest}`)
    return okBinary(dest)
  } catch (e) {
    console.warn('[kws-node] copy current node failed:', e?.message || e)
    return false
  }
}

async function downloadOfficial() {
  const dist = platformDist()
  const work = join(tmpdir(), `evoflow-kws-node-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  mkdirSync(RUNTIME, { recursive: true })
  const archive = join(work, dist.kind === 'zip' ? 'node.zip' : 'node.tgz')
  console.log(`[kws-node] downloading ${dist.url}`)
  try {
    await download(dist.url, archive)
    if (dist.kind === 'zip') {
      execSync(`tar -xf "${archive}"`, { cwd: work, stdio: 'inherit', shell: true })
    } else {
      execSync(`tar -xf "${archive}"`, { cwd: work, stdio: 'inherit', shell: true })
    }
    const extracted = join(work, dist.member.replace(/\//g, process.platform === 'win32' ? '\\' : '/'))
    // member path uses /
    const memberFs = join(work, ...dist.member.split('/'))
    const src = existsSync(memberFs) ? memberFs : extracted
    if (!existsSync(src)) throw new Error(`extracted binary missing: ${dist.member}`)
    const dest = runtimeNodePath()
    copyFileSync(src, dest)
    if (process.platform !== 'win32') chmodSync(dest, 0o755)
    console.log(`[kws-node] installed official Node → ${dest}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function main() {
  if (okBinary(runtimeNodePath())) {
    console.log('[kws-node] runtime node already present')
    return
  }
  if (tryCopyCurrentNode()) return
  await downloadOfficial()
  if (!okBinary(runtimeNodePath())) {
    console.error('[kws-node] failed to install runtime node')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('[kws-node]', e)
  process.exit(1)
})

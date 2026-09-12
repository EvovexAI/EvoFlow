/**
 * Download / refresh KWS assets into evopanel/public/kws/ for packaging.
 *
 * China-friendly path:
 *   1) WASM runtime from npm `sherpa-onnx` via npmmirror (includes KWS exports)
 *   2) ONNX model from GitHub release (usually reachable) or skip if already present
 *
 * Default wake word: 「小V小V」
 * Phoneme aliases（均标注 @小V小V；tokens 仅有大写 V）:
 *   - 字母 V / 小维·小微（主唤醒，高 boost、低阈值）
 *   - 口音/ASR 误听（蜜、米等），仅作兼容，产品名仍是小V
 * Run: node scripts/download-kws-model.js
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { get } from 'https'
import { pipeline } from 'stream/promises'
import { execSync } from 'child_process'
import { createWriteStream } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = resolve(__dirname, '..', 'public', 'kws')
const SHERPA_NPM_VERSION = process.env.EVOFLOW_SHERPA_ONNX_VERSION || '1.13.4'
const NPM_REGISTRY = process.env.EVOFLOW_NPM_REGISTRY || 'https://registry.npmmirror.com'

const MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2'

function isValidJsFile(path) {
  try {
    const buf = readFileSync(path)
    if (buf.length < 256) return false
    const head = buf.subarray(0, 120).toString('utf8')
    if (/^Failed to fetch|^Not Found|^<!DOCTYPE|^404/i.test(head)) return false
    return /function|var |let |const |\(function|Module|\/\//.test(head)
  } catch {
    return false
  }
}

function isValidWasmFile(path) {
  try {
    const buf = readFileSync(path)
    if (buf.length < 4096) return false
    return buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d
  } catch {
    return false
  }
}

function hasModelFiles() {
  return (
    existsSync(join(PUBLIC_DIR, 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx')) &&
    existsSync(join(PUBLIC_DIR, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx')) &&
    existsSync(join(PUBLIC_DIR, 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx')) &&
    existsSync(join(PUBLIC_DIR, 'tokens.txt'))
  )
}

function bundleReady() {
  return (
    hasModelFiles() &&
    isValidJsFile(join(PUBLIC_DIR, 'sherpa-onnx-kws.js')) &&
    isValidJsFile(join(PUBLIC_DIR, 'sherpa-onnx-wasm-kws-main.js')) &&
    isValidWasmFile(join(PUBLIC_DIR, 'sherpa-onnx-wasm-kws-main.wasm'))
  )
}

function writeKeywords() {
  writeFileSync(
    join(PUBLIC_DIR, 'keywords.txt'),
    [
      // tokens.txt has uppercase V only (lowercase v is invalid)
      // :boost #threshold — letter-V / 维·微 are weaker than 蜜/米 on Wenetspeech KWS
      'x iǎo V x iǎo V @小V小V :2.5 #0.18',
      'x iǎo w éi x iǎo w éi @小V小V :2.5 #0.18',
      'x iǎo w ēi x iǎo w ēi @小V小V :2.5 #0.18',
      'x iǎo w ěi x iǎo w ěi @小V小V :2.0 #0.2',
      // legacy / ASR-near pronunciations → same product wake label
      'x iǎo m ì x iǎo m ì @小V小V :1.0 #0.25',
      'x iǎo m ǐ x iǎo m ǐ @小V小V :1.0 #0.25',
      '',
    ].join('\n'),
  )
}

/** Keep only runtime assets that wake-word.js loads (lean installer). */
function prunePackagingExtras() {
  const keepFiles = new Set([
    'encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
    'decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
    'joiner-epoch-12-avg-2-chunk-16-left-64.onnx',
    'tokens.txt',
    'keywords.txt',
    'sherpa-onnx-kws.js',
    'sherpa-onnx-wasm-kws-main.js',
    'sherpa-onnx-wasm-kws-main.wasm',
  ])
  for (const name of readdirSync(PUBLIC_DIR)) {
    const full = join(PUBLIC_DIR, name)
    if (statSync(full).isDirectory()) {
      rmSync(full, { recursive: true, force: true })
      console.log(`[kws-setup] pruned dir ${name}/`)
      continue
    }
    if (!keepFiles.has(name)) {
      rmSync(full, { force: true })
      console.log(`[kws-setup] pruned ${name}`)
    }
  }
}

async function download(url, dest) {
  console.log(`  [downloading] ${url}`)
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

function flattenModelDir() {
  for (const name of readdirSync(PUBLIC_DIR)) {
    const full = join(PUBLIC_DIR, name)
    if (!statSync(full).isDirectory()) continue
    for (const child of readdirSync(full)) {
      const src = join(full, child)
      const dst = join(PUBLIC_DIR, child)
      if (existsSync(dst)) rmSync(dst, { force: true })
      renameSync(src, dst)
    }
    rmSync(full, { recursive: true, force: true })
  }
}

/** Pull WASM + kws glue from npm (npmmirror) — works on CN networks. */
function fetchWasmFromNpm() {
  const work = join(tmpdir(), `evoflow-kws-npm-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  console.log(`[kws-setup] npm pack sherpa-onnx@${SHERPA_NPM_VERSION} from ${NPM_REGISTRY}`)
  try {
    execSync(`npm pack sherpa-onnx@${SHERPA_NPM_VERSION} --registry=${NPM_REGISTRY}`, {
      cwd: work,
      stdio: 'inherit',
      shell: true,
    })
    const tgz = readdirSync(work).find((n) => n.endsWith('.tgz'))
    if (!tgz) throw new Error('npm pack produced no tarball')
    execSync(`tar -xf "${tgz}"`, { cwd: work, stdio: 'inherit', shell: true })
    const pkg = join(work, 'package')
    const glue = join(pkg, 'sherpa-onnx-kws.js')
    const wasmJs = join(pkg, 'sherpa-onnx-wasm-nodejs.js')
    const wasmBin = join(pkg, 'sherpa-onnx-wasm-nodejs.wasm')
    if (!isValidJsFile(glue) || !isValidJsFile(wasmJs) || !isValidWasmFile(wasmBin)) {
      throw new Error('npm package missing valid KWS/WASM files')
    }
    // Browser loader expects *-kws-main.* names
    copyFileSync(glue, join(PUBLIC_DIR, 'sherpa-onnx-kws.js'))
    copyFileSync(wasmJs, join(PUBLIC_DIR, 'sherpa-onnx-wasm-kws-main.js'))
    copyFileSync(wasmBin, join(PUBLIC_DIR, 'sherpa-onnx-wasm-kws-main.wasm'))
    patchWasmJsForBrowser(join(PUBLIC_DIR, 'sherpa-onnx-wasm-kws-main.js'))
    patchGlueJsForBrowser(join(PUBLIC_DIR, 'sherpa-onnx-kws.js'))
    console.log('[kws-setup] WASM runtime installed from npm (aliased to *-kws-main.*)')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Tauri exposes process.versions.node → emscripten calls require(); force web path. */
function patchWasmJsForBrowser(filePath) {
  let code = readFileSync(filePath, 'utf8')
  code = code
    .replace(
      /ENVIRONMENT_IS_NODE\s*=\s*globalThis\.process\?\.versions\?\.node\s*&&\s*globalThis\.process\?\.type\s*!=\s*"renderer"/g,
      'ENVIRONMENT_IS_NODE=false',
    )
    .replace(
      /var isNode\s*=\s*globalThis\.process\?\.versions\?\.node\s*&&\s*globalThis\.process\?\.type\s*!=\s*"renderer"/g,
      'var isNode=false',
    )
  writeFileSync(filePath, code)
}

function patchGlueJsForBrowser(filePath) {
  let code = readFileSync(filePath, 'utf8')
  // Replace Node-only module.exports gate with always-on globalThis export.
  const nodeExport =
    /if\s*\(\s*typeof process\s*==\s*'object'[\s\S]*?module\.exports\s*=\s*\{[\s\S]*?\};\s*\}/
  if (nodeExport.test(code)) {
    code = code.replace(
      nodeExport,
      `if (typeof globalThis !== 'undefined') {\n  globalThis.createKws = createKws;\n}`,
    )
  } else if (!/globalThis\.createKws\s*=/.test(code)) {
    code += `\nif (typeof globalThis !== 'undefined') {\n  globalThis.createKws = createKws;\n}\n`
  }
  writeFileSync(filePath, code)
}

async function main() {
  mkdirSync(PUBLIC_DIR, { recursive: true })
  writeKeywords()

  const needWasm =
    !isValidJsFile(join(PUBLIC_DIR, 'sherpa-onnx-wasm-kws-main.js')) ||
    !isValidWasmFile(join(PUBLIC_DIR, 'sherpa-onnx-wasm-kws-main.wasm')) ||
    !isValidJsFile(join(PUBLIC_DIR, 'sherpa-onnx-kws.js'))

  if (needWasm) {
    fetchWasmFromNpm()
  } else {
    console.log('[kws-setup] WASM runtime already present')
    patchWasmJsForBrowser(join(PUBLIC_DIR, 'sherpa-onnx-wasm-kws-main.js'))
    patchGlueJsForBrowser(join(PUBLIC_DIR, 'sherpa-onnx-kws.js'))
  }

  if (!hasModelFiles()) {
    console.log('[kws-setup] Downloading ONNX model from GitHub release...')
    const archivePath = resolve(PUBLIC_DIR, 'model.tar.bz2')
    await download(MODEL_URL, archivePath)
    console.log('  [extracting] model.tar.bz2...')
    execSync(`tar xf "${archivePath}" -C "${PUBLIC_DIR}"`, { stdio: 'inherit', shell: true })
    rmSync(archivePath, { force: true })
    flattenModelDir()
  } else {
    console.log('[kws-setup] ONNX model already present')
  }

  writeKeywords()
  prunePackagingExtras()

  if (!bundleReady()) {
    throw new Error('KWS bundle incomplete after download')
  }

  console.log('[kws-setup] Done! Lean files in public/kws/:')
  for (const name of readdirSync(PUBLIC_DIR).sort()) {
    try {
      const st = statSync(join(PUBLIC_DIR, name))
      if (st.isFile()) console.log(`  ${name} (${st.size} bytes)`)
      else console.log(`  ${name}/`)
    } catch {
      console.log(`  ${name}`)
    }
  }
  console.log('[kws-setup] Commit sherpa-onnx-wasm-kws-main.js/wasm (+ epoch-12 onnx) for packaged installs.')
}

main().catch((e) => {
  console.error('[kws-setup] Failed:', e.message)
  console.error('[kws-setup] Wake word will fall back to Web Speech until assets are present.')
  process.exit(1)
})

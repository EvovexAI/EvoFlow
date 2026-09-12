/**
 * Verify local KWS assets for packaging.
 *
 * - ONNX + keywords are expected in-repo.
 * - WASM runtime must be present for offline KWS wake.
 * - Missing WASM is a warning by default (Web Speech fallback works).
 * - Set EVOFLOW_REQUIRE_KWS_WASM=1 to fail the build if WASM is absent.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = resolve(__dirname, '..', 'public', 'kws')
const REQUIRE = String(process.env.EVOFLOW_REQUIRE_KWS_WASM || '').trim() === '1'

function okFile(name, minBytes) {
  const p = join(PUBLIC_DIR, name)
  if (!existsSync(p)) return false
  try {
    return statSync(p).size >= minBytes
  } catch {
    return false
  }
}

function looksLikeJs(name) {
  try {
    const head = readFileSync(join(PUBLIC_DIR, name), 'utf8').slice(0, 160)
    return /function|var |let |const |Module/.test(head)
  } catch {
    return false
  }
}

function looksLikeWasm(name) {
  try {
    const buf = readFileSync(join(PUBLIC_DIR, name))
    return buf.length >= 4096 && buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d
  } catch {
    return false
  }
}

const hasEncoder = okFile('encoder-epoch-12-avg-2-chunk-16-left-64.onnx', 1024)
const hasDecoder = okFile('decoder-epoch-12-avg-2-chunk-16-left-64.onnx', 1024)
const hasJoiner = okFile('joiner-epoch-12-avg-2-chunk-16-left-64.onnx', 1024)
const hasTokens = okFile('tokens.txt', 64)
const hasKeywords = okFile('keywords.txt', 8)
const hasGlue = okFile('sherpa-onnx-kws.js', 256) && looksLikeJs('sherpa-onnx-kws.js')
const hasWasmJs =
  okFile('sherpa-onnx-wasm-kws-main.js', 256) && looksLikeJs('sherpa-onnx-wasm-kws-main.js')
const hasWasmBin =
  okFile('sherpa-onnx-wasm-kws-main.wasm', 4096) && looksLikeWasm('sherpa-onnx-wasm-kws-main.wasm')

const modelOk = hasEncoder && hasDecoder && hasJoiner && hasTokens && hasKeywords && hasGlue
const wasmOk = hasWasmJs && hasWasmBin

console.log('[kws-ensure] model/onnx/keywords/glue:', modelOk ? 'ok' : 'MISSING')
console.log('[kws-ensure] wasm runtime:', wasmOk ? 'ok' : 'MISSING')

if (!modelOk) {
  console.error('[kws-ensure] Incomplete ONNX/keywords under public/kws/')
  process.exit(1)
}

if (!wasmOk) {
  const msg =
    '[kws-ensure] WASM missing (sherpa-onnx-wasm-kws-main.js/wasm). ' +
    'Offline KWS wake will not work for packaged installs; Web Speech fallback still works. ' +
    'Run: node scripts/download-kws-model.js  then commit the two wasm files.'
  if (REQUIRE) {
    console.error(msg)
    process.exit(1)
  }
  console.warn(msg)
  process.exit(0)
}

console.log('[kws-ensure] Full KWS bundle ready for packaging.')

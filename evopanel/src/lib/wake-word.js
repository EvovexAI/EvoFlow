/**
 * Wake word detection — 「小V小V」 using sherpa-onnx WASM.
 *
 * Mic remains open, AudioWorklet captures 16kHz Float32 PCM chunks,
 * sherpa-onnx KWS detects the wake word. On hit → voice capture starts.
 *
 * Bundled model files: public/kws/ (ONNX + tokens + keywords + WASM)
 * Run `node scripts/download-kws-model.js` before using wake word.
 */

export const WAKE_WORD_LABEL = '小V小V'

const KWS_BASE = '/kws'
const KWS_GLUE_JS = `${KWS_BASE}/sherpa-onnx-kws.js`
const KWS_WASM_JS = `${KWS_BASE}/sherpa-onnx-wasm-kws-main.js`
const KWS_WASM_BIN = `${KWS_BASE}/sherpa-onnx-wasm-kws-main.wasm`

// Default sherpa keywordsThreshold is 0.25; 0.35 made letter-V / 维 weaker than 蜜.
const KEYWORD_THRESHOLD = 0.22
const KEYWORD_SCORE = 1.5
const COOLDOWN_MS = 800
const SAMPLE_RATE = 16000
const CHUNK_SAMPLES = 1600

/** @type {AudioContext | null} */
let audioCtx = null
/** @type {AudioWorkletNode | null} */
let workletNode = null
/** @type {MediaStream | null} */
let micStream = null
let running = false
let modelLoaded = false
/** @type {any} */
let kwsEngine = null
/** @type {any} */
let kwsStream = null
let lastHitTime = 0
let wasmInitPromise = null

const PCM_WORKLET_SRC = `
class WakeCaptureProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this._size = (opts && opts.processorOptions && opts.processorOptions.chunk) || 1600;
    this._buf = new Float32Array(this._size);
    this._n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this._buf[this._n++] = ch[i];
        if (this._n >= this._size) {
          const out = new Float32Array(this._buf);
          this.port.postMessage(out, [out.buffer]);
          this._buf = new Float32Array(this._size);
          this._n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('wake-capture', WakeCaptureProcessor);
`

function looksLikeJs(text) {
  const head = String(text || '').slice(0, 160)
  if (!head || /^Failed to fetch|^Not Found|^404|^<!DOCTYPE/i.test(head)) return false
  return /function|var |let |const |\(function|\/\//.test(head)
}

async function probeAsset(url, minBytes = 256) {
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-store' })
    if (!res.ok) return false
    const buf = await res.arrayBuffer()
    if (buf.byteLength < minBytes) return false
    if (url.endsWith('.wasm')) {
      const view = new Uint8Array(buf)
      return view[0] === 0x00 && view[1] === 0x61 && view[2] === 0x73 && view[3] === 0x6d
    }
    return looksLikeJs(new TextDecoder().decode(buf.slice(0, 160)))
  } catch {
    return false
  }
}

export async function isKwsBundleAvailable() {
  const [glue, wasmJs, wasmBin] = await Promise.all([
    probeAsset(KWS_GLUE_JS),
    probeAsset(KWS_WASM_JS),
    probeAsset(KWS_WASM_BIN, 4096),
  ])
  return glue && wasmJs && wasmBin
}

function loadScriptOnce(src, key) {
  // Always replace: a previous failed eval (e.g. require in Node path) may leave a tag.
  const prev = document.querySelector(`script[data-kws="${key}"]`)
  if (prev) prev.remove()
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.dataset.kws = key
    script.async = false
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(script)
  })
}

/**
 * npm sherpa-onnx WASM is built with Node+Web. In Tauri/Electron, `process.versions.node`
 * is often present, and the factory also calls require("path") unconditionally.
 * Fetch + force web env + inject a tiny require shim, then load as a blob classic script.
 */
function buildBrowserRequireShim() {
  return `
var require = function (id) {
  id = String(id || '');
  if (id === 'path') {
    return {
      isAbsolute: function (p) { return /^([a-zA-Z]:)?[\\\\/]/.test(String(p || '')); },
      normalize: function (p) {
        var s = String(p || '').replace(/\\\\/g, '/');
        // collapse // and resolve ./ ../ lightly
        var parts = s.split('/');
        var out = [];
        for (var i = 0; i < parts.length; i++) {
          var part = parts[i];
          if (!part || part === '.') continue;
          if (part === '..') { out.pop(); continue; }
          out.push(part);
        }
        var joined = out.join('/');
        return s.charAt(0) === '/' ? '/' + joined : joined;
      },
      join: function () {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var s = String(arguments[i] || '').trim();
          if (s) parts.push(s.replace(/^\\/+|\\/+$/g, ''));
        }
        return parts.join('/');
      },
      basename: function (p, ext) {
        var s = String(p || '').replace(/\\\\/g, '/');
        var i = s.lastIndexOf('/');
        var base = i >= 0 ? s.slice(i + 1) : s;
        if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
        return base;
      },
      dirname: function (p) {
        var s = String(p || '').replace(/\\\\/g, '/');
        var i = s.lastIndexOf('/');
        if (i <= 0) return i === 0 ? '/' : '.';
        return s.slice(0, i);
      },
      extname: function (p) {
        var base = String(p || '').replace(/\\\\/g, '/');
        var i = base.lastIndexOf('/');
        if (i >= 0) base = base.slice(i + 1);
        var d = base.lastIndexOf('.');
        return d > 0 ? base.slice(d) : '';
      },
      resolve: function () {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var s = String(arguments[i] || '');
          if (!s) continue;
          if (/^([a-zA-Z]:)?[\\\\/]/.test(s)) parts = [s];
          else parts.push(s);
        }
        return this.normalize(parts.join('/'));
      },
      sep: '/',
      delimiter: ':',
    };
  }
  if (id === 'fs') {
    return { readFileSync: function () { throw new Error('fs unavailable in browser'); } };
  }
  if (id === 'crypto') {
    return {
      randomFillSync: function (view) {
        if (globalThis.crypto && globalThis.crypto.getRandomValues) {
          globalThis.crypto.getRandomValues(view);
        }
        return view;
      },
    };
  }
  if (id === 'os') {
    return { cpus: function () { return new Array((navigator.hardwareConcurrency || 4)).fill({}); } };
  }
  if (id === 'util') {
    return { inspect: function (a) { return String(a); } };
  }
  if (id === 'worker_threads') {
    return { Worker: globalThis.Worker, isMainThread: true, workerData: null };
  }
  throw new Error('require not available in browser: ' + id);
};
`
}

async function loadWasmMainAsBrowserScript() {
  const res = await fetch(KWS_WASM_JS, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Failed to fetch ${KWS_WASM_JS}: ${res.status}`)
  let code = await res.text()
  if (!looksLikeJs(code)) throw new Error('KWS WASM JS looks invalid')

  // Force web environment even when Tauri exposes process.versions.node.
  code = code
    .replace(
      /ENVIRONMENT_IS_NODE\s*=\s*globalThis\.process\?\.versions\?\.node\s*&&\s*globalThis\.process\?\.type\s*!=\s*"renderer"/g,
      'ENVIRONMENT_IS_NODE=false',
    )
    .replace(
      /var isNode\s*=\s*globalThis\.process\?\.versions\?\.node\s*&&\s*globalThis\.process\?\.type\s*!=\s*"renderer"/g,
      'var isNode=false',
    )

  // Factory still does unconditional require("path") — shim must come first.
  code = buildBrowserRequireShim() + code

  // Ensure factory lands on globalThis even when CJS/AMD branches run oddly.
  if (!/globalThis\.Module\s*=/.test(code.slice(-900))) {
    code +=
      '\n;if(typeof Module!=="undefined"){globalThis.Module=Module;}' +
      'else if(typeof moduleRtn!=="undefined"){globalThis.Module=moduleRtn;}\n'
  }

  const blob = new Blob([code], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    await loadScriptOnce(url, 'wasm-main')
  } finally {
    URL.revokeObjectURL(url)
  }

  // Keep a global require stub for the factory invoke (unconditional require("path")).
  if (typeof globalThis.require !== 'function') {
    // eslint-disable-next-line no-new-func
    globalThis.require = new Function(`${buildBrowserRequireShim()}; return require;`)()
  }

  if (typeof globalThis.Module !== 'function' && typeof globalThis.Module !== 'object') {
    throw new Error('Module missing after browser WASM script load')
  }
}

async function ensureWasmRuntime() {
  if (
    typeof globalThis.createKws === 'function' &&
    globalThis.Module?._SherpaOnnxCreateKeywordSpotter
  ) {
    return globalThis.Module
  }
  if (wasmInitPromise) return wasmInitPromise

  wasmInitPromise = (async () => {
    const ok = await isKwsBundleAvailable()
    if (!ok) {
      throw new Error('KWS bundle missing or invalid. Run: node scripts/download-kws-model.js')
    }

    await loadScriptOnce(KWS_GLUE_JS, 'glue')
    // Glue may try module.exports when process.versions.node exists (Tauri).
    if (typeof globalThis.createKws !== 'function' && typeof window.createKws === 'function') {
      globalThis.createKws = window.createKws
    }
    if (typeof globalThis.createKws !== 'function') {
      throw new Error('createKws not found after glue load')
    }

    await loadWasmMainAsBrowserScript()

    const factoryOrModule = globalThis.Module
    let wasmModule = factoryOrModule

    if (typeof factoryOrModule === 'function') {
      wasmModule = await factoryOrModule({
        locateFile: (path) => {
          if (String(path || '').endsWith('.wasm')) return KWS_WASM_BIN
          return `${KWS_BASE}/${path}`
        },
      })
      globalThis.Module = wasmModule
    } else {
      // Legacy path: wait for onRuntimeInitialized
      await new Promise((resolve, reject) => {
        if (factoryOrModule?._SherpaOnnxCreateKeywordSpotter) {
          resolve()
          return
        }
        const prev = factoryOrModule?.onRuntimeInitialized
        const timer = setTimeout(() => reject(new Error('WASM init timeout')), 20000)
        if (!factoryOrModule) {
          clearTimeout(timer)
          reject(new Error('Module missing after WASM script load'))
          return
        }
        factoryOrModule.locateFile = (path) => {
          if (String(path || '').endsWith('.wasm')) return KWS_WASM_BIN
          return `${KWS_BASE}/${path}`
        }
        factoryOrModule.onRuntimeInitialized = () => {
          clearTimeout(timer)
          try {
            prev?.()
          } catch {
            /* ignore */
          }
          resolve()
        }
      })
      wasmModule = globalThis.Module
    }

    if (typeof globalThis.createKws !== 'function') {
      throw new Error('createKws not found after WASM load')
    }
    if (!wasmModule?._SherpaOnnxCreateKeywordSpotter) {
      throw new Error('KeywordSpotter export missing in WASM module')
    }
    return wasmModule
  })()

  try {
    return await wasmInitPromise
  } catch (err) {
    wasmInitPromise = null
    throw err
  }
}

async function fetchModelAssets() {
  const encoderUrl = `${KWS_BASE}/encoder-epoch-12-avg-2-chunk-16-left-64.onnx`
  const decoderUrl = `${KWS_BASE}/decoder-epoch-12-avg-2-chunk-16-left-64.onnx`
  const joinerUrl = `${KWS_BASE}/joiner-epoch-12-avg-2-chunk-16-left-64.onnx`

  const tryFetch = async (url) => {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return null
    return res.arrayBuffer()
  }

  const encoder = await tryFetch(encoderUrl)
  const decoder = await tryFetch(decoderUrl)
  const joiner = await tryFetch(joinerUrl)

  const tokensRes = await fetch(`${KWS_BASE}/tokens.txt`, { cache: 'no-store' })
  const keywordsRes = await fetch(`${KWS_BASE}/keywords.txt`, { cache: 'no-store' })
  if (!encoder || !decoder || !joiner || !tokensRes.ok || !keywordsRes.ok) {
    throw new Error('KWS model files missing under /kws (need epoch-12 onnx + tokens + keywords)')
  }

  return {
    encoderPath: '/encoder.onnx',
    decoderPath: '/decoder.onnx',
    joinerPath: '/joiner.onnx',
    tokensPath: '/tokens.txt',
    encoder,
    decoder,
    joiner,
    tokens: await tokensRes.text(),
    keywords: await keywordsRes.text(),
  }
}

function writeMemfsFiles(Module, files) {
  if (!Module?.FS?.writeFile) {
    throw new Error('WASM FS unavailable')
  }
  for (const [path, data] of files) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new TextEncoder().encode(String(data))
    try {
      Module.FS.unlink(path)
    } catch {
      /* ignore */
    }
    Module.FS.writeFile(path, bytes)
  }
}

async function loadModel() {
  if (modelLoaded && kwsEngine && kwsStream) return true

  try {
    const Module = await ensureWasmRuntime()
    const assets = await fetchModelAssets()

    writeMemfsFiles(Module, [
      [assets.encoderPath, assets.encoder],
      [assets.decoderPath, assets.decoder],
      [assets.joinerPath, assets.joiner],
      [assets.tokensPath, assets.tokens],
    ])

    const config = {
      featConfig: { samplingRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: assets.encoderPath,
          decoder: assets.decoderPath,
          joiner: assets.joinerPath,
        },
        tokens: assets.tokensPath,
        provider: 'cpu',
        numThreads: 1,
        debug: 0,
        // Wenetspeech 3.3M KWS tokens are ppinyin (声母+带调韵母).
        modelingUnit: 'ppinyin',
      },
      keywords: assets.keywords,
      keywordsScore: KEYWORD_SCORE,
      keywordsThreshold: KEYWORD_THRESHOLD,
    }

    kwsEngine = globalThis.createKws(Module, config)
    kwsStream = kwsEngine.createStream()
    modelLoaded = true
    console.log('[wake-word] KWS model loaded, listening for', WAKE_WORD_LABEL)
    return true
  } catch (e) {
    console.warn('[wake-word] Failed to load KWS model:', e instanceof Error ? e.message : String(e))
    kwsEngine = null
    kwsStream = null
    modelLoaded = false
    // Allow a later retry after code/assets fix (e.g. path shim).
    wasmInitPromise = null
    return false
  }
}

function processPcm(samples) {
  if (!kwsEngine || !kwsStream) return null
  try {
    kwsStream.acceptWaveform(SAMPLE_RATE, samples)
    while (kwsEngine.isReady(kwsStream)) {
      kwsEngine.decode(kwsStream)
      const result = kwsEngine.getResult(kwsStream)
      const keyword = String(result?.keyword || '').trim()
      if (!keyword) continue

      kwsEngine.reset(kwsStream)
      const now = Date.now()
      if (now - lastHitTime < COOLDOWN_MS) return null
      lastHitTime = now
      return { keyword }
    }
  } catch {
    /* occasional WASM errors on rapid input */
  }
  return null
}

async function startEar() {
  if (running) return true

  try {
    if (!modelLoaded) {
      const ok = await loadModel()
      if (!ok) return false
    }

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
      },
    })

    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
    if (audioCtx.state === 'suspended') await audioCtx.resume()

    const source = audioCtx.createMediaStreamSource(micStream)

    const blob = new Blob([PCM_WORKLET_SRC], { type: 'application/javascript' })
    const workletUrl = URL.createObjectURL(blob)
    await audioCtx.audioWorklet.addModule(workletUrl)
    URL.revokeObjectURL(workletUrl)

    workletNode = new AudioWorkletNode(audioCtx, 'wake-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { chunk: CHUNK_SAMPLES },
    })

    workletNode.port.onmessage = (ev) => {
      const f32 = ev.data instanceof Float32Array ? ev.data : new Float32Array(ev.data)
      const hit = processPcm(f32)
      if (hit) {
        const label = WAKE_WORD_LABEL
        console.log('[wake-word] HIT:', label)
        window.dispatchEvent(
          new CustomEvent('wake-word-hit', {
            detail: { keyword: label, backend: 'kws', raw: hit.keyword },
          }),
        )
      }
    }

    source.connect(workletNode)
    workletNode.connect(audioCtx.destination)

    running = true
    console.log('[wake-word] Ear listening @ %d Hz', audioCtx.sampleRate)
    return true
  } catch (e) {
    console.warn('[wake-word] Failed to start:', e instanceof Error ? e.message : String(e))
    stopEar()
    return false
  }
}

function stopEar() {
  running = false
  try {
    workletNode?.disconnect()
  } catch {
    /* ignore */
  }
  workletNode = null
  for (const track of micStream?.getTracks() || []) track.stop()
  micStream = null
  if (audioCtx) {
    audioCtx.close().catch(() => {})
    audioCtx = null
  }
}

function isEarRunning() {
  return running
}

function unloadModel() {
  try {
    kwsStream?.free?.()
  } catch {
    /* ignore */
  }
  try {
    kwsEngine?.free?.()
  } catch {
    /* ignore */
  }
  kwsStream = null
  kwsEngine = null
  modelLoaded = false
}

export { startEar, stopEar, isEarRunning, unloadModel }

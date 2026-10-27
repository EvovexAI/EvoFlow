#!/usr/bin/env node
/**
 * EvoFlow KWS sidecar — isolated Keyword Spotter child process.
 *
 * Why a child process: browser/Tauri WebView cannot load the npm Node WASM build
 * (NODERAWFS). Run sherpa-onnx here (Node), feed 16 kHz Float32 PCM from the UI.
 *
 * Stdio JSONL protocol:
 *   ← {type:'init', modelDir, keywordsScore?, keywordsThreshold?}
 *   → {type:'ready'} | {type:'error', error}
 *   ← {type:'pcm', b64}   // Float32 LE base64
 *   → {type:'hit', keyword}
 *   ← {type:'pause'} | {type:'resume'} | {type:'stop'}
 */

'use strict'

const fs = require('fs')
const path = require('path')
const readline = require('readline')

// Higher score improves wake recall (3.0 >> 1.5).
const DEFAULT_KEYWORDS_SCORE = 3.0
const DEFAULT_KEYWORDS_THRESHOLD = 0.22
const COOLDOWN_MS = 800
const SAMPLE_RATE = 16000

let spotter = null
let stream = null
let lastHitAt = 0
let paused = false
let ready = false

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n')
  } catch {
    /* ignore broken pipe */
  }
}

function logErr(...args) {
  try {
    process.stderr.write('[kws-sidecar] ' + args.map(String).join(' ') + '\n')
  } catch {
    /* ignore */
  }
}

function resolveModelFile(modelDir, name) {
  const p = path.join(modelDir, name)
  if (!fs.existsSync(p)) throw new Error('missing model file: ' + name)
  return p
}

function initSpotter(modelDir, opts = {}) {
  const sherpa = require('sherpa-onnx')
  const keywordsPath = resolveModelFile(modelDir, 'keywords.txt')
  const keywords = fs.readFileSync(keywordsPath, 'utf8')
  if (!keywords.trim()) throw new Error('keywords.txt is empty')

  const score =
    typeof opts.keywordsScore === 'number' && opts.keywordsScore > 0
      ? opts.keywordsScore
      : DEFAULT_KEYWORDS_SCORE
  const threshold =
    typeof opts.keywordsThreshold === 'number' && opts.keywordsThreshold > 0
      ? opts.keywordsThreshold
      : DEFAULT_KEYWORDS_THRESHOLD

  const config = {
    featConfig: { samplingRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: resolveModelFile(modelDir, 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
        decoder: resolveModelFile(modelDir, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
        joiner: resolveModelFile(modelDir, 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx'),
      },
      tokens: resolveModelFile(modelDir, 'tokens.txt'),
      provider: 'cpu',
      numThreads: 1,
      debug: 0,
      // Wenetspeech 3.3M KWS tokens are ppinyin (声母+带调韵母).
      modelingUnit: 'ppinyin',
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: score,
    keywordsThreshold: threshold,
    keywords,
  }

  spotter = sherpa.createKws(config)
  stream = spotter.createStream()
  ready = true
  paused = false
  lastHitAt = 0
  logErr('ready score=' + score + ' threshold=' + threshold + ' dir=' + modelDir)
  send({ type: 'ready', keywordsScore: score, keywordsThreshold: threshold })
}

function feedPcmB64(b64) {
  if (!ready || paused || !spotter || !stream || !b64) return
  let samples
  try {
    const buf = Buffer.from(String(b64), 'base64')
    if (buf.byteLength < 4 || buf.byteLength % 4 !== 0) return
    samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  } catch (e) {
    logErr('bad pcm b64:', e?.message || e)
    return
  }
  if (!samples.length) return

  try {
    stream.acceptWaveform(SAMPLE_RATE, samples)
    while (spotter.isReady(stream)) {
      spotter.decode(stream)
      const result = spotter.getResult(stream)
      const keyword = String(result?.keyword || '').trim()
      if (!keyword) continue
      try {
        spotter.reset(stream)
      } catch {
        /* ignore */
      }
      const now = Date.now()
      if (now - lastHitAt < COOLDOWN_MS) continue
      lastHitAt = now
      logErr('HIT', keyword)
      send({ type: 'hit', keyword })
    }
  } catch (e) {
    logErr('decode error:', e?.message || e)
  }
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'init': {
      try {
        const modelDir = String(msg.modelDir || '').trim()
        if (!modelDir) throw new Error('modelDir required')
        initSpotter(modelDir, {
          keywordsScore: msg.keywordsScore,
          keywordsThreshold: msg.keywordsThreshold,
        })
      } catch (e) {
        ready = false
        send({ type: 'error', error: String(e?.message || e) })
      }
      break
    }
    case 'pcm':
      feedPcmB64(msg.b64)
      break
    case 'pause':
      paused = true
      break
    case 'resume':
      paused = false
      break
    case 'stop':
      try {
        stream?.free?.()
      } catch {
        /* ignore */
      }
      try {
        spotter?.free?.()
      } catch {
        /* ignore */
      }
      stream = null
      spotter = null
      ready = false
      send({ type: 'stopped' })
      process.exit(0)
      break
    default:
      break
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const raw = String(line || '').trim()
  if (!raw) return
  try {
    handleMessage(JSON.parse(raw))
  } catch (e) {
    logErr('bad json:', e?.message || e)
  }
})
rl.on('close', () => {
  process.exit(0)
})

process.on('uncaughtException', (e) => {
  logErr('uncaught:', e?.stack || e)
  send({ type: 'error', error: String(e?.message || e) })
})

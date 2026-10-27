/**
 * Native wake ear.
 *
 * WebView AudioWorklet captures 16 kHz Float32 PCM (AEC/NS/AGC off),
 * Tauri feeds a Node kws-sidecar (sherpa-onnx), hit → `wake-word-hit`.
 */

export const WAKE_WORD_LABEL = '小V小V'

const SAMPLE_RATE = 16000
const CHUNK_SAMPLES = 1600
/** KWS recall tuning (higher score → better wake recall). */
const KEYWORDS_SCORE = 3.0
const KEYWORDS_THRESHOLD = 0.22

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
registerProcessor('wake-native-capture', WakeCaptureProcessor);
`

/** @type {AudioContext | null} */
let audioCtx = null
/** @type {AudioWorkletNode | null} */
let workletNode = null
/** @type {GainNode | null} */
let muteGain = null
/** @type {MediaStream | null} */
let micStream = null
let running = false
/** @type {(() => void) | null} */
let unlistenHit = null
let feedBusy = false

function float32ToBase64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

async function getInvoke() {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke
}

export async function isNativeKwsAvailable() {
  try {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window || '__TAURI__' in window)) {
      return false
    }
    const invoke = await getInvoke()
    // Probe by starting would be heavy; just check invoke exists + node will be validated on start.
    return typeof invoke === 'function'
  } catch {
    return false
  }
}

async function bindHitListener() {
  if (unlistenHit) return
  const { listen } = await import('@tauri-apps/api/event')
  unlistenHit = await listen('wake-kws-hit', (ev) => {
    const keyword = String(ev?.payload?.keyword || WAKE_WORD_LABEL).trim() || WAKE_WORD_LABEL
    console.log('[wake-word-native] HIT:', keyword)
    void import('./xiaomi-voice/voice-file-log.js')
      .then(({ voiceFeLog }) =>
        voiceFeLog('会话', `唤醒命中 backend=native-kws keyword=「${keyword.slice(0, 40)}」→ 开麦`),
      )
      .catch(() => {})
    window.dispatchEvent(
      new CustomEvent('wake-word-hit', {
        detail: { keyword: WAKE_WORD_LABEL, backend: 'native-kws', raw: keyword },
      }),
    )
  })
}

export async function startNativeEar() {
  if (running) return true

  try {
    const invoke = await getInvoke()
    const ok = await invoke('wake_kws_start', {
      keywordsScore: KEYWORDS_SCORE,
      keywordsThreshold: KEYWORDS_THRESHOLD,
    })
    if (!ok) return false

    await bindHitListener()

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

    workletNode = new AudioWorkletNode(audioCtx, 'wake-native-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { chunk: CHUNK_SAMPLES },
    })

    workletNode.port.onmessage = (ev) => {
      if (feedBusy) return
      const f32 = ev.data instanceof Float32Array ? ev.data : new Float32Array(ev.data)
      const b64 = float32ToBase64(f32)
      feedBusy = true
      invoke('wake_kws_feed_pcm', { b64 })
        .catch(() => {})
        .finally(() => {
          feedBusy = false
        })
    }

    // Mute destination — keep graph alive without looping mic into speakers.
    muteGain = audioCtx.createGain()
    muteGain.gain.value = 0
    source.connect(workletNode)
    workletNode.connect(muteGain)
    muteGain.connect(audioCtx.destination)

    running = true
    console.log(
      '[wake-word-native] Ear listening @ %d Hz (sidecar KWS · %s)',
      audioCtx.sampleRate,
      WAKE_WORD_LABEL,
    )
    void import('./xiaomi-voice/voice-file-log.js')
      .then(({ voiceFeMirror }) =>
        voiceFeMirror(
          '会话',
          '唤醒耳已开启，聆听',
          `${WAKE_WORD_LABEL} backend=native-kws @${audioCtx.sampleRate}Hz`,
        ),
      )
      .catch(() => {})
    return true
  } catch (e) {
    console.warn('[wake-word-native] Failed to start:', e?.message || e)
    void import('./xiaomi-voice/voice-file-log.js')
      .then(({ voiceFeMirror }) =>
        voiceFeMirror('会话', '唤醒耳启动失败 backend=native-kws', e?.message || String(e)),
      )
      .catch(() => {})
    await stopNativeEar()
    return false
  }
}

export async function stopNativeEar() {
  running = false
  try {
    workletNode?.disconnect()
  } catch {
    /* ignore */
  }
  try {
    muteGain?.disconnect()
  } catch {
    /* ignore */
  }
  workletNode = null
  muteGain = null
  for (const track of micStream?.getTracks() || []) track.stop()
  micStream = null
  if (audioCtx) {
    audioCtx.close().catch(() => {})
    audioCtx = null
  }
  try {
    if (unlistenHit) {
      unlistenHit()
      unlistenHit = null
    }
  } catch {
    /* ignore */
  }
  try {
    const invoke = await getInvoke()
    await invoke('wake_kws_stop')
  } catch {
    /* ignore */
  }
}

export function isNativeEarRunning() {
  return running
}

export async function pauseNativeEar() {
  if (!running) return
  try {
    const invoke = await getInvoke()
    await invoke('wake_kws_pause')
  } catch {
    /* ignore */
  }
  // Release mic so Frame / continuous can take it (shared device).
  try {
    workletNode?.disconnect()
  } catch {
    /* ignore */
  }
  for (const track of micStream?.getTracks() || []) track.stop()
  micStream = null
  if (audioCtx) {
    audioCtx.close().catch(() => {})
    audioCtx = null
  }
  workletNode = null
  muteGain = null
}

export async function resumeNativeEarCapture() {
  if (!running) return false
  try {
    const invoke = await getInvoke()
    await invoke('wake_kws_resume')

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
    workletNode = new AudioWorkletNode(audioCtx, 'wake-native-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { chunk: CHUNK_SAMPLES },
    })
    workletNode.port.onmessage = (ev) => {
      if (feedBusy) return
      const f32 = ev.data instanceof Float32Array ? ev.data : new Float32Array(ev.data)
      const b64 = float32ToBase64(f32)
      feedBusy = true
      invoke('wake_kws_feed_pcm', { b64 })
        .catch(() => {})
        .finally(() => {
          feedBusy = false
        })
    }
    muteGain = audioCtx.createGain()
    muteGain.gain.value = 0
    source.connect(workletNode)
    workletNode.connect(muteGain)
    muteGain.connect(audioCtx.destination)
    return true
  } catch (e) {
    console.warn('[wake-word-native] resume capture failed:', e?.message || e)
    return false
  }
}

/**
 * Browser microphone capture → 16kHz mono WAV for Volcengine ASR flash API.
 */

/** @param {unknown} err */
export function microphoneErrorMessage(err) {
  const name = err && typeof err === 'object' ? String(err.name || '') : ''
  const msg = String((err && typeof err === 'object' && err.message) || err || '')
  if (name === 'NotFoundError' || /device not found|requested device not found/i.test(msg)) {
    return '未找到可用麦克风。请确认电脑已连接/启用输入设备，并在 Windows「设置 → 隐私 → 麦克风」中允许桌面应用访问。'
  }
  if (name === 'NotAllowedError' || /permission|denied/i.test(msg)) {
    return '麦克风权限被拒绝。请允许本应用使用麦克风后重试（可先点一次输入框旁的麦克风按钮授权）。'
  }
  if (name === 'NotReadableError' || /could not start|in use|busy/i.test(msg)) {
    return '麦克风被其他程序占用或无法启动，请关闭占用麦克风的应用后重试。'
  }
  if (name === 'SecurityError') {
    return '当前页面无法访问麦克风，请使用 HTTPS 或桌面版 EvoPanel。'
  }
  return msg || '无法打开麦克风'
}

/** @returns {Promise<MediaStream>} */
export async function requestMicrophoneStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不支持麦克风')
  }

  /** @type {MediaStreamConstraints[]} */
  const attempts = [
    { audio: { echoCancellation: true, noiseSuppression: true, channelCount: { ideal: 1 } } },
    { audio: { echoCancellation: true, noiseSuppression: true } },
    { audio: true },
  ]

  /** @type {unknown} */
  let lastErr = null
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints)
    } catch (e) {
      lastErr = e
      const name = e && typeof e === 'object' ? String(e.name || '') : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') break
    }
  }

  const err = lastErr instanceof Error ? lastErr : new Error(microphoneErrorMessage(lastErr))
  if (!(err instanceof DOMException) && lastErr && typeof lastErr === 'object' && lastErr.name) {
    err.name = String(lastErr.name)
  }
  throw err
}

/** @param {unknown} err */
export function isMicrophoneAccessError(err) {
  const name = err && typeof err === 'object' ? String(err.name || '') : ''
  const msg = String((err && typeof err === 'object' && err.message) || err || '')
  return (
    name === 'NotFoundError' ||
    name === 'NotAllowedError' ||
    name === 'NotReadableError' ||
    name === 'SecurityError' ||
    /device not found|requested device not found|permission|denied|could not start|not found/i.test(msg) ||
    /未找到可用麦克风|麦克风权限|麦克风被其他|无法打开麦克风|当前环境不支持麦克风/i.test(msg)
  )
}

/** 快速探测是否有可用麦克风（无则直接走演示模式，避免 getUserMedia 报错） */
export async function probeMicrophoneAvailable() {
  if (!navigator.mediaDevices?.getUserMedia) return false
  try {
    const devices = await navigator.mediaDevices.enumerateDevices?.()
    if (Array.isArray(devices) && !devices.some((d) => d.kind === 'audioinput')) {
      return false
    }
  } catch {
    /* enumerateDevices 失败时仍尝试 getUserMedia */
  }
  return true
}

function encodeWavPcm16(samples, sampleRate) {
  const numChannels = 1
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/**
 * @param {Blob} blob
 * @param {number} [targetRate]
 * @returns {Promise<Blob>}
 */
export async function blobToWav16kMono(blob, targetRate = 16000) {
  const arrayBuffer = await blob.arrayBuffer()
  const audioCtx = new AudioContext()
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0))
    const duration = decoded.duration
    const offline = new OfflineAudioContext(1, Math.ceil(duration * targetRate), targetRate)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start(0)
    const rendered = await offline.startRendering()
    const channel = rendered.getChannelData(0)
    return encodeWavPcm16(channel, targetRate)
  } finally {
    await audioCtx.close().catch(() => {})
  }
}

export class VoiceRecorder {
  /** @type {MediaStream | null} */
  #stream = null
  /** @type {MediaRecorder | null} */
  #recorder = null
  /** @type {Blob[]} */
  #chunks = []
  /** @type {AudioContext | null} */
  #audioCtx = null
  /** @type {AnalyserNode | null} */
  #analyser = null
  /** @type {ReturnType<typeof setInterval> | null} */
  #levelTimer = null
  /** @type {((levels: number[]) => void) | null} */
  #onLevel = null

  get recording() {
    return !!this.#recorder && this.#recorder.state === 'recording'
  }

  /**
   * @param {{ onLevel?: (levels: number[]) => void }} [opts]
   */
  async start(opts = {}) {
    if (this.recording) return
    this.#chunks = []
    this.#onLevel = typeof opts.onLevel === 'function' ? opts.onLevel : null
    this.#stream = await requestMicrophoneStream()

    if (this.#onLevel) {
      try {
        this.#audioCtx = new AudioContext()
        const source = this.#audioCtx.createMediaStreamSource(this.#stream)
        this.#analyser = this.#audioCtx.createAnalyser()
        this.#analyser.fftSize = 128
        this.#analyser.smoothingTimeConstant = 0.72
        source.connect(this.#analyser)
        const bins = new Uint8Array(this.#analyser.frequencyBinCount)
        const barCount = 24
        this.#levelTimer = setInterval(() => {
          if (!this.#analyser || !this.#onLevel) return
          this.#analyser.getByteFrequencyData(bins)
          const step = Math.max(1, Math.floor(bins.length / barCount))
          const levels = []
          for (let i = 0; i < barCount; i++) {
            let peak = 0
            const start = i * step
            const end = Math.min(bins.length, start + step)
            for (let j = start; j < end; j++) peak = Math.max(peak, bins[j])
            levels.push(Math.min(1, peak / 180))
          }
          this.#onLevel(levels)
        }, 33)
      } catch (e) {
        console.warn('[voice-recorder] analyser setup failed', e)
      }
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : ''
    this.#recorder = mimeType
      ? new MediaRecorder(this.#stream, { mimeType })
      : new MediaRecorder(this.#stream)
    this.#recorder.ondataavailable = (ev) => {
      if (ev.data?.size) this.#chunks.push(ev.data)
    }
    this.#recorder.start()
  }

  async stop() {
    if (!this.#recorder) return null
    const recorder = this.#recorder
    const stream = this.#stream
    this.#recorder = null
    this.#stream = null

    const blob = await new Promise((resolve) => {
      recorder.onstop = () => {
        if (!this.#chunks.length) {
          resolve(null)
          return
        }
        resolve(new Blob(this.#chunks, { type: recorder.mimeType || 'audio/webm' }))
      }
      if (recorder.state !== 'inactive') recorder.stop()
      else resolve(null)
    })

    for (const track of stream?.getTracks() || []) {
      track.stop()
    }
    this.#teardownAnalyser()
    this.#chunks = []
    if (!blob) return null
    return blobToWav16kMono(blob)
  }

  #teardownAnalyser() {
    clearInterval(this.#levelTimer)
    this.#levelTimer = null
    try {
      this.#analyser?.disconnect()
    } catch {
      /* ignore */
    }
    this.#analyser = null
    if (this.#audioCtx) {
      void this.#audioCtx.close().catch(() => {})
      this.#audioCtx = null
    }
    this.#onLevel = null
  }
}

function floatTo16BitPcm(float32Array) {
  const out = new Int16Array(float32Array.length)
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

function downsampleTo16k(float32Array, sampleRate) {
  if (sampleRate === 16000) return floatTo16BitPcm(float32Array)
  const ratio = sampleRate / 16000
  const outLen = Math.max(1, Math.floor(float32Array.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) out[i] = float32Array[Math.floor(i * ratio)] || 0
  return floatTo16BitPcm(out)
}

// ─── AudioWorklet processor source (runs on separate audio thread) ───
// Runs on a dedicated audio thread, immune to main-thread jank → no dropped frames.
// Loaded via Blob URL to avoid file:// path issues in Tauri/Electron packaging.
const PCM_WORKLET_SRC = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._size = (options && options.processorOptions && options.processorOptions.chunk) || 2048;
    this._buf = new Int16Array(this._size);
    this._n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        let s = ch[i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        this._buf[this._n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this._n >= this._size) {
          const out = this._buf.slice(0, this._n);
          this.port.postMessage(out.buffer, [out.buffer]);
          this._n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

const PCM_CHUNK_SAMPLES = 2048; // 2048 @ 16kHz = 128ms/chunk
const RECONNECT_MAX_CHUNKS = Math.ceil(8000 * 16000 / 1000 / PCM_CHUNK_SAMPLES); // ~8s buffer
const BARGEIN_PRE_BUFFER_MS = 1500; // TTS 期间打断预缓冲时长
const BARGEIN_MAX_CHUNKS = Math.ceil(BARGEIN_PRE_BUFFER_MS * 16000 / 1000 / PCM_CHUNK_SAMPLES); // ~12 块
const STALL_RECONNECT_MS = 3500; // still talking but no transcript for this long → reconnect
const WATCHDOG_SPEECH_VOL = 0.08;
const WATCHDOG_WARMUP_MS = 8000; // don't force-reconnect until ASR has had time to speak

/** Live mic → streaming ASR with partial transcripts. */
export class StreamingVoiceRecorder {
  /** @type {WebSocket | null} */
  #ws = null;
  /** @type {AudioContext | null} */
  #audioCtx = null;
  /** @type {AudioWorkletNode | null} */
  #workletNode = null;
  /** @type {ScriptProcessorNode | null} */
  #processor = null; // fallback path
  /** @type {MediaStream | null} */
  #stream = null;
  /** @type {GainNode | null} */
  #sink = null;
  /** @type {Int16Array[]} */
  #reconnectBuffer = []; // PCM chunks buffered during WS reconnect
  /** @type {AnalyserNode | null} */
  #analyser = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  #levelTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  #watchdogTimer = null;
  /** @type {string} */
  #baseText = '';
  /** @type {string} */
  #latestText = '';
  /** @type {((text: string) => void) | null} */
  #onPartial = null;
  /** @type {((text: string) => void) | null} */
  #onFinal = null;
  /** @type {((err: Error) => void) | null} */
  #onError = null;
  /** @type {((levels: number[]) => void) | null} */
  #onLevel = null;
  /** @type {Promise<string> | null} */
  #finalPromise = null;
  /** @type {((text: string) => void) | null} */
  #resolveFinal = null;
  /** @type {boolean} */
  #intentionalClose = false;
  /** @type {number} */
  #lastInboundTs = 0;
  /** @type {number} */
  #lastLoudTs = 0;
  /** @type {number} */
  #watchdogStartedAt = 0;
  /** @type {boolean} */
  #micActive = false;
  // seg-based dedup state
  /** @type {{seg: string|null, text: string}[]} */
  #committed = [];
  /** @type {string} */
  #pendingInterim = '';
  /** @type {string | null} */
  #pcmWorkletUrl = null;
  /** @type {Int16Array[]} */
  #bargeinBuffer = []; // TTS 期间 PCM 环形缓冲（打断预缓冲）
  /** @type {boolean} */
  #bargeinBuffering = false; // 是否正在缓冲（TTS 挂起期间）
  /** @type {boolean} */
  #suspendedByTTS = false; // 是否被 TTS 挂起
  /** @type {boolean} */
  #userWantedMic = false; // 用户意图：想保持麦克风
  /** @type {string | null} */
  #lastWsUrl = null; // 记住 WS URL 供 resume 重连
  /** @type {boolean} */
  #reconnecting = false;
  /** PTT tail suppression: discard incoming transcripts until this timestamp (ms) */
  #transcriptSuppressUntil = 0;

  /** Recoverable ASR failures — reconnect instead of surfacing raw errors. */
  #isRecoverableAsrError(errMsg) {
    return /last packet has been received|asr protocol error|expecting value|jsondecodeerror|语音识别连接异常|upstream_read_failed|browser_read_failed/i.test(
      errMsg,
    );
  }

  async #reconnectAfterGlitch(reason) {
    if (!this.#micActive || this.#intentionalClose || this.#reconnecting) return;
    this.#reconnecting = true;
    console.warn('[voice] ASR glitch, reconnecting:', reason);
    try { this.#ws?.close(); } catch { /* ignore */ }
    const url = this.#lastWsUrl;
    if (!url) {
      this.#reconnecting = false;
      return;
    }
    await new Promise((r) => setTimeout(r, 800));
    if (!this.#micActive || this.#intentionalClose) {
      this.#reconnecting = false;
      return;
    }
    this.#connectWs(url);
    try {
      await this.#waitForReady();
      this.#lastInboundTs = Date.now();
    } catch (e) {
      console.warn('[voice] ASR reconnect waitForReady failed', e);
      try { this.#ws?.close(); } catch { /* ignore */ }
    } finally {
      this.#reconnecting = false;
    }
  }

  get recording() {
    return !!this.#ws && this.#ws.readyState <= WebSocket.OPEN;
  }

  /**
   * @param {{
   *   baseText?: string
   *   onPartial?: (text: string) => void
   *   onFinal?: (text: string) => void
   *   onError?: (err: Error) => void
   *   onLevel?: (levels: number[]) => void
   * }} opts
   */
  async start(opts = {}) {
    if (this.recording) return;
    this.#baseText = String(opts.baseText || '');
    this.#latestText = this.#baseText;
    this.#onPartial = opts.onPartial || null;
    this.#onFinal = opts.onFinal || null;
    this.#onError = opts.onError || null;
    this.#onLevel = opts.onLevel || null;
    this.#reconnectBuffer = [];
    this.#committed = [];
    this.#pendingInterim = '';
    this.#micActive = true;

    try {
      this.#stream = await requestMicrophoneStream();

      const { speechAsrStreamUrl } = await import('./speech-client.js');
      const url = await speechAsrStreamUrl();
      this.#lastWsUrl = url;
      this.#intentionalClose = false;
      this.#connectWs(url);

      // Wait for server "ready" before starting audio capture
      await this.#waitForReady();

      // Set up audio capture: AudioWorklet first, ScriptProcessor fallback
      this.#audioCtx = new AudioContext({ sampleRate: 16000 });
      const source = this.#audioCtx.createMediaStreamSource(this.#stream);
      this.#analyser = this.#audioCtx.createAnalyser();
      this.#analyser.fftSize = 128;
      this.#analyser.smoothingTimeConstant = 0.72;
      source.connect(this.#analyser);

      await this.#setupCapture(source, this.#audioCtx);

      // Level meter (for UI visualization)
      if (this.#onLevel) {
        const bins = new Uint8Array(this.#analyser.frequencyBinCount);
        const barCount = 24;
        this.#levelTimer = setInterval(() => {
          if (!this.#analyser || !this.#onLevel) return;
          this.#analyser.getByteFrequencyData(bins);
          const step = Math.max(1, Math.floor(bins.length / barCount));
          const levels = [];
          for (let i = 0; i < barCount; i++) {
            let peak = 0;
            const start = i * step;
            const end = Math.min(bins.length, start + step);
            for (let j = start; j < end; j++) peak = Math.max(peak, bins[j]);
            levels.push(Math.min(1, peak / 180));
          }
          this.#onLevel(levels);
        }, 33);
      }

      this.#startWatchdog();
    } catch (e) {
      this.#teardown();
      throw e;
    }
  }

  /**
   * New upstream ASR session — drop local transcript accumulation.
   * Buffered PCM is replayed after reconnect so recognition can catch up.
   */
  #resetAsrTranscript() {
    this.#committed = [];
    this.#pendingInterim = '';
    this.#latestText = this.#baseText;
  }

  /**
   * Connect (or reconnect) the WebSocket to the ASR streaming proxy.
   * On non-intentional close while mic is active, auto-reconnect after 800ms.
   */
  #connectWs(url) {
    this.#resetAsrTranscript();
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;

    ws.onopen = () => {
      if (this.#ws !== ws) return;
      this.#lastInboundTs = Date.now();
      // Flush any buffered PCM from reconnect dead zone
      if (this.#reconnectBuffer.length) {
        for (const chunk of this.#reconnectBuffer) {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk.buffer);
        }
        this.#reconnectBuffer = [];
      }
    };

    ws.onmessage = (ev) => {
      if (this.#ws !== ws) return;
      if (typeof ev.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.#handleAsrMessage(msg);
    };

    ws.onerror = () => {
      if (this.#ws === ws && this.#onError) {
        this.#onError(new Error('语音连接错误'));
      }
    };

    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      if (!this.#intentionalClose && this.#micActive && !this.#reconnecting) {
        // Auto-reconnect: preserve recognized text, buffer audio during gap
        void this.#reconnectAfterGlitch('ws closed');
      }
    };
  }

  /** Wait for the server to send {"type":"ready"} */
  #waitForReady() {
    return new Promise((resolve, reject) => {
      const ws = this.#ws;
      if (!ws) return reject(new Error('语音连接失败'));
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('语音连接超时'));
      }, 12000);
      const origOnMessage = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.onmessage = origOnMessage;
          resolve(undefined);
          return;
        }
        if (msg.type === 'error') {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(String(msg.message || '语音识别失败')));
          }
          return;
        }
        // Handle transcript messages even during wait (server might send early)
        if (origOnMessage) {
          this.#handleAsrMessage(msg);
        }
      };
    });
  }

  /**
   * Install audio capture node. Prefers AudioWorklet (separate audio thread,
   * no frame drops); falls back to ScriptProcessor if Worklet unavailable.
   */
  async #setupCapture(srcNode, audioCtx) {
    if (audioCtx.audioWorklet) {
      try {
        if (!this.#pcmWorkletUrl) {
          const blob = new Blob([PCM_WORKLET_SRC], { type: 'application/javascript' });
          this.#pcmWorkletUrl = URL.createObjectURL(blob);
        }
        await audioCtx.audioWorklet.addModule(this.#pcmWorkletUrl);
        const node = new AudioWorkletNode(audioCtx, 'pcm-capture', {
          numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
          processorOptions: { chunk: PCM_CHUNK_SAMPLES },
        });
        node.port.onmessage = (ev) => { this.#handlePcmChunk(new Int16Array(ev.data)); };
        srcNode.connect(node);
        // Keep worklet alive without playing mic to speakers (avoids feedback + false loudness).
        const mute = audioCtx.createGain();
        mute.gain.value = 0;
        node.connect(mute);
        mute.connect(audioCtx.destination);
        this.#workletNode = node;
        console.log('[voice] capture=worklet sr=' + audioCtx.sampleRate);
        return;
      } catch (e) {
        console.warn('[voice] worklet failed, fallback to scriptprocessor', e?.message);
      }
    }
    // Fallback: ScriptProcessorNode (deprecated, main-thread, may drop frames)
    this.#processor = audioCtx.createScriptProcessor(PCM_CHUNK_SAMPLES, 1, 1);
    srcNode.connect(this.#processor);
    this.#processor.connect(audioCtx.destination);
    this.#processor.onaudioprocess = (e) => {
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768));
      }
      this.#handlePcmChunk(i16);
    };
    console.log('[voice] capture=scriptprocessor sr=' + audioCtx.sampleRate);
  }

  /**
   * Unified PCM chunk handler: send immediately if WS open, buffer if reconnecting.
   * No 200ms timer — chunks go out as soon as they arrive.
   */
  #handlePcmChunk(i16) {
    // TTS 挂起期间：写入打断预缓冲而非发送
    if (this.#bargeinBuffering) {
      this.#bargeinBuffer.push(i16);
      if (this.#bargeinBuffer.length > BARGEIN_MAX_CHUNKS) this.#bargeinBuffer.shift();
      return;
    }
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      // WS reconnect dead zone: buffer audio, send after reconnect
      this.#reconnectBuffer.push(i16);
      if (this.#reconnectBuffer.length > RECONNECT_MAX_CHUNKS) this.#reconnectBuffer.shift();
      return;
    }
    this.#ws.send(i16.buffer);
  }

  /**
   * Process an ASR message from the server.
   * Uses seg-based dedup: same seg → replace (not append), matching the legacy voice module.
   */
  /**
   * Suppress incoming transcripts for `ms` milliseconds.
   * Used by PTT after release to swallow cloud-side flush tail transcripts.
   */
  suppressTranscripts(ms) {
    this.#transcriptSuppressUntil = Date.now() + ms;
  }

  #handleAsrMessage(msg) {
    if (!this.#micActive && !this.#resolveFinal) return;
    if (msg.type === 'transcript') {
      // PTT tail suppression: discard transcripts during the swallow window
      if (Date.now() < this.#transcriptSuppressUntil) return;
      const text = String(msg.text || '').trim();
      if (!text) return;
      this.#lastInboundTs = Date.now();
      const seg = (msg.seg === undefined || msg.seg === null) ? null : msg.seg;
      const isFinal = !!msg.is_final;

      if (isFinal) {
        // Dedup by seg: find existing entry with same seg, replace text
        let idx = -1;
        if (seg !== null) {
          idx = this.#committed.findIndex(s => s.seg === seg);
        } else {
          const last = this.#committed[this.#committed.length - 1];
          if (last && last.text === text) idx = this.#committed.length - 1;
        }
        if (idx >= 0) {
          this.#committed[idx].text = text;
        } else {
          this.#committed.push({ seg, text });
        }
        this.#pendingInterim = '';
      } else {
        // interim: only for display, not committed
        this.#pendingInterim = text;
      }

      // Build display text: committed sentences + current interim
      const committedText = this.#committed.map(s => s.text).join('');
      this.#latestText = this.#pendingInterim
        ? (committedText ? committedText + this.#pendingInterim : this.#pendingInterim)
        : committedText;

      if (this.#baseText) {
        this.#latestText = this.#baseText + ' ' + this.#latestText;
      }

      this.#onPartial?.(this.#latestText);
      if (isFinal) this.#onFinal?.(this.#latestText);
      this.#resolveFinal?.(this.#latestText);
    } else if (msg.type === 'final') {
      // Server signals end of session
      const text = String(msg.text || '').trim();
      if (text) {
        this.#latestText = this.#baseText ? this.#baseText + ' ' + text : text;
      }
      this.#onFinal?.(this.#latestText);
      this.#resolveFinal?.(this.#latestText);
    } else if (msg.type === 'error') {
      const errMsg = String(msg.message || '语音识别失败');
      if (this.#micActive && !this.#intentionalClose && this.#isRecoverableAsrError(errMsg)) {
        void this.#reconnectAfterGlitch(errMsg);
        return;
      }
      this.#onError?.(new Error(errMsg));
    }
  }

  /**
   * Watchdog: if user is still talking (vol > threshold) but no transcript
   * received for STALL_RECONNECT_MS, force reconnect to restart recognition.
   */
  #startWatchdog() {
    this.#lastInboundTs = Date.now();
    this.#lastLoudTs = 0;
    this.#watchdogStartedAt = Date.now();
    this.#watchdogTimer = setInterval(() => {
      if (!this.#micActive || !this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
      if (this.#reconnecting) return;
      const now = Date.now();
      // Warmup: Volcengine often needs several seconds before first transcript.
      if (now - this.#watchdogStartedAt < WATCHDOG_WARMUP_MS) return;
      // Check if user is still producing sound via analyser
      if (this.#analyser) {
        const bins = new Uint8Array(this.#analyser.frequencyBinCount);
        this.#analyser.getByteFrequencyData(bins);
        const sum = bins.reduce((a, b) => a + b, 0);
        const vol = (sum / bins.length) / 255;
        if (vol > WATCHDOG_SPEECH_VOL) this.#lastLoudTs = now;
      }
      if (this.#lastLoudTs && now - this.#lastLoudTs < 1200 && now - this.#lastInboundTs > STALL_RECONNECT_MS) {
        console.warn('[voice] watchdog: stalled recognition, force reconnect');
        this.#lastInboundTs = now;
        this.#watchdogStartedAt = now; // re-warm after reconnect
        void this.#reconnectAfterGlitch('watchdog stall');
      }
    }, 1000);
  }

  /** @returns {Promise<string>} */
  async stop() {
    if (this.#suspendedByTTS) {
      // 处于 TTS 挂起状态：先清理挂起状态再停止，确保干净退出
      this.#suspendedByTTS = false;
      this.#bargeinBuffering = false;
      this.#bargeinBuffer = [];
    }
    if (!this.recording) return String(this.#latestText || '').trim();
    this.#micActive = false;
    this.#intentionalClose = true;
    this.#onPartial = null;
    this.#onFinal = null;

    // Flush: tell server to give final result
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      try { this.#ws.send(JSON.stringify({ type: 'stop' })); } catch {}
    }

    this.#finalPromise = new Promise((resolve) => {
      this.#resolveFinal = resolve;
      setTimeout(() => resolve(this.#latestText), 1500);
    });

    try {
      await this.#finalPromise;
    } catch {}

    this.#teardown();
    return String(this.#latestText || '').trim();
  }

  cancel() {
    this.#micActive = false;
    this.#intentionalClose = true;
    this.#onPartial = null;
    this.#onFinal = null;
    this.#teardown();
  }

  /**
   * TTS 挂起：只断 ASR WS，保持 mic 硬件 + 采集节点。
   * 开启 1.5s 打断预缓冲：TTS 期间 PCM 写环形缓冲，打断后回放补开头几个字。
   * @returns {boolean} 是否成功挂起（mic 未开则返回 false）
   */
  suspendForTTS() {
    if (!this.#micActive) return false;
    this.#suspendedByTTS = true;
    this.#userWantedMic = true;
    this.#bargeinBuffer = [];
    this.#bargeinBuffering = true;
    // 只断 WS，保留 mic + worklet/processor + analyser
    this.#intentionalClose = true; // 防止 onclose 触发重连
    if (this.#ws) {
      try {
        if (this.#ws.readyState === WebSocket.OPEN) {
          this.#ws.send(JSON.stringify({ type: 'flush' }));
        }
        this.#ws.close();
      } catch { /* ignore */ }
      this.#ws = null;
    }
    return true;
  }

  /**
   * 从 TTS 挂起恢复：重连 ASR WS + flush 打断预缓冲。
   * @param {boolean} fromBargein 是否由 barge-in 打断触发
   * @returns {Promise<boolean>} 是否成功恢复
   */
  async resumeFromTTS(fromBargein = false) {
    if (!this.#suspendedByTTS || !this.#userWantedMic) return false;
    this.#suspendedByTTS = false;

    // 拿走缓冲区快照并停止缓冲
    const bufferedChunks = this.#bargeinBuffer.slice();
    this.#bargeinBuffer = [];
    this.#bargeinBuffering = false;

    // 重置转录累积（打断后重新开始识别）
    this.#resetAsrTranscript();

    if (this.#micActive && this.#stream && (this.#workletNode || this.#processor)) {
      // 采集节点仍存活 → 只需重连 WS
      const url = this.#lastWsUrl;
      if (!url) return false;
      this.#intentionalClose = false;
      // 把打断预缓冲放入 reconnectBuffer，让 onopen 统一 flush
      if (bufferedChunks.length) {
        for (const chunk of bufferedChunks) {
          this.#reconnectBuffer.push(chunk);
          if (this.#reconnectBuffer.length > RECONNECT_MAX_CHUNKS) {
            this.#reconnectBuffer.shift();
          }
        }
      }
      this.#connectWs(url);
      try {
        await this.#waitForReady();
      } catch (e) {
        console.warn('[voice] resume waitForReady failed', e);
        try { this.#ws?.close(); } catch { /* ignore */ }
        return false;
      }
      this.#lastInboundTs = Date.now();
      return true;
    } else {
      // 采集节点已销毁 → 完整重启
      try {
        this.#stream = await requestMicrophoneStream();
        const { speechAsrStreamUrl } = await import('./speech-client.js');
        const url = await speechAsrStreamUrl();
        this.#lastWsUrl = url;
        this.#intentionalClose = false;
        this.#connectWs(url);
        await this.#waitForReady();
        this.#audioCtx = new AudioContext({ sampleRate: 16000 });
        const source = this.#audioCtx.createMediaStreamSource(this.#stream);
        this.#analyser = this.#audioCtx.createAnalyser();
        this.#analyser.fftSize = 128;
        this.#analyser.smoothingTimeConstant = 0.72;
        source.connect(this.#analyser);
        await this.#setupCapture(source, this.#audioCtx);
        // flush 打断缓冲
        if (bufferedChunks.length && this.#ws?.readyState === WebSocket.OPEN) {
          for (const chunk of bufferedChunks) {
            if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(chunk.buffer);
          }
        }
        this.#startWatchdog();
        return true;
      } catch (e) {
        this.#teardown();
        return false;
      }
    }
  }

  /** 是否处于 TTS 挂起状态 */
  get suspendedByTTS() {
    return this.#suspendedByTTS;
  }

  #teardown() {
    clearInterval(this.#levelTimer);
    this.#levelTimer = null;
    clearInterval(this.#watchdogTimer);
    this.#watchdogTimer = null;
    this.#intentionalClose = true;

    try { this.#workletNode?.disconnect(); } catch {}
    this.#workletNode = null;
    try { this.#processor?.disconnect(); } catch {}
    this.#processor = null;
    try { this.#analyser?.disconnect(); } catch {}
    this.#analyser = null;
    try { this.#sink?.disconnect(); } catch {}
    this.#sink = null;

    for (const track of this.#stream?.getTracks() || []) track.stop();
    this.#stream = null;

    if (this.#audioCtx) {
      void this.#audioCtx.close().catch(() => {});
      this.#audioCtx = null;
    }
    if (this.#ws) {
      try { this.#ws.close(); } catch {}
      this.#ws = null;
    }
    this.#reconnectBuffer = [];
    this.#bargeinBuffer = [];
    this.#bargeinBuffering = false;
    this.#suspendedByTTS = false;
    this.#committed = [];
    this.#pendingInterim = '';
    this.#transcriptSuppressUntil = 0;
    this.#resolveFinal = null;
    this.#finalPromise = null;
  }
}

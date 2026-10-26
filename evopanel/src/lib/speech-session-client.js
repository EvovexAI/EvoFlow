/**
 * 语音会话 WS 客户端（P1 首片：流式 TTS 通道）。
 *
 * 后端 `/api/speech/session`：客户端发 `{"type":"speak","seq",text}`，
 * 网关进程内火山流式合成并推 mp3 分片回来（tts_start → binary… → tts_end）。
 * 本客户端把分片按 seq 顺序喂进 MediaSource 边收边播（首句快 ~150-300ms），
 * 任一环节失败（未连接/MSE 不可用/超时无首包）→ 返回 null，调用方逐句回退 HTTP。
 * 音频上行（PCM→VAD/ASR）与 agent 内化为后续增量（协议已留位）。
 */

/** @type {WebSocket | null} */
let _ws = null
/** @type {Promise<WebSocket | null> | null} */
let _connecting = null
let _seq = 0
let _defaultSpeaker = ''
/** @type {Map<number, {onChunk:(b:ArrayBuffer)=>void, onEnd:(cancelled:boolean)=>void, onError:()=>void}>} */
const _pending = new Map()

export function isSpeechSessionTtsActive() {
  return !!(_ws && _ws.readyState === WebSocket.OPEN)
}

export function setSpeechSessionSpeaker(speaker) {
  _defaultSpeaker = String(speaker || '').trim()
  if (isSpeechSessionTtsActive()) {
    try {
      _ws.send(JSON.stringify({ type: 'start', speaker: _defaultSpeaker }))
    } catch {
      /* ignore */
    }
  }
}

async function _sessionWsUrl() {
  const { speechAsrStreamUrl } = await import('./speech-client.js')
  const asr = await speechAsrStreamUrl()
  return asr.replace(/\/asr\/stream$/, '/session')
}

async function _connect() {
  if (isSpeechSessionTtsActive()) return _ws
  if (_connecting) return _connecting
  _connecting = (async () => {
    try {
      const url = await _sessionWsUrl()
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('session ws timeout')), 1500)
        ws.onopen = () => {
          clearTimeout(timer)
          resolve()
        }
        ws.onerror = () => {
          clearTimeout(timer)
          reject(new Error('session ws error'))
        }
      })
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          let m
          try {
            m = JSON.parse(ev.data)
          } catch {
            return
          }
          const seq = Number(m?.seq) || 0
          if (m.type === 'tts_start') return
          const p = _pending.get(seq)
          if (!p) return
          if (m.type === 'tts_end') {
            _pending.delete(seq)
            p.onEnd(!!m.cancelled)
          } else if (m.type === 'tts_error' || m.type === 'tts_drop') {
            _pending.delete(seq)
            p.onError()
          }
          return
        }
        // 二进制音频帧：前 4 字节小端 seq（并句预取时分片可能交错）
        if (!(ev.data instanceof ArrayBuffer) || ev.data.byteLength <= 4) return
        const seq = new DataView(ev.data).getUint32(0, true)
        const p = _pending.get(seq)
        if (p) p.onChunk(ev.data.slice(4))
      }
      ws.onclose = () => {
        if (_ws === ws) _ws = null
        for (const [, p] of _pending) p.onError()
        _pending.clear()
      }
      ws.onerror = () => {
        /* onclose 会跟着来 */
      }
      _ws = ws
      if (_defaultSpeaker) {
        ws.send(JSON.stringify({ type: 'start', speaker: _defaultSpeaker }))
      }
      return ws
    } catch {
      _ws = null
      return null
    } finally {
      _connecting = null
    }
  })()
  return _connecting
}

/** @type {number} */
let _lastSessionBargeAt = 0

/**
 * 打断：取消后端所有进行中的合成（barge-in / 停止播报时尽力通知）。
 * @param {{ reason?: string }} [opts]
 */
export function notifySpeechSessionBargeIn(opts = {}) {
  if (!isSpeechSessionTtsActive()) return
  const now = Date.now()
  if (now - _lastSessionBargeAt < 200) return
  _lastSessionBargeAt = now
  const reason = String(opts.reason || 'client_barge_in')
  try {
    _ws.send(JSON.stringify({ type: 'barge_in', reason }))
  } catch {
    /* ignore */
  }
}

function _closeMediaSource(ms, sb) {
  try {
    if (sb && sb.buffered.length && ms.readyState === 'open') ms.endOfStream()
  } catch {
    /* ignore */
  }
}

/**
 * 流式合成一句话。返回与既有 _fetchSentenceAudio 相同的 {objectUrl, audio}；
 * 失败返回 null（调用方回退 HTTP /tts）。
 * @param {string} text
 * @param {{ speaker?: string }} [opts]
 * @returns {Promise<{ objectUrl: string, audio: HTMLAudioElement } | null>}
 */
export async function fetchSpeechSessionAudio(text, opts = {}) {
  const plain = String(text || '').trim()
  if (!plain) return null
  const MS = window.MediaSource
  if (!MS || !MS.isTypeSupported('audio/mpeg')) return null

  const ws = await _connect()
  if (!ws) return null

  const seq = ++_seq
  const speaker = String(opts.speaker || _defaultSpeaker || '').trim()
  const ms = new MS()
  const objectUrl = URL.createObjectURL(ms)

  /** @type {{buf: SourceBuffer|null, pending: ArrayBuffer[], done: boolean, firstChunkAt: number}} */
  const state = { buf: null, pending: [], done: false, firstChunkAt: 0 }

  return new Promise((resolve) => {
    let settled = false
    const audio = new Audio(objectUrl)
    let firstChunkTimer = 0

    const finish = (pack) => {
      if (settled) return
      settled = true
      clearTimeout(firstChunkTimer)
      if (pack) {
        // 成功：等播完/废弃时收尾 MSE
        audio.addEventListener('ended', () => _closeMediaSource(ms, state.buf), { once: true })
        resolve(pack)
        return
      }
      // 失败：让调用方回退 HTTP；只取消这一句，不误伤其他进行中的句子
      _pending.delete(seq)
      try {
        ws.send(JSON.stringify({ type: 'cancel', seq }))
      } catch {
        /* ignore */
      }
      try {
        audio.src = ''
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(objectUrl)
      resolve(null)
    }

    // 首包超时：连接建立但 2.5s 内没有任何音频分片 → 回退
    firstChunkTimer = setTimeout(() => {
      if (!state.firstChunkAt) finish(null)
    }, 2500)

    _pending.set(seq, {
      onChunk: (b) => {
        if (!state.firstChunkAt) state.firstChunkAt = Date.now()
        if (state.buf && !state.buf.updating) {
          try {
            state.buf.appendBuffer(b)
          } catch {
            state.pending.push(b)
          }
        } else {
          state.pending.push(b)
        }
        // 首包一到即交付：队列侧 audio.play() 可以边播边收
        if (!settled && state.firstChunkAt) {
          finish({ objectUrl, audio })
        }
      },
      onEnd: () => {
        state.done = true
        const flushTail = () => {
          if (state.buf && !state.buf.updating && state.pending.length) {
            try {
              state.buf.appendBuffer(state.pending.shift())
              state.buf.addEventListener('updateend', flushTail, { once: true })
            } catch {
              /* ignore */
            }
          } else if (state.buf && !state.buf.updating && ms.readyState === 'open') {
            _closeMediaSource(ms, state.buf)
          }
        }
        flushTail()
        // 极短句可能在 finish 之前就结束：保证交付
        if (!settled && state.firstChunkAt) finish({ objectUrl, audio })
        else if (!settled) {
          // 没有任何分片就结束（空合成）→ 回退
          finish(null)
        }
      },
      onError: () => {
        if (!settled) finish(null)
      },
    })

    ms.addEventListener('sourceopen', () => {
      try {
        const sb = ms.addSourceBuffer('audio/mpeg')
        state.buf = sb
        sb.addEventListener('updateend', () => {
          while (!sb.updating && state.pending.length) {
            try {
              sb.appendBuffer(state.pending.shift())
              return
            } catch {
              break
            }
          }
          if (state.done && !sb.updating && !state.pending.length) {
            _closeMediaSource(ms, sb)
          }
        })
      } catch {
        finish(null)
        return
      }
      try {
        ws.send(JSON.stringify({ type: 'speak', seq, text: plain, ...(speaker ? { speaker } : {}) }))
      } catch {
        finish(null)
      }
    })

    ms.addEventListener('error', () => {
      if (!settled) finish(null)
    })
    // sourceopen 不来（极端）也兜底回退
    setTimeout(() => {
      if (!settled && !state.buf) finish(null)
    }, 1200)
  })
}

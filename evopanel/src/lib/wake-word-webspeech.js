/**
 * Wake-word fallback via Web Speech API (no sherpa-onnx WASM).
 *
 * Used when `public/kws/sherpa-onnx-wasm-kws-main.{js,wasm}` is missing
 * (common when HuggingFace is unreachable). Dispatches the same
 * `wake-word-hit` event as the local KWS ear.
 */

const WAKE_WORD_LABEL = '小V小V'
const COOLDOWN_MS = 2500
/** 无 ASR 结果多久打一条「聋耳」心跳（排查麦被占 / Chrome 不吐字） */
const DEAF_HEARTBEAT_MS = 12000
/** ASR 听写落盘节流（同文案） */
const HEAR_LOG_MIN_MS = 700

/** Phrases that open continuous voice (normalized, no punctuation). */
const WAKE_PHRASES = [
  '小V小V',
  '小v小v',
  '小维小维', // spoken “V” ≈ 维
  '小微小微',
  '小薇小薇', // 口语常写成「小薇」
  '小委小委',
  '小威小威',
  '嘿小V',
  '嗨小V',
  '你好小V',
  '你好小v',
  // Chrome ASR often hears 「小V」 as 蜜/米 — still treat as wake (product name is 小V)
  '小蜜小蜜',
  '小米小米',
]

/** 单喊一次也算唤醒（用户常只说「小薇」；成对短语仍优先） */
const WAKE_PHRASES_ONCE = new Set([
  '小v',
  '小薇',
  '小维',
  '小微',
  '小委',
  '小威',
  '小蜜',
  '小飞', // 偶发谐音
  // 不加「小米」：太容易误触
])

/** @type {SpeechRecognition | null} */
let recognition = null
let running = false
let lastHitTime = 0
/** @type {'webspeech' | null} */
let backend = null
/** 最近一次 onresult 时间（聋耳心跳） */
let lastResultAt = 0
/** @type {ReturnType<typeof setInterval> | null} */
let deafTimer = null
let lastHearLogAt = 0
let lastHearLogText = ''
let lastRestartLogAt = 0
let restartCount = 0
let lastBenignErrorLogAt = 0

function getSpeechRecognitionCtor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

export function isWebSpeechWakeAvailable() {
  return !!getSpeechRecognitionCtor()
}

/** @type {((stage: string, message: string) => void) | null} */
let _voiceFeLog = null

function feLog(stage, message) {
  if (_voiceFeLog) {
    try {
      _voiceFeLog(stage, message)
    } catch {
      /* ignore */
    }
    return
  }
  void import('./xiaomi-voice/voice-file-log.js')
    .then(({ voiceFeLog }) => {
      _voiceFeLog = voiceFeLog
      voiceFeLog(stage, message)
    })
    .catch(() => {})
}

function normalizeZh(text) {
  return String(text || '')
    .replace(/[\s\u3000，,。.！!？?、·\-_/\\'"`~]+/g, '')
    .toLowerCase()
}

function matchWakePhrase(text) {
  const n = normalizeZh(text)
  if (!n) return null
  for (const phrase of WAKE_PHRASES) {
    if (n.includes(normalizeZh(phrase))) return WAKE_WORD_LABEL
  }
  // 「小V」×2 with Latin/Chinese V variants, even if ASR inserts odd chars
  if (/小[vV维微薇委威蜜米飞]小[vV维微薇委威蜜米飞]/.test(n)) return WAKE_WORD_LABEL
  // 整句就是单次唤醒词（或末尾是）：「小薇」「嘿，小V」
  if (WAKE_PHRASES_ONCE.has(n)) return WAKE_WORD_LABEL
  for (const once of WAKE_PHRASES_ONCE) {
    if (n.endsWith(once) && n.length <= once.length + 4) return WAKE_WORD_LABEL
  }
  // 短句里出现一次「小V」变体也算唤醒（「小薇。」「嘿小薇」「叫一下小微」）
  // 长度上限避免闲聊长句误触；「查。」一类单字仍不命中
  if (n.length <= 10 && /小[vV维微薇委威蜜米飞]/.test(n)) return WAKE_WORD_LABEL
  // ASR 常把「小V小V」听成夹杂字：「小薇啊小薇」「那个小微小微」
  if (/小[vV维微薇委威蜜米飞].{0,3}小[vV维微薇委威蜜米飞]/.test(n) && n.length <= 16) {
    return WAKE_WORD_LABEL
  }
  return null
}

/** 看起来像在叫小V，但没命中规则 → 记「近失」方便扩词表 */
function looksWakeIsh(text) {
  const n = normalizeZh(text)
  if (!n) return false
  if (/小[vV维微薇委威蜜米]/.test(n)) return true
  if (n.includes('小v') || n.includes('小蜜') || n.includes('小米')) return true
  return false
}

function logHear(transcript, { isFinal, altIndex, matched }) {
  const raw = String(transcript || '').trim()
  if (!raw) return
  const now = Date.now()
  const key = `${isFinal ? 'F' : 'I'}:${raw}`
  if (key === lastHearLogText && now - lastHearLogAt < HEAR_LOG_MIN_MS) return
  // 中间结果：只记像唤醒的，避免闲聊刷屏
  if (!isFinal && !looksWakeIsh(raw) && !matched) return
  // 最终闲聊听写：常驻耳会把旁白/回声整段吐出；全量 console+IPC 会叠出主线程 longtask
  if (isFinal && !looksWakeIsh(raw) && !matched) {
    if (now - lastHearLogAt < 3000) return
  }
  lastHearLogText = key
  lastHearLogAt = now
  const kind = matched ? '命中候选' : looksWakeIsh(raw) ? '近失' : '听写'
  const finalTag = isFinal ? 'final' : 'interim'
  const alt = altIndex > 0 ? ` alt=${altIndex}` : ''
  // 命中/近失才打 console；纯闲聊 final 只写文件日志（且已节流）
  if (matched || looksWakeIsh(raw) || !isFinal) {
    console.log(`[wake-word-webspeech] ${kind}:`, raw, finalTag)
  }
  feLog(
    '唤醒',
    `ASR${kind} ${finalTag}${alt} 「${raw.slice(0, 60)}」${matched ? ' → 将触发' : '（未匹配词表）'}`,
  )
}

function clearDeafWatch() {
  if (deafTimer) {
    clearInterval(deafTimer)
    deafTimer = null
  }
}

function armDeafWatch() {
  clearDeafWatch()
  lastResultAt = Date.now()
  deafTimer = setInterval(() => {
    if (!running) {
      clearDeafWatch()
      return
    }
    const silentMs = Date.now() - lastResultAt
    if (silentMs < DEAF_HEARTBEAT_MS) return
    // 重置锚点，避免每秒刷；仍隔 DEAF_HEARTBEAT_MS 再报
    lastResultAt = Date.now()
    feLog(
      '唤醒',
      `聋耳心跳：已 ${Math.round(silentMs / 1000)}s 无 ASR 结果（耳仍开；可能麦被占/Chrome 未吐字/需再说一次）`,
    )
  }, Math.min(4000, DEAF_HEARTBEAT_MS))
}

function emitHit(keyword, asrRaw) {
  const now = Date.now()
  if (now - lastHitTime < COOLDOWN_MS) {
    const wait = COOLDOWN_MS - (now - lastHitTime)
    console.log('[wake-word-webspeech] HIT cooldown skip', wait, 'ms')
    feLog('唤醒', `命中被冷却吞掉 wait=${wait}ms asr=「${String(asrRaw || '').slice(0, 40)}」`)
    return
  }
  lastHitTime = now
  const label = WAKE_WORD_LABEL
  const asr = String(asrRaw || keyword || label)
  console.log('[wake-word-webspeech] HIT:', label, asr)
  feLog('会话', `唤醒命中 backend=webspeech asr=「${asr.slice(0, 40)}」→ 开麦`)
  window.dispatchEvent(
    new CustomEvent('wake-word-hit', {
      detail: { keyword: label, backend: 'webspeech', asr },
    }),
  )
}

/** 播报中 Frame 麦被 hold：唤醒耳仍能听见「停止/退出」，须接到本地口令闸 */
let lastExitCmdAt = 0
const EXIT_CMD_COOLDOWN_MS = 1800

/** Cached modules for播报期口令 — avoid 4× dynamic import on every ASR final. */
let _exitCmdModsPromise = null

function loadExitCmdMods() {
  if (!_exitCmdModsPromise) {
    _exitCmdModsPromise = Promise.all([
      import('./xw-voice-mode.js'),
      import('./xiaomi-voice/index.js'),
      import('./xiaomi-voice-close.js'),
      import('./voice-listen-control.js'),
    ]).catch((err) => {
      _exitCmdModsPromise = null
      throw err
    })
  }
  return _exitCmdModsPromise
}

/**
 * @param {string} transcript
 * @param {{ isFinal?: boolean }} [opts]
 */
function maybeHandleSpeakingExitCommand(transcript, opts = {}) {
  const raw = String(transcript || '').trim()
  if (!raw) return false
  // Cheap sync gate：非小V语音全屏时旁白听写极多，勿对每句 final 拉模块/判口令
  try {
    if (document.documentElement.dataset.xwVoice !== '1') return false
  } catch {
    return false
  }
  // 非 final 且很长：多半是 TTS 回声粘连，等 final / 短尾巴再判，降假阳
  if (!opts.isFinal && raw.length > 24) return false
  const now = Date.now()
  if (now - lastExitCmdAt < EXIT_CMD_COOLDOWN_MS) return false

  void loadExitCmdMods()
    .then(([xw, frame, closeMod, listenMod]) => {
      if (!xw.isXwVoiceMode?.()) return
      const speaking =
        frame.isXiaomiFramePlaying?.() ||
        frame.isXiaomiFrameSoftPaused?.() ||
        frame.getVoicePhase?.() === 'speaking'
      if (!speaking && !frame.isXiaomiFramePipelineActive?.()) return

      // 播报中：短句精确口令；长句只认尾巴/嵌套退出口令（与 close 闸一致）
      const isExit = closeMod.isXiaomiVoiceExitCommand?.(raw)
      const isStopTts = listenMod.isStopTtsOnlyCommand?.(raw)
      if (!isExit && !isStopTts) return
      // 未在播报且非软暂停：勿用唤醒耳误关（正常聆听交给 Frame turn_end）
      if (!speaking) return

      lastExitCmdAt = Date.now()
      feLog(
        '打断',
        `唤醒耳播报期命中口令 →「${raw.slice(0, 40)}」isFinal=${!!opts.isFinal}`,
      )
      return closeMod.tryHandleXiaomiVoiceLocalCommand?.(raw, {
        source: 'wake-webspeech-during-speak',
      })
    })
    .catch(() => {})
  return true
}

/**
 * @returns {Promise<boolean>}
 */
export async function startWebSpeechEar() {
  if (running) return true
  const Ctor = getSpeechRecognitionCtor()
  if (!Ctor) {
    console.warn('[wake-word-webspeech] SpeechRecognition unavailable')
    feLog('唤醒', '启动失败：本环境无 SpeechRecognition')
    return false
  }

  try {
    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 3

    rec.onresult = (event) => {
      if (!running) return
      lastResultAt = Date.now()
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (!result) continue
        const isFinal = !!result.isFinal
        for (let j = 0; j < result.length; j++) {
          const transcript = result[j]?.transcript || ''
          const hit = matchWakePhrase(transcript)
          logHear(transcript, { isFinal, altIndex: j, matched: !!hit })
          if (hit) {
            emitHit(hit, transcript)
            return
          }
          // 播报中用户说「停止/退出」：Frame 上行 hold，靠唤醒耳接口令
          maybeHandleSpeakingExitCommand(transcript, { isFinal })
        }
      }
    }

    rec.onerror = (ev) => {
      const err = String(ev?.error || '')
      // `no-speech` / `aborted` are normal; throttle file log（否则静音时段会刷爆）。
      if (err === 'no-speech' || err === 'aborted') {
        console.debug('[wake-word-webspeech] onerror:', err)
        const now = Date.now()
        if (now - lastBenignErrorLogAt > 15000) {
          lastBenignErrorLogAt = now
          feLog('唤醒', `ASR onerror=${err}（常见，会自动续听；已节流）`)
        }
      } else if (err === 'not-allowed' || err === 'service-not-allowed') {
        console.warn('[wake-word-webspeech] mic/permission denied:', err)
        feLog('唤醒', `麦克风/权限拒绝 onerror=${err} → 停耳`)
        stopWebSpeechEar()
      } else {
        console.warn('[wake-word-webspeech] onerror:', err)
        feLog('唤醒', `ASR onerror=${err || '?'}`)
      }
    }

    rec.onend = () => {
      if (!running) return
      restartCount += 1
      const now = Date.now()
      // Chrome stops after silence — restart the ear.
      if (now - lastRestartLogAt > 8000) {
        lastRestartLogAt = now
        feLog('唤醒', `ASR onend → 自动续听（累计 restart=${restartCount}）`)
      }
      try {
        rec.start()
      } catch {
        setTimeout(() => {
          if (!running) return
          try {
            rec.start()
          } catch (e) {
            feLog(
              '唤醒',
              `续听失败：${e instanceof Error ? e.message : String(e)}`,
            )
          }
        }, 400)
      }
    }

    recognition = rec
    running = true
    backend = 'webspeech'
    restartCount = 0
    lastRestartLogAt = 0
    lastHearLogAt = 0
    lastHearLogText = ''
    rec.start()
    armDeafWatch()
    console.log('[wake-word-webspeech] Ear listening for', WAKE_WORD_LABEL)
    void import('./xiaomi-voice/voice-file-log.js')
      .then(({ voiceFeMirror }) =>
        voiceFeMirror(
          '会话',
          '唤醒耳已开启，聆听',
          `${WAKE_WORD_LABEL} backend=webspeech（会记 ASR 听写/近失/聋耳）`,
        ),
      )
      .catch(() => {})
    return true
  } catch (e) {
    console.warn(
      '[wake-word-webspeech] Failed to start:',
      e instanceof Error ? e.message : String(e),
    )
    void import('./xiaomi-voice/voice-file-log.js')
      .then(({ voiceFeMirror }) =>
        voiceFeMirror(
          '会话',
          '唤醒耳启动失败',
          e instanceof Error ? e.message : String(e),
        ),
      )
      .catch(() => {})
    stopWebSpeechEar()
    return false
  }
}

export function stopWebSpeechEar() {
  running = false
  backend = null
  clearDeafWatch()
  const rec = recognition
  recognition = null
  if (!rec) return
  try {
    rec.onend = null
    rec.onresult = null
    rec.onerror = null
    rec.stop()
  } catch {
    try {
      rec.abort()
    } catch {
      /* ignore */
    }
  }
  feLog('唤醒', '唤醒耳已关闭 backend=webspeech')
}

export function isWebSpeechEarRunning() {
  return running
}

export function webSpeechWakeBackend() {
  return backend
}

/**
 * One-shot command listen after wake (stay on Web Speech — avoid Volcengine
 * streaming handoff which stalls when mic was just held by SpeechRecognition).
 *
 * @param {{
 *   timeoutMs?: number
 *   onPartial?: (text: string) => void
 * }} [opts]
 * @returns {Promise<string>}
 */
/** @type {(() => void) | null} */
let abortActiveCommandListen = null

/** Stop an in-flight listenOnceForCommand (e.g. user pressed Alt+X / mic). */
export function abortListenOnceForCommand() {
  try {
    abortActiveCommandListen?.()
  } catch {
    /* ignore */
  }
  abortActiveCommandListen = null
}

export function listenOnceForCommand(opts = {}) {
  abortListenOnceForCommand()
  const timeoutMs = Math.max(4000, Number(opts.timeoutMs) || 12000)
  const onPartial = typeof opts.onPartial === 'function' ? opts.onPartial : null
  const Ctor = getSpeechRecognitionCtor()
  if (!Ctor) return Promise.reject(new Error('SpeechRecognition unavailable'))

  return new Promise((resolve, reject) => {
    /** @type {SpeechRecognition} */
    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    let settled = false
    let best = ''
    let silenceTimer = null
    const startedAt = Date.now()

    const finish = (text) => {
      if (settled) return
      settled = true
      if (abortActiveCommandListen === abortFn) abortActiveCommandListen = null
      clearTimeout(hardTimer)
      if (silenceTimer) clearTimeout(silenceTimer)
      try {
        rec.onend = null
        rec.onresult = null
        rec.onerror = null
        rec.stop()
      } catch {
        try {
          rec.abort()
        } catch {
          /* ignore */
        }
      }
      resolve(stripWakePrefix(String(text || '').trim()))
    }

    const abortFn = () => finish(best)
    abortActiveCommandListen = abortFn

    const hardTimer = setTimeout(() => finish(best), timeoutMs)

    const scheduleSilenceCommit = () => {
      if (silenceTimer) clearTimeout(silenceTimer)
      // Commit shortly after speech pauses (Web Speech often ends the session itself).
      silenceTimer = setTimeout(() => {
        if (best.trim()) finish(best)
      }, 900)
    }

    rec.onresult = (event) => {
      let chunk = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const t = String(result?.[0]?.transcript || '').trim()
        if (!t) continue
        if (result.isFinal) {
          best = joinTranscript(best, t)
          chunk = best
          scheduleSilenceCommit()
        } else {
          chunk = joinTranscript(best, t)
        }
      }
      if (chunk) onPartial?.(stripWakePrefix(chunk))
      // If we already have a solid non-wake command, don't wait forever.
      const cleaned = stripWakePrefix(best)
      if (cleaned.length >= 2 && Date.now() - startedAt > 1200) {
        scheduleSilenceCommit()
      }
    }

    rec.onerror = (ev) => {
      const err = String(ev?.error || '')
      if (err === 'no-speech' || err === 'aborted') {
        finish(best)
        return
      }
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        if (!settled) {
          settled = true
          if (abortActiveCommandListen === abortFn) abortActiveCommandListen = null
          clearTimeout(hardTimer)
          reject(new Error('麦克风权限被拒绝'))
        }
        return
      }
      // Other errors: still return whatever we have.
      finish(best)
    }

    rec.onend = () => {
      // Chrome ends after a pause — treat as end of utterance.
      finish(best)
    }

    try {
      rec.start()
    } catch (e) {
      clearTimeout(hardTimer)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

function joinTranscript(prev, next) {
  const a = String(prev || '').trim()
  const b = String(next || '').trim()
  if (!a) return b
  if (!b) return a
  if (b.startsWith(a)) return b
  if (a.endsWith(b)) return a
  return `${a}${b}`
}

/** Remove leading wake phrase so we don't send "小V小V打开灯" as-is when redundant. */
function stripWakePrefix(text) {
  let s = String(text || '').trim()
  if (!s) return ''
  const n = normalizeZh(s)
  for (const phrase of WAKE_PHRASES) {
    const p = normalizeZh(phrase)
    if (n === p) return ''
    if (n.startsWith(p)) {
      // Best-effort: strip matching prefix chars from original (punctuation tolerant).
      let i = 0
      let matched = 0
      while (i < s.length && matched < phrase.length) {
        const ch = s[i]
        if (/[\s\u3000，,。.！!？?、·]/.test(ch)) {
          i += 1
          continue
        }
        if (ch === phrase[matched]) {
          matched += 1
          i += 1
          continue
        }
        break
      }
      if (matched >= phrase.length) {
        s = s.slice(i).replace(/^[\s，,。.！!？?、]+/, '')
      }
    }
  }
  return s.trim()
}

/**
 * Wake-word listening ack: short earcon + 「在呢」 so the user knows mic is open.
 * Prefer Volc TTS when configured; else browser speechSynthesis; earcon always plays.
 */

const WAKE_ACK_LINES = ['在呢', '我在', '嗯，请说']

function pickWakeAckLine() {
  return WAKE_ACK_LINES[Math.floor(Math.random() * WAKE_ACK_LINES.length)]
}

/** Soft two-tone chime (Genie-style), independent of TTS. */
export async function playWakeChime() {
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return
  const ctx = new AC()
  try {
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
    const now = ctx.currentTime
    const tones = [
      { f: 880, t: 0, dur: 0.09 },
      { f: 1174.7, t: 0.1, dur: 0.14 },
    ]
    for (const { f, t, dur } of tones) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = f
      gain.gain.setValueAtTime(0.0001, now + t)
      gain.gain.exponentialRampToValueAtTime(0.18, now + t + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t + dur)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + t)
      osc.stop(now + t + dur + 0.02)
    }
    await new Promise((r) => setTimeout(r, 280))
  } finally {
    void ctx.close().catch(() => {})
  }
}

function speakLocalWakeAck(text) {
  return new Promise((resolve) => {
    const Syn = window.speechSynthesis
    const Utter = window.SpeechSynthesisUtterance
    if (!Syn || !Utter) {
      resolve()
      return
    }
    try {
      Syn.cancel()
    } catch {
      /* ignore */
    }
    const u = new Utter(text)
    u.lang = 'zh-CN'
    u.rate = 1.08
    u.pitch = 1.05
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    u.onend = finish
    u.onerror = finish
    Syn.speak(u)
    setTimeout(finish, 2500)
  })
}

/**
 * Play wake feedback, then resolve when spoken ack (if any) has finished.
 * @returns {Promise<void>}
 */
export async function playWakeListeningAck() {
  const line = pickWakeAckLine()
  try {
    await playWakeChime()
  } catch (e) {
    console.warn('[wake-ack] chime failed:', e?.message || e)
  }

  try {
    const { fetchSpeechConfigured, playAssistantSpeech } = await import('./speech-client.js')
    const ok = await fetchSpeechConfigured().catch(() => false)
    if (ok) {
      await playAssistantSpeech(line)
      return
    }
  } catch (e) {
    console.warn('[wake-ack] TTS failed, trying local speech:', e?.message || e)
  }

  try {
    await speakLocalWakeAck(line)
  } catch {
    /* ignore — toast still covers visual feedback */
  }
}

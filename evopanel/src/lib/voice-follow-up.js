/**
 * After a voice send + AI TTS reply, auto-listen for follow-ups a while
 * (Alt+X / mic / wake share this). Silence → end session.
 */

/** Keep listening this long for a follow-up after TTS ends. */
export const VOICE_FOLLOW_UP_LISTEN_MS = 12000
/** Wait this long for the first TTS chunk (tools may delay speech). */
export const VOICE_WAIT_SPEECH_START_MS = 45000
/** Max follow-up turns per session. */
export const VOICE_MAX_FOLLOW_UPS = 8

let sessionGen = 0
let busy = false

export function isVoiceFollowUpActive() {
  return busy
}

/** Invalidate in-flight follow-up (e.g. user starts a new PTT / mic press). */
export function cancelVoiceFollowUp() {
  sessionGen += 1
  busy = false
  void import('./wake-word-webspeech.js')
    .then(({ abortListenOnceForCommand }) => abortListenOnceForCommand())
    .catch(() => {})
}

/**
 * @param {{
 *   isActive?: () => boolean
 *   onTrayState?: (state: string) => void
 * }} [opts]
 */
export async function waitForAssistantSpeechThenGap(opts = {}) {
  const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => true
  const onTrayState = opts.onTrayState

  const { isSpeechPlaybackBusy, waitForSpeechPlaybackIdle } = await import('./speech-client.js')
  onTrayState?.('speaking')

  // Let the short 「好的…」ack finish before waiting on the real AI reply.
  try {
    const { whenVoiceAckReady } = await import('./voice-reply-speech.js')
    await whenVoiceAckReady()
  } catch {
    /* ignore */
  }
  if (!isActive()) return

  const { getVoiceReplyEnabled } = await import('./panel-settings.js')
  if (!getVoiceReplyEnabled()) {
    await new Promise((r) => setTimeout(r, 900))
    return
  }

  const startedAt = Date.now()
  let sawSpeech = false

  while (Date.now() - startedAt < VOICE_WAIT_SPEECH_START_MS) {
    if (!isActive()) return
    if (isSpeechPlaybackBusy()) {
      sawSpeech = true
      break
    }
    await new Promise((r) => setTimeout(r, 150))
  }

  if (sawSpeech || isSpeechPlaybackBusy()) {
    for (let i = 0; i < 8; i++) {
      if (!isActive()) return
      const remain = Math.max(5000, 180000 - (Date.now() - startedAt))
      await waitForSpeechPlaybackIdle({ timeoutMs: remain })
      await new Promise((r) => setTimeout(r, 550))
      if (!isSpeechPlaybackBusy()) break
    }
  }

  await new Promise((r) => setTimeout(r, 450))
}

/**
 * After the first voice utterance was already sent: wait for TTS, listen, send, repeat.
 *
 * @param {{
 *   sendText: (text: string) => void | Promise<void>
 *   onTrayState?: (state: string) => void
 *   onPartial?: (text: string) => void
 *   isActive?: () => boolean
 *   maxRounds?: number
 *   listenTimeoutMs?: number
 *   pauseWake?: () => void | Promise<void>
 *   resumeWake?: () => void | Promise<void>
 *   manageWakeEar?: boolean
 * }} opts
 */
export async function runVoiceFollowUpRounds(opts) {
  if (busy) return
  busy = true
  const gen = ++sessionGen

  const sendText = opts.sendText
  const onTrayState = opts.onTrayState
  const onPartial = opts.onPartial
  const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => true
  const maxRounds = Math.max(1, Number(opts.maxRounds) || VOICE_MAX_FOLLOW_UPS)
  const listenTimeoutMs = Math.max(4000, Number(opts.listenTimeoutMs) || VOICE_FOLLOW_UP_LISTEN_MS)
  const manageWake = opts.manageWakeEar !== false

  const stillMine = () => gen === sessionGen && isActive()

  try {
    if (manageWake && opts.pauseWake) await opts.pauseWake()

    const { listenOnceForCommand } = await import('./wake-word-webspeech.js')

    for (let i = 0; i < maxRounds; i++) {
      if (!stillMine()) break

      await waitForAssistantSpeechThenGap({
        isActive: stillMine,
        onTrayState,
      })
      if (!stillMine()) break

      try {
        const { toast } = await import('../components/toast.js')
        toast('还可以继续说…', 'info')
      } catch {
        /* ignore */
      }

      onTrayState?.('recording')
      const text = await listenOnceForCommand({
        timeoutMs: listenTimeoutMs,
        onPartial: (partial) => {
          if (stillMine()) onPartial?.(partial)
        },
      })
      if (!stillMine()) break

      const cleaned = String(text || '').trim()
      onPartial?.('')
      if (!cleaned) {
        onTrayState?.('idle')
        break
      }

      // 「停止」等口令：结束追问轮，回到仅唤醒词。
      try {
        const { isStopListenCommand, isStopTtsOnlyCommand } = await import('./voice-listen-control.js')
        if (isStopListenCommand(cleaned)) {
          const { pauseConversationListening } = await import('./background-voice.js')
          await pauseConversationListening({ reason: 'voice' })
          break
        }
        if (isStopTtsOnlyCommand(cleaned)) {
          const { stopAssistantVoicePlayback } = await import('./background-voice.js')
          await stopAssistantVoicePlayback()
          continue
        }
      } catch {
        /* ignore */
      }

      // 用户开口时打断播报
      try {
        const { isSpeechPlaybackBusy, stopAllAssistantSpeech } = await import('./speech-client.js')
        if (isSpeechPlaybackBusy()) stopAllAssistantSpeech()
      } catch {
        /* ignore */
      }

      onTrayState?.('processing')
      await sendText(cleaned)
    }
  } catch (e) {
    console.warn('[voice-follow-up] failed:', e?.message || e)
  } finally {
    if (gen === sessionGen) {
      busy = false
      onPartial?.('')
      if (manageWake && opts.resumeWake) {
        await new Promise((r) => setTimeout(r, 350))
        try {
          await opts.resumeWake()
        } catch {
          /* ignore */
        }
      }
      onTrayState?.('idle')
    }
  }
}

/**
 * Fire-and-forget follow-up after a manual voice send (Alt+X / mic).
 * @param {{
 *   sendText: (text: string) => void | Promise<void>
 *   onTrayState?: (state: string) => void
 *   onPartial?: (text: string) => void
 *   isActive?: () => boolean
 * }} opts
 */
export function armVoiceFollowUpAfterSend(opts) {
  void (async () => {
    const { pauseWakeEarForVoiceSession, resumeWakeEarAfterVoiceSession } = await import(
      './background-voice.js'
    )
    await runVoiceFollowUpRounds({
      ...opts,
      manageWakeEar: true,
      pauseWake: () => pauseWakeEarForVoiceSession(),
      resumeWake: () => resumeWakeEarAfterVoiceSession(),
    })
  })().catch((e) => console.warn('[voice-follow-up] arm failed:', e?.message || e))
}

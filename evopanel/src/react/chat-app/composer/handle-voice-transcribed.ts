/**
 * Handle voice transcription → clear composer and send as voice-initiated message.
 * Extracted from ChatApp.tsx (P66).
 */
import { toast } from '../../../components/toast.js'
import { shouldArmVoiceReply } from '../../../lib/voice-reply-mode.js'

export type HandleVoiceTranscribedCtx = {
  voiceReplyEnabled: boolean
  pushComposerText: (text: string) => void
  setVoiceTrayState: (s: string) => unknown
  handleSend: (
    text: string,
    attachments?: undefined,
    ctxFiles?: undefined,
    opts?: { voiceInitiated?: boolean },
  ) => Promise<unknown> | unknown
}

export async function handleVoiceTranscribed(
  ctx: HandleVoiceTranscribedCtx,
  text: string,
  opts?: { global?: boolean },
): Promise<void> {
  const t = String(text || '').trim()
  if (!t) {
    toast('未识别到语音内容', 'warning')
    ctx.pushComposerText('')
    return
  }
  ctx.pushComposerText('')
  if (opts?.global) {
    /* 全局快捷键：确认语已在 background-voice 中启动 */
  } else if (shouldArmVoiceReply(ctx.voiceReplyEnabled)) {
    const { resetStreamingSpeechQueue } = await import('../../../lib/speech-client.js')
    resetStreamingSpeechQueue()
    const { startVoiceSimpleAck, resetVoiceToolMuteState } = await import(
      '../../../lib/voice-reply-speech.js'
    )
    resetVoiceToolMuteState()
    startVoiceSimpleAck((s) => ctx.setVoiceTrayState(s))
  }
  await ctx.handleSend(t, undefined, undefined, { voiceInitiated: true })
}

/**
 * Handle voice transcription → clear composer and send as voice-initiated message.
 * Extracted from ChatApp.tsx (P66).
 */
import { toast } from '../../../components/toast.js'
import { shouldArmVoiceReply } from '../../../lib/voice-reply-mode.js'

/** 与 lib/background-voice.js setVoiceTrayState 的入参联合类型保持一致 */
export type VoiceTrayState = 'idle' | 'recording' | 'processing' | 'running' | 'speaking'

export type HandleVoiceTranscribedCtx = {
  voiceReplyEnabled: boolean
  pushComposerText: (text: string) => void
  setVoiceTrayState: (s: VoiceTrayState) => void | Promise<void>
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
  // 小V/小微对话作用域：主对话 Composer 不接手（应走 sendXiaomiChat）
  try {
    const { isXiaomiVoiceCaptureScope } = await import('../../../lib/background-voice-bridge.js')
    if (isXiaomiVoiceCaptureScope()) {
      console.warn('[voice] handleVoiceTranscribed ignored — 小V 作用域，主对话不发')
      return
    }
  } catch {
    /* ignore */
  }
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

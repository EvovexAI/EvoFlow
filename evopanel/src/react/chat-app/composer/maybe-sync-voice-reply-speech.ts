/**
 * Stream voice-reply TTS sync while a voice-initiated turn is pending.
 * Extracted from ChatApp.tsx (P75).
 */
import { setVoiceTrayState } from '../../../lib/background-voice.js'
import { buildVoiceSpeechBodyForRuntime } from '../../lib/chat-stream-apply.js'
import { streamProject } from '../../lib/stream-state.js'
import type { SessionRuntime } from '../../lib/session-runtime-store.js'

export type MaybeSyncVoiceReplySpeechCtx = {
  voiceReplyPendingRef: { current: boolean }
  voiceSessionKeyRef: { current: string }
  voiceSpeechSyncedPlainRef: { current: string }
  voiceStreamingStartedRef: { current: boolean }
}

export function maybeSyncVoiceReplySpeech(
  ctx: MaybeSyncVoiceReplySpeechCtx,
  replySk: string,
  S: Parameters<typeof streamProject>[0],
  rt: SessionRuntime,
): void {
  if (!ctx.voiceReplyPendingRef.current) return
  const voiceSk = String(ctx.voiceSessionKeyRef.current || '').trim()
  const sk = String(replySk || '').trim()
  if (!voiceSk || sk !== voiceSk) return

  const tools = (S.turn?.tools || []) as unknown[]
  const proj = streamProject(S)
  const speechBody = buildVoiceSpeechBodyForRuntime(rt, {
    segments: proj.segments,
    text: proj.text,
  })

  void import('../../../lib/voice-reply-speech.js').then(
    ({
      shouldMuteVoiceSpeech,
      shouldAdvanceVoiceSpeechSync,
      enqueueVoiceStreamSpeech,
      enterVoiceToolMute,
      exitVoiceToolMute,
      isVoiceToolMuteActive,
      clipVoiceSpeechForPlayback,
      toVoiceSpeechPlain,
    }) => {
      if (!ctx.voiceReplyPendingRef.current) return
      const voiceSkNow = String(ctx.voiceSessionKeyRef.current || '').trim()
      if (!voiceSkNow || sk !== voiceSkNow) return

      if (shouldMuteVoiceSpeech(tools)) {
        enterVoiceToolMute((s) => setVoiceTrayState(s))
        void setVoiceTrayState('running')
        return
      }
      if (isVoiceToolMuteActive()) {
        exitVoiceToolMute()
      }

      if (!speechBody) return
      const speakable = clipVoiceSpeechForPlayback(speechBody)
      if (
        !speakable ||
        !shouldAdvanceVoiceSpeechSync(speakable, ctx.voiceSpeechSyncedPlainRef.current)
      ) {
        return
      }

      ctx.voiceSpeechSyncedPlainRef.current = toVoiceSpeechPlain(speakable)
      ctx.voiceStreamingStartedRef.current = true
      void setVoiceTrayState('speaking')
      enqueueVoiceStreamSpeech(speakable)
    },
  )
}

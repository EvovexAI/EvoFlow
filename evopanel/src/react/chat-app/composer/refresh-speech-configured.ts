// @ts-nocheck — mechanical P145 extract.
/**
 * Probe ASR / Web Speech availability and update speechEnabled.
 * Extracted from ChatApp.tsx (P145).
 */
export type RefreshSpeechConfiguredCtx = Record<string, any>

export function refreshSpeechConfigured(ctx: RefreshSpeechConfiguredCtx): void {
  void (async () => {
    try {
      const { isVolcengineAsrEnabled } = await import('../../../lib/voice-asr-policy.js')
      if (!isVolcengineAsrEnabled()) {
        const { isWebSpeechCaptureAvailable } = await import('../../../lib/web-speech-capture.js')
        if (isWebSpeechCaptureAvailable()) {
          ctx.setSpeechEnabled(true)
          return
        }
      }
      const { fetchSpeechConfigured } = await import('../../../lib/speech-client.js')
      ctx.setSpeechEnabled(!!(await fetchSpeechConfigured()))
    } catch {
      ctx.setSpeechEnabled(false)
    }
  })()
}

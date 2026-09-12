/**
 * 会议室控制台语音输入：复用 ChatComposer 同款 capture / PTT / 快捷键。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getShortcutBinding,
  KEYBOARD_SHORTCUTS_CHANGED,
  micVoiceHintText,
  pushToTalkReleaseMatches,
  shortcutMatchesEvent,
  voiceShortcutHintText,
} from '../../../lib/keyboard-shortcuts.js'
import { isTauri } from '../../../lib/panel-login.js'
import {
  cancelVoiceCapture,
  getVoicePartialTranscript,
  isVoiceCaptureActive,
  startVoiceCapture,
  stopVoiceCapture,
} from '../../../lib/voice-capture-service.js'
import {
  hideVoiceInputOverlay,
  showVoiceInputOverlay,
} from '../../../lib/background-voice.js'
import {
  registerMeetingVoicePartialHandler,
  registerMeetingVoiceSendHandler,
  setPreferMeetingVoice,
  unregisterMeetingVoicePartialHandler,
  unregisterMeetingVoiceSendHandler,
  VOICE_CAPTURE_SESSION_BEGIN,
  VOICE_CAPTURE_SESSION_END,
} from '../../../lib/background-voice-bridge.js'
import { fetchSpeechConfigured } from '../../../lib/speech-client.js'
import { enableMeetingTtsFromUserGesture } from '../../../lib/meeting-tts.js'

type Opts = {
  busy: boolean
  draft: string
  setDraft: (v: string) => void
  onTopicChange: (v: string) => void
  /** 识别完成后发送（已 trim） */
  onVoiceSubmit: (text: string) => void | Promise<void>
}

export function useRoundtableVoiceInput({
  busy,
  draft,
  setDraft,
  onTopicChange,
  onVoiceSubmit,
}: Opts) {
  const [speechEnabled, setSpeechEnabled] = useState(false)
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [voiceShortcutTick, setVoiceShortcutTick] = useState(0)

  const voiceRecordingRef = useRef(false)
  const voiceBusyRef = useRef(false)
  const voiceStartingRef = useRef(false)
  const pendingStopRef = useRef(false)
  const voiceStartSourceRef = useRef<'mic' | 'keyboard' | null>(null)
  const voiceHoldStartedAtRef = useRef(0)
  const savedDraftBeforeVoiceRef = useRef('')
  const draftRef = useRef(draft)
  const busyRef = useRef(busy)
  const onVoiceSubmitRef = useRef(onVoiceSubmit)
  const setDraftRef = useRef(setDraft)
  const onTopicChangeRef = useRef(onTopicChange)

  useEffect(() => {
    draftRef.current = draft
  }, [draft])
  useEffect(() => {
    busyRef.current = busy
  }, [busy])
  useEffect(() => {
    onVoiceSubmitRef.current = onVoiceSubmit
  }, [onVoiceSubmit])
  useEffect(() => {
    setDraftRef.current = setDraft
    onTopicChangeRef.current = onTopicChange
  }, [setDraft, onTopicChange])

  useEffect(() => {
    voiceRecordingRef.current = voiceRecording
  }, [voiceRecording])
  useEffect(() => {
    voiceBusyRef.current = voiceBusy
  }, [voiceBusy])

  useEffect(() => {
    let alive = true
    void fetchSpeechConfigured().then((ok) => {
      if (alive) setSpeechEnabled(!!ok)
    })
    return () => {
      alive = false
    }
  }, [])

  const setTextAndNotify = useCallback((v: string) => {
    setDraftRef.current(v)
    onTopicChangeRef.current(v)
  }, [])

  const cancelVoiceCaptureLocal = useCallback(() => {
    voiceStartSourceRef.current = null
    cancelVoiceCapture()
    void hideVoiceInputOverlay()
    setVoiceRecording(false)
    setVoiceBusy(false)
    const restore = savedDraftBeforeVoiceRef.current
    savedDraftBeforeVoiceRef.current = ''
    if (restore) setTextAndNotify(restore)
    else setTextAndNotify('')
  }, [setTextAndNotify])

  const stopVoiceRecordingAndSend = useCallback(async () => {
    if (voiceStartingRef.current && !isVoiceCaptureActive()) {
      pendingStopRef.current = true
      return
    }
    if (!voiceRecordingRef.current && !isVoiceCaptureActive()) return
    if (voiceBusyRef.current) return
    voiceBusyRef.current = true

    if (voiceStartSourceRef.current === 'keyboard' && voiceHoldStartedAtRef.current > 0) {
      const heldMs = Date.now() - voiceHoldStartedAtRef.current
      if (heldMs < 400) {
        voiceHoldStartedAtRef.current = 0
        cancelVoiceCapture()
        voiceStartSourceRef.current = null
        void hideVoiceInputOverlay()
        setVoiceRecording(false)
        voiceBusyRef.current = false
        setVoiceBusy(false)
        const restore = savedDraftBeforeVoiceRef.current
        savedDraftBeforeVoiceRef.current = ''
        if (restore) setTextAndNotify(restore)
        else setTextAndNotify('')
        const { toast } = await import('../../../components/toast.js')
        const { PTT_SHORT_PRESS_HINT } = await import('../../../lib/voice-ptt.js')
        toast(PTT_SHORT_PRESS_HINT, 'info')
        return
      }
    }
    voiceHoldStartedAtRef.current = 0

    setVoiceBusy(true)
    setVoiceRecording(false)

    try {
      void hideVoiceInputOverlay()
      const partial = getVoicePartialTranscript()
      // 会议室：不 keepWakePaused、不 arm 跟听，避免识别后一直开麦循环
      const { transcript, error } = await stopVoiceCapture({ keepWakePaused: false })
      if (error) throw error
      const finalText = String(transcript || partial || '').trim()
      savedDraftBeforeVoiceRef.current = ''
      setTextAndNotify('')
      try {
        const { cancelVoiceFollowUp } = await import('../../../lib/voice-follow-up.js')
        cancelVoiceFollowUp()
      } catch {
        /* ignore */
      }
      if (finalText) {
        await onVoiceSubmitRef.current(finalText)
      } else {
        const { toast } = await import('../../../components/toast.js')
        toast('未识别到语音内容，请按住说话后再试', 'warning')
      }
    } catch (e) {
      console.warn('[ai-rt voice]', e)
      const { microphoneErrorMessage } = await import('../../../lib/speech-audio.js')
      const { toast } = await import('../../../components/toast.js')
      toast(microphoneErrorMessage(e), 'error')
      setTextAndNotify('')
    } finally {
      voiceStartSourceRef.current = null
      void hideVoiceInputOverlay()
      setVoiceRecording(false)
      voiceBusyRef.current = false
      setVoiceBusy(false)
    }
  }, [setTextAndNotify])

  const startVoiceRecording = useCallback(
    async (source: 'mic' | 'keyboard') => {
      if (!speechEnabled) return
      if (busyRef.current || voiceBusyRef.current) return
      if (voiceRecordingRef.current || isVoiceCaptureActive()) return

      try {
        const { cancelVoiceFollowUp } = await import('../../../lib/voice-follow-up.js')
        cancelVoiceFollowUp()
      } catch {
        /* ignore */
      }

      try {
        const { stopAllAssistantSpeech } = await import('../../../lib/speech-client.js')
        stopAllAssistantSpeech()
        const { notifyTTSStopped } = await import('../../../lib/background-voice.js')
        notifyTTSStopped()
      } catch {
        /* ignore */
      }

      voiceStartSourceRef.current = source
      voiceHoldStartedAtRef.current = source === 'keyboard' ? Date.now() : 0
      voiceStartingRef.current = true
      savedDraftBeforeVoiceRef.current = draftRef.current
      setTextAndNotify('')

      try {
        await showVoiceInputOverlay()
        await startVoiceCapture({
          onPartial: (next) => {
            setTextAndNotify(String(next || ''))
          },
        })
        if (pendingStopRef.current) {
          pendingStopRef.current = false
          voiceStartingRef.current = false
          const heldMs =
            voiceHoldStartedAtRef.current > 0 ? Date.now() - voiceHoldStartedAtRef.current : 0
          if (voiceStartSourceRef.current === 'keyboard' && heldMs < 400) {
            voiceHoldStartedAtRef.current = 0
            cancelVoiceCapture()
            voiceStartSourceRef.current = null
            void hideVoiceInputOverlay()
            setVoiceRecording(false)
            const restore = savedDraftBeforeVoiceRef.current
            savedDraftBeforeVoiceRef.current = ''
            if (restore) setTextAndNotify(restore)
            else setTextAndNotify('')
            const { toast } = await import('../../../components/toast.js')
            const { PTT_SHORT_PRESS_HINT } = await import('../../../lib/voice-ptt.js')
            toast(PTT_SHORT_PRESS_HINT, 'info')
            return
          }
          setVoiceRecording(true)
          void stopVoiceRecordingAndSend()
          return
        }
        setVoiceRecording(true)
      } catch (e) {
        console.warn('[ai-rt voice] start', e)
        voiceStartSourceRef.current = null
        voiceHoldStartedAtRef.current = 0
        pendingStopRef.current = false
        savedDraftBeforeVoiceRef.current = ''
        void hideVoiceInputOverlay()
        setVoiceRecording(false)
        const { microphoneErrorMessage } = await import('../../../lib/speech-audio.js')
        const { toast } = await import('../../../components/toast.js')
        toast(microphoneErrorMessage(e), 'error')
      } finally {
        voiceStartingRef.current = false
        if (pendingStopRef.current) {
          pendingStopRef.current = false
          void stopVoiceRecordingAndSend()
        }
      }
    },
    [setTextAndNotify, speechEnabled, stopVoiceRecordingAndSend],
  )

  useEffect(() => {
    const refresh = () => setVoiceShortcutTick((t) => t + 1)
    window.addEventListener(KEYBOARD_SHORTCUTS_CHANGED, refresh)
    return () => window.removeEventListener(KEYBOARD_SHORTCUTS_CHANGED, refresh)
  }, [])

  const voicePushBinding = useMemo(
    () => getShortcutBinding('voicePushToTalk'),
    [voiceShortcutTick],
  )

  // 浏览器内快捷键（桌面 Tauri 走全局热键 + bridge）
  useEffect(() => {
    if (isTauri) return
    if (!speechEnabled) return
    if (voicePushBinding.disabled) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return
      if (e.key === 'Escape' && voiceRecordingRef.current) {
        e.preventDefault()
        cancelVoiceCaptureLocal()
        return
      }
      if (!shortcutMatchesEvent(voicePushBinding, e)) return
      e.preventDefault()
      if (voiceRecordingRef.current || isVoiceCaptureActive()) {
        void stopVoiceRecordingAndSend()
        return
      }
      if (!busyRef.current) void startVoiceRecording('keyboard')
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (!pushToTalkReleaseMatches(voicePushBinding, e)) return
      e.preventDefault()
      if (voiceRecordingRef.current || isVoiceCaptureActive() || voiceStartingRef.current) {
        void stopVoiceRecordingAndSend()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [
    cancelVoiceCaptureLocal,
    speechEnabled,
    startVoiceRecording,
    stopVoiceRecordingAndSend,
    voicePushBinding,
  ])

  // 全局 / 桌面 PTT：会议室前台优先；进房即关掉跟听，只允许手动开麦
  useEffect(() => {
    setPreferMeetingVoice(true)
    void import('../../../lib/voice-follow-up.js')
      .then(({ cancelVoiceFollowUp }) => cancelVoiceFollowUp())
      .catch(() => {})
    registerMeetingVoicePartialHandler((partial) => {
      setTextAndNotify(String(partial || ''))
    })
    registerMeetingVoiceSendHandler(async (text) => {
      const t = String(text || '').trim()
      if (!t || busyRef.current) return
      setTextAndNotify('')
      try {
        const { cancelVoiceFollowUp } = await import('../../../lib/voice-follow-up.js')
        cancelVoiceFollowUp()
      } catch {
        /* ignore */
      }
      await onVoiceSubmitRef.current(t)
    })

    const onBegin = () => {
      if (voiceRecordingRef.current || isVoiceCaptureActive()) return
      savedDraftBeforeVoiceRef.current = draftRef.current
      setVoiceRecording(true)
      setVoiceBusy(false)
    }
    const onEnd = (ev: Event) => {
      const detail = (ev as CustomEvent<{ cancelled?: boolean }>).detail || {}
      void hideVoiceInputOverlay()
      setVoiceRecording(false)
      setVoiceBusy(false)
      voiceStartingRef.current = false
      pendingStopRef.current = false
      voiceStartSourceRef.current = null
      if (detail.cancelled) {
        const restore = savedDraftBeforeVoiceRef.current
        savedDraftBeforeVoiceRef.current = ''
        if (restore) setTextAndNotify(restore)
      } else {
        savedDraftBeforeVoiceRef.current = ''
      }
    }
    window.addEventListener(VOICE_CAPTURE_SESSION_BEGIN, onBegin)
    window.addEventListener(VOICE_CAPTURE_SESSION_END, onEnd)

    return () => {
      setPreferMeetingVoice(false)
      unregisterMeetingVoicePartialHandler()
      unregisterMeetingVoiceSendHandler()
      window.removeEventListener(VOICE_CAPTURE_SESSION_BEGIN, onBegin)
      window.removeEventListener(VOICE_CAPTURE_SESSION_END, onEnd)
      if (voiceRecordingRef.current || isVoiceCaptureActive()) {
        cancelVoiceCapture()
        void hideVoiceInputOverlay()
      }
    }
  }, [setTextAndNotify])

  const toggleMic = useCallback(() => {
    if (!speechEnabled || busy || voiceBusy) return
    // 开麦手势同时解锁会议室 TTS 播报
    enableMeetingTtsFromUserGesture()
    if (voiceRecording || isVoiceCaptureActive()) {
      void stopVoiceRecordingAndSend()
    } else {
      void startVoiceRecording('mic')
    }
  }, [
    busy,
    speechEnabled,
    startVoiceRecording,
    stopVoiceRecordingAndSend,
    voiceBusy,
    voiceRecording,
  ])

  const micTitle = speechEnabled
    ? `${micVoiceHintText()}；${voiceShortcutHintText()}`
    : '未配置语音识别（设置 → 火山 ASR/TTS）'

  return {
    speechEnabled,
    voiceRecording,
    voiceBusy,
    toggleMic,
    micTitle,
  }
}

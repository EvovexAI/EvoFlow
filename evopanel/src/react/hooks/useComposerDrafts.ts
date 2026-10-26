/**
 * Per-session composer draft map + voice-partial → input bridge.
 * Extracted from ChatApp.tsx (P2b).
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  isXiaomiVoiceCaptureScope,
  registerVoicePartialBeginHandler,
  registerVoicePartialEndHandler,
  registerVoicePartialHandler,
  unregisterVoicePartialBeginHandler,
  unregisterVoicePartialEndHandler,
  unregisterVoicePartialHandler,
} from '../../lib/background-voice-bridge.js'

export function useComposerDrafts(opts: {
  selectedSessionKey: string
  sessionRef: MutableRefObject<string>
}) {
  const { selectedSessionKey, sessionRef } = opts

  /** Per-session unsent composer text (restored when switching sessions). */
  const composerDraftsRef = useRef(new Map<string, string>())
  const composerTextRef = useRef('')
  const composerDraftSnapshotRef = useRef('')
  const savedDraftBeforeGlobalVoiceRef = useRef('')
  const pendingComposerDraftCarryRef = useRef<string | null>(null)
  const [composerDraftVersion, setComposerDraftVersion] = useState(0)

  const pushComposerText = useCallback(
    (next: string) => {
      composerTextRef.current = next
      composerDraftSnapshotRef.current = next
      setComposerDraftVersion((v) => v + 1)
      const sk = String(sessionRef.current || selectedSessionKey || '').trim()
      if (!sk) return
      if (next) composerDraftsRef.current.set(sk, next)
      else composerDraftsRef.current.delete(sk)
    },
    [selectedSessionKey, sessionRef],
  )

  // 主对话 Composer 的语音 partial 桥：小V/小微对话作用域内一律忽略，防灌字。
  useEffect(() => {
    registerVoicePartialBeginHandler(() => {
      if (isXiaomiVoiceCaptureScope()) return
      savedDraftBeforeGlobalVoiceRef.current = composerTextRef.current
      pushComposerText('')
    })
    registerVoicePartialHandler((partialText: string) => {
      if (isXiaomiVoiceCaptureScope()) return
      pushComposerText(partialText)
    })
    registerVoicePartialEndHandler(({ cancelled }) => {
      if (isXiaomiVoiceCaptureScope()) return
      if (cancelled) {
        pushComposerText(savedDraftBeforeGlobalVoiceRef.current)
      } else {
        pushComposerText('')
      }
      savedDraftBeforeGlobalVoiceRef.current = ''
    })
    return () => {
      unregisterVoicePartialBeginHandler()
      unregisterVoicePartialHandler()
      unregisterVoicePartialEndHandler()
    }
  }, [pushComposerText])

  const handleComposerDraftChange = useCallback(
    (next: string) => {
      composerTextRef.current = next
      const sk = (sessionRef.current || selectedSessionKey || '').trim()
      if (!sk) return
      if (next) composerDraftsRef.current.set(sk, next)
      else composerDraftsRef.current.delete(sk)
    },
    [selectedSessionKey, sessionRef],
  )

  const restoreComposerDraft = useCallback((draft: string) => {
    composerTextRef.current = draft
    composerDraftSnapshotRef.current = draft
    setComposerDraftVersion((v) => v + 1)
  }, [])

  return {
    composerDraftsRef,
    composerTextRef,
    composerDraftSnapshotRef,
    pendingComposerDraftCarryRef,
    composerDraftVersion,
    pushComposerText,
    handleComposerDraftChange,
    restoreComposerDraft,
  }
}

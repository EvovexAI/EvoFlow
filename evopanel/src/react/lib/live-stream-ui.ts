/**
 * Phase 0 UI path: text/reasoning deltas publish to live-stream-store via rAF;
 * structural stream events drain the batch and bump MessageVirtualList.
 */
import { EventType } from '@ag-ui/core'
import { getSessionRuntime } from './session-runtime-store.js'
import { createRafBatch } from './raf-batch.js'
import {
  clearLiveStream,
  publishLiveStream,
} from './live-stream-store.js'
import { publishLiveStreamFromState } from './live-stream-publish.js'
import { isLiveStreamPathEnabled } from './stream-live-path-toggle.js'
import { noteLiveStreamRafFlush, noteSseStructuralEvent, noteSseTextDelta } from './client-perf.js'
import type { StreamState } from '../chat-types.js'

type BatchItem = { sessionKey: string }

let batch: ReturnType<typeof createRafBatch<BatchItem>> | null = null

function liveBatch() {
  if (!batch) {
    batch = createRafBatch<BatchItem>((items) => {
      noteLiveStreamRafFlush()
      const seen = new Set<string>()
      for (let i = items.length - 1; i >= 0; i--) {
        const sk = String(items[i]?.sessionKey || '').trim()
        if (!sk || seen.has(sk)) continue
        seen.add(sk)
        const rt = getSessionRuntime(sk)
        publishLiveStreamFromState(sk, rt?.stream, { streaming: true })
      }
    })
  }
  return batch
}

export function isAgUiLiveTextEvent(type: string): boolean {
  return (
    type === EventType.TEXT_MESSAGE_CONTENT ||
    type === EventType.REASONING_MESSAGE_CONTENT ||
    type === EventType.REASONING_MESSAGE_START ||
    type === EventType.REASONING_START
  )
}

export function isStreamTurnLiveTextEvent(type: string): boolean {
  return type === 'text_piece' || type === 'reasoning_piece'
}

/** rAF-coalesced live publish; returns true when handled (live path on). */
export function scheduleLiveStreamTextPublish(sessionKey: string): boolean {
  if (!isLiveStreamPathEnabled()) return false
  const sk = String(sessionKey || '').trim()
  if (!sk) return false
  noteSseTextDelta()
  liveBatch().push({ sessionKey: sk })
  return true
}

/** Sync publish after stream state mutation (structural boundary / first token). */
export function publishLiveStreamNow(
  sessionKey: string,
  stream?: StreamState | null,
  opts?: { streaming?: boolean },
): void {
  if (!isLiveStreamPathEnabled()) return
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  if (stream) {
    publishLiveStreamFromState(sk, stream, opts)
    return
  }
  const rt = getSessionRuntime(sk)
  publishLiveStreamFromState(sk, rt?.stream, opts)
}

/** Drain pending text frames, then sync publish before a structural UI bump. */
export function prepareLiveStreamStructuralUpdate(
  sessionKey: string,
  stream?: StreamState | null,
): void {
  if (!isLiveStreamPathEnabled()) return
  noteSseStructuralEvent()
  liveBatch().drain()
  publishLiveStreamNow(sessionKey, stream, { streaming: true })
}

export function drainLiveStreamTextBatch(): void {
  liveBatch().drain()
}

export function endLiveStreamSession(sessionKey: string): void {
  if (!isLiveStreamPathEnabled()) return
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  liveBatch().drain()
  publishLiveStream(sk, { text: '', reasoning: '', streaming: false })
  clearLiveStream(sk)
}

export function disposeLiveStreamUiBatch(): void {
  batch?.dispose()
  batch = null
}

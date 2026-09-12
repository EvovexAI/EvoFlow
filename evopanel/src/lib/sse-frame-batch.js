/**
 * SSE frame splitting + batched dispatch so burst reads do not monopolize the main thread.
 *
 * Two scheduling strategies:
 *  - 前台可见时走 requestAnimationFrame，跟随浏览器节奏；
 *  - 文档隐藏（hidden）时降级到 setTimeout(0)，避免后台标签 ~1Hz rAF 节流把 SSE 帧压在队列里。
 *
 * `flush()` 必须真正取消已挂的 rAF / timeout，否则末尾残块（dispatchSseFrame(buffer.replace…)）
 * 与排队回调可能乱序投递，导致历史末段被新增 delta 覆盖。
 */

/** LangGraph / SSE may use CRLF; normalize before splitting on blank lines. */
export function takeCompleteSseFrames(raw) {
  const normalized = String(raw || '').replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  return { frames: parts, rest }
}

function isDocumentHidden() {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  } catch {
    return false
  }
}

/**
 * Queue SSE frames and dispatch at most `maxPerSlice` per animation frame.
 * Call `flush()` before stream teardown so tail events are not dropped.
 *
 * **Backpressure**: when the queue exceeds `maxQueueSize` (default 200), non-critical
 * delta frames are evicted to prevent unbounded memory growth in background tabs
 * (where setTimeout(0) is throttled to ~1Hz). Critical frames (tool_call, run_end,
 * error, etc.) and the last `tailKeep` frames are always preserved. Final text
 * completeness is guaranteed by values snapshots / MESSAGES_SNAPSHOT, so dropping
 * intermediate deltas does not lose content.
 */
const _CRITICAL_FRAME_RE = /"type"\s*:\s*"(tool_call|tool_call_chunk|tool_result|run_end|run_started|run_error|error|aborted|final|usage|RUN_FINISHED|RUN_ERROR|RUN_STARTED|MESSAGES_SNAPSHOT|display_segments|write_file_progress)"/i

function isCriticalFrame(frame) {
  const f = String(frame || '')
  if (!f) return false
  // JSON event type patterns
  if (_CRITICAL_FRAME_RE.test(f)) return true
  // SSE event: lines for error / end / custom
  if (/^event:\s*(error|end|custom)\b/im.test(f)) return true
  return false
}

export function createSseFrameQueue(dispatchFrame, { maxPerSlice = 16, maxQueueSize = 200 } = {}) {
  const queue = []
  let rafHandle = 0
  let timeoutHandle = 0
  let droppedCount = 0
  // Number of recent frames to always keep regardless of criticality
  const tailKeep = 50

  /**
   * Evict non-critical frames from the head of the queue when it exceeds
   * `maxQueueSize`. Keeps all critical frames + the last `tailKeep` frames.
   * This is O(n) but only triggers when the queue is full (background tab).
   */
  const evictIfNeeded = () => {
    if (queue.length <= maxQueueSize) return
    const startIdx = Math.max(0, queue.length - tailKeep)
    let writeIdx = 0
    for (let i = 0; i < queue.length; i++) {
      if (i >= startIdx || isCriticalFrame(queue[i])) {
        queue[writeIdx++] = queue[i]
      } else {
        droppedCount++
      }
    }
    queue.length = writeIdx
    if (droppedCount > 0 && droppedCount % 100 === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[sse-frame-queue] dropped ${droppedCount} non-critical frames (cap=${maxQueueSize})`,
      )
    }
  }

  const runSlice = () => {
    rafHandle = 0
    timeoutHandle = 0
    let n = 0
    while (queue.length && n < maxPerSlice) {
      const frame = queue.shift()
      dispatchFrame(frame)
      n++
    }
    if (queue.length) schedule()
  }

  const schedule = () => {
    if (rafHandle || timeoutHandle) return
    // 文档隐藏时 rAF 会被浏览器节流到 ~1Hz；用 setTimeout(0) 保持流式连续写入。
    if (isDocumentHidden() || typeof requestAnimationFrame !== 'function') {
      timeoutHandle = setTimeout(runSlice, 0)
    } else {
      rafHandle = requestAnimationFrame(runSlice)
    }
  }

  const cancelScheduled = () => {
    if (rafHandle) {
      try {
        cancelAnimationFrame(rafHandle)
      } catch {
        /* ignore */
      }
      rafHandle = 0
    }
    if (timeoutHandle) {
      try {
        clearTimeout(timeoutHandle)
      } catch {
        /* ignore */
      }
      timeoutHandle = 0
    }
  }

  return {
    push(frame) {
      const f = String(frame || '')
      if (!f.trim()) return
      queue.push(f)
      evictIfNeeded()
      schedule()
    },
    flush() {
      cancelScheduled()
      while (queue.length) {
        dispatchFrame(queue.shift())
      }
    },
    get pending() {
      return queue.length
    },
    /** 调试：是否仍有未触发的 rAF/timeout（lint：测试可见） */
    get scheduled() {
      return Boolean(rafHandle || timeoutHandle)
    },
    /** 调试：因队列上限被丢弃的非关键帧数 */
    get dropped() {
      return droppedCount
    },
  }
}

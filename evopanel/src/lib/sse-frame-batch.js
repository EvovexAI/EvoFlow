/**
 * SSE frame splitting + batched dispatch so burst reads do not monopolize the main thread.
 *
 * 调度：一律 setTimeout(0)（rAF 在被遮挡/未合成的窗口里会停摆，见 schedule() 注释）。
 *
 * `flush()` 必须真正取消已挂的 rAF / timeout，否则末尾残块（dispatchSseFrame(buffer.replace…)）
 * 与排队回调可能乱序投递，导致历史末段被新增 delta 覆盖。
 */

/** LangGraph / SSE may use CRLF; normalize before splitting on blank lines.
 *  ★ 优化：避免全量 replace + split。对每个 '\n\n' (兼容 '\r\n\r\n') 边界用
 *  indexOf 找位置，只对完成部分切 frame，剩余留在 rest。Long buffer (累积
 *  100+ frames) 时从 O(N) 降到 O(完成帧数)，主 stream 30-50Hz 触发下
 *  每帧省 0.1-0.3ms。
 */
export function takeCompleteSseFrames(raw) {
  const s = typeof raw === 'string' ? raw : ''
  if (!s) return { frames: [], rest: '' }
  const len = s.length
  const frames = []
  let start = 0
  for (let i = 0; i < len - 1; i++) {
    const c = s.charCodeAt(i)
    if (c === 10 /* \n */ && s.charCodeAt(i + 1) === 10) {
      // 边界 i / i+1；统一去掉每行尾随 \r（处理 CRLF）
      const seg = s.slice(start, i)
      frames.push(seg.endsWith('\r') ? seg.slice(0, -1) : seg)
      start = i + 2
      i++ // 跳过第二个 \n
    }
  }
  return { frames, rest: start < len ? s.slice(start) : '' }
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
    // 主路径 rAF（与下个 paint 对齐，体感最连贯）；窗口被遮挡/未参与合成时
    // （document.visibilityState 仍 'visible'）rAF 长期停摆，队列被压住不排空。
    // 这种情况退回 setTimeout(0)：嵌套节流 ~4ms，开销可忽略，但保证流仍推进。
    const useRaf =
      typeof requestAnimationFrame === 'function' &&
      (typeof document === 'undefined' || document.visibilityState !== 'hidden')
    if (useRaf) {
      rafHandle = requestAnimationFrame(() => {
        rafHandle = 0
        runSlice()
      })
    } else {
      timeoutHandle = setTimeout(runSlice, 0)
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

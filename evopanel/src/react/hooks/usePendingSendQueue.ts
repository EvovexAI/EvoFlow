/**
 * Busy-turn pending send queue + mid-turn steers (↑ inject) + drain on idle.
 * Extracted from ChatApp.tsx (P3).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import {
  enqueuePendingInject,
  getPendingInjectStatus,
  restorePendingInjects,
  wsClient,
} from '../../lib/ws-client.js'
import { isTaskNotificationInject } from '../../lib/chat-normalize.js'
import { toast } from '../../components/toast.js'
import { toUserFacingError } from '../../lib/user-facing-error.js'
import { isSessionExecuting } from '../lib/session-execution/index.js'
import { getSessionRuntime } from '../lib/session-runtime-store.js'
import type { ChatSessionRow, DisplayRow } from '../chat-types.js'

export type PendingSendItem = { id: string; text: string }
export type PendingSteerItem = { id: string; messageId: string; text: string; sessionKey: string }

const PENDING_SEND_QUEUE_MAX = 5

export function usePendingSendQueue(opts: {
  selectedSessionKey: string
  selectedTurnBusy: boolean
  sessionRef: MutableRefObject<string>
  sessionsRef: MutableRefObject<ChatSessionRow[]>
  rowsRef: MutableRefObject<DisplayRow[]>
  setRows: Dispatch<SetStateAction<DisplayRow[]>>
  handleSendRef: MutableRefObject<(...args: any[]) => any>
  stopSessionExecutionRef: MutableRefObject<
    ((sessionKey: string, opts?: { showToast?: boolean }) => Promise<void>) | null
  >
  activeChatRunIdRef: MutableRefObject<string | null>
}) {
  const {
    selectedSessionKey,
    selectedTurnBusy,
    sessionRef,
    sessionsRef,
    rowsRef,
    setRows,
    handleSendRef,
    stopSessionExecutionRef,
    activeChatRunIdRef,
  } = opts

  /** 流式中排队等待发送（仅前端内存；runtime queued follow-ups；切换会话清空） */
  const [pendingSendQueue, setPendingSendQueue] = useState<PendingSendItem[]>([])
  const pendingSendQueueRef = useRef(pendingSendQueue)
  pendingSendQueueRef.current = pendingSendQueue
  /**
   * runtime pending_steers：已 ↑/steer 入队、等待下一次 before_model 消费。
   * 只在输入框上方预览，不进 transcript 气泡，直到 consumed ack。
   */
  const [pendingSteers, setPendingSteers] = useState<PendingSteerItem[]>([])
  const pendingSteersRef = useRef(pendingSteers)
  pendingSteersRef.current = pendingSteers
  /** Esc/立即发送 owns restore+send; stop handler must not also enqueue to pendingSendQueue. */
  const interruptSendSteersRef = useRef(false)
  const pendingDrainBusyRef = useRef(false)
  const prevTurnBusyForDrainRef = useRef(false)
  /** 忙时 ↑ 已入 pending-inject；本轮结束后若尚未被模型消费则 skipAppend 续跑 */
  const midTurnInjectRef = useRef<Array<{ messageId: string; text: string; sessionKey: string }>>([])

  const handleQueueWhileBusy = useCallback((text: string) => {
    const t = String(text || '').trim()
    if (!t) return
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `pending-${Date.now()}`
    setPendingSendQueue((prev) => {
      if (prev.length >= PENDING_SEND_QUEUE_MAX) {
        toast(`最多排队 ${PENDING_SEND_QUEUE_MAX} 条，请先发送或删除`, 'warning')
        return prev
      }
      return [...prev, { id, text: t }]
    })
    toast('已排队，回合结束后发送', 'info')
  }, [])

  const enqueueSteerWhileBusy = useCallback(
    (text: string) => {
      const t = String(text || '').trim()
      if (!t) return
      const skBusy = String(sessionRef.current || '').trim()
      if (!skBusy) return
      const rowBusy = sessionsRef.current.find((s) => String(s.sessionKey || '') === skBusy)
      if (!isSessionExecuting(skBusy, { sessionRow: rowBusy })) {
        void handleSendRef.current?.(t)
        return
      }

      let messageId = ''
      try {
        messageId =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `user-inject-${Date.now()}`
      } catch {
        messageId = `user-inject-${Date.now()}`
      }
      const steer = { id: messageId, messageId, text: t, sessionKey: skBusy }
      setPendingSteers((prev) => {
        if (prev.some((s) => s.messageId === messageId && s.sessionKey === skBusy)) return prev
        return [...prev, steer]
      })
      midTurnInjectRef.current = [
        ...midTurnInjectRef.current,
        { messageId, text: t, sessionKey: skBusy },
      ]
      const rt = getSessionRuntime(skBusy)
      const threadId = String(wsClient.getSessionThreadId(skBusy) || '').trim() || null
      const runId =
        String(rt.activeChatRunId || activeChatRunIdRef.current || rt.stream?.runId || '').trim() ||
        null
      void enqueuePendingInject(skBusy, {
        content: t,
        messageId,
        runId,
        threadId,
      })
        .then((res) => {
          if (!res || (res as { ok?: boolean }).ok === false) {
            throw new Error('纠偏消息入队失败，请重试')
          }
        })
        .catch((e) => {
          toast(toUserFacingError((e as Error)?.message || e), 'error')
          setPendingSteers((prev) =>
            prev.filter((s) => !(s.sessionKey === skBusy && s.messageId === messageId)),
          )
          midTurnInjectRef.current = midTurnInjectRef.current.filter(
            (x) => !(x.sessionKey === skBusy && x.messageId === messageId),
          )
        })
    },
    [sessionRef, sessionsRef, handleSendRef, activeChatRunIdRef],
  )

  const handleSteerWhileBusy = enqueueSteerWhileBusy

  const handleCancelPendingSend = useCallback((id: string) => {
    setPendingSendQueue((prev) => prev.filter((x) => x.id !== id))
  }, [])

  const handleEditPendingSend = useCallback((id: string, text: string) => {
    setPendingSendQueue((prev) => prev.map((x) => (x.id === id ? { ...x, text } : x)))
  }, [])

  const promoteConsumedSteersToRows = useCallback(
    (sessionKey: string, messageIds: string[]) => {
      const sk = String(sessionKey || '').trim()
      const ids = new Set((messageIds || []).map((x) => String(x || '').trim()).filter(Boolean))
      if (!sk || !ids.size) return
      const steers = pendingSteersRef.current.filter(
        (s) => s.sessionKey === sk && ids.has(s.messageId),
      )
      if (!steers.length) {
        setPendingSteers((prev) =>
          prev.filter((s) => !(s.sessionKey === sk && ids.has(s.messageId))),
        )
        midTurnInjectRef.current = midTurnInjectRef.current.filter(
          (x) => !(x.sessionKey === sk && ids.has(x.messageId)),
        )
        return
      }
      const rt = getSessionRuntime(sk)
      const existingRows = Array.isArray(rt.rows) ? [...rt.rows] : []
      let changed = false
      for (const s of steers) {
        if (isTaskNotificationInject(s)) continue
        if (existingRows.some((r) => r.messageId && r.messageId === s.messageId)) continue
        existingRows.push({
          role: 'user',
          text: s.text,
          messageId: s.messageId,
          timestamp: Date.now(),
        })
        changed = true
      }
      if (changed) {
        rt.rows = existingRows
        if (String(sessionRef.current || '').trim() === sk) {
          setRows([...rt.rows])
          rowsRef.current = [...rt.rows]
        }
      }
      setPendingSteers((prev) =>
        prev.filter((s) => !(s.sessionKey === sk && ids.has(s.messageId))),
      )
      midTurnInjectRef.current = midTurnInjectRef.current.filter(
        (x) => !(x.sessionKey === sk && ids.has(x.messageId)),
      )
      let badgeCleared = false
      const cleaned = (Array.isArray(rt.rows) ? rt.rows : []).map((r) => {
        if (r.role !== 'user' || !r.pendingInject) return r
        if (!ids.has(String(r.messageId || ''))) return r
        badgeCleared = true
        const { pendingInject: _omit, ...rest } = r
        return rest
      })
      if (badgeCleared) {
        rt.rows = cleaned
        if (String(sessionRef.current || '').trim() === sk) {
          setRows([...cleaned])
          rowsRef.current = [...cleaned]
        }
      }
    },
    [sessionRef, rowsRef, setRows],
  )

  const handleFlushPendingSend = useCallback(
    (id: string) => {
      const hit = pendingSendQueueRef.current.find((x) => x.id === id)
      if (!hit) return
      const text = String(hit.text || '').trim()
      if (!text) {
        toast('等待发送内容为空，请先填写或删除', 'warning')
        return
      }
      const skBusy = String(sessionRef.current || '').trim()
      const rowBusy = skBusy
        ? sessionsRef.current.find((s) => String(s.sessionKey || '') === skBusy)
        : null
      const busy = isSessionExecuting(skBusy, { sessionRow: rowBusy })
      setPendingSendQueue((prev) => prev.filter((x) => x.id !== id))
      if (busy) {
        enqueueSteerWhileBusy(text)
        return
      }
      void handleSendRef.current(text)
    },
    [enqueueSteerWhileBusy, sessionRef, sessionsRef, handleSendRef],
  )

  const handleCancelPendingSteer = useCallback(
    (messageId: string) => {
      const mid = String(messageId || '').trim()
      if (!mid) return
      const sk = String(sessionRef.current || '').trim()
      setPendingSteers((prev) =>
        prev.filter((s) => !(s.messageId === mid && (!sk || s.sessionKey === sk))),
      )
      midTurnInjectRef.current = midTurnInjectRef.current.filter(
        (x) => !(x.messageId === mid && (!sk || x.sessionKey === sk)),
      )
    },
    [sessionRef],
  )

  const handleInterruptAndSendSteers = useCallback(async () => {
    const sk = String(sessionRef.current || '').trim()
    if (!sk) return
    const steers = pendingSteersRef.current.filter((s) => s.sessionKey === sk)
    if (!steers.length) return
    const texts = steers.map((s) => s.text).filter(Boolean)
    const merged = texts.join('\n\n').trim()
    const steerTextSet = new Set(texts.map((t) => String(t || '').trim()).filter(Boolean))
    interruptSendSteersRef.current = true
    try {
      try {
        await stopSessionExecutionRef.current?.(sk, { showToast: false })
      } catch {
        /* still try to restore/send */
      }
      try {
        await restorePendingInjects(sk)
      } catch {
        /* ignore */
      }
      setPendingSteers((prev) => prev.filter((s) => s.sessionKey !== sk))
      midTurnInjectRef.current = midTurnInjectRef.current.filter((x) => x.sessionKey !== sk)
      if (steerTextSet.size) {
        setPendingSendQueue((prev) =>
          prev.filter((x) => !steerTextSet.has(String(x.text || '').trim())),
        )
      }
      if (merged) {
        toast('已打断，正在立即发送纠偏指令…', 'info')
        await handleSendRef.current(merged)
      }
    } finally {
      interruptSendSteersRef.current = false
    }
  }, [sessionRef, stopSessionExecutionRef, handleSendRef])

  // 当前回复结束后：① 未消费的 ↑ 注入续跑；② 再发排队队首
  useEffect(() => {
    const wasBusy = prevTurnBusyForDrainRef.current
    prevTurnBusyForDrainRef.current = selectedTurnBusy
    if (selectedTurnBusy || !wasBusy) return
    if (pendingDrainBusyRef.current) return

    const sk = String(sessionRef.current || selectedSessionKey || '').trim()
    const injects = midTurnInjectRef.current.filter((x) => x.sessionKey === sk)
    const steers = pendingSteersRef.current.filter((s) => s.sessionKey === sk)
    const hasOrphanPendingUi = (
      (sk ? getSessionRuntime(sk).rows : null) ||
      rowsRef.current ||
      []
    ).some((r) => r.role === 'user' && r.pendingInject)

    if (
      !injects.length &&
      !steers.length &&
      !pendingSendQueueRef.current.length &&
      !hasOrphanPendingUi
    ) {
      return
    }

    pendingDrainBusyRef.current = true
    void Promise.resolve(
      (async () => {
        let pendingCount = -1
        let statusItems: Array<{ messageId: string; text: string }> = []
        try {
          const status = await getPendingInjectStatus(sk)
          if (status && typeof status.pendingCount === 'number') {
            pendingCount = status.pendingCount
            if (Array.isArray(status.items)) {
              statusItems = status.items
                .map((it: { messageId?: string; text?: string }) => ({
                  messageId: String(it?.messageId || '').trim(),
                  text: String(it?.text || '').trim(),
                }))
                .filter(
                  (it: { messageId: string; text: string }) =>
                    it.messageId && !isTaskNotificationInject(it),
                )
            }
          }
        } catch {
          pendingCount = -1
        }

        if (pendingCount === 0) {
          const localIds = steers.map((s) => s.messageId)
          if (localIds.length) promoteConsumedSteersToRows(sk, localIds)
          else {
            setPendingSteers((prev) => prev.filter((s) => s.sessionKey !== sk))
            midTurnInjectRef.current = midTurnInjectRef.current.filter((x) => x.sessionKey !== sk)
          }
          const rt = getSessionRuntime(sk)
          const cleaned = (Array.isArray(rt.rows) ? rt.rows : []).map((r) => {
            if (r.role !== 'user' || !r.pendingInject) return r
            const { pendingInject: _omit, ...rest } = r
            return rest
          })
          rt.rows = cleaned
          if (String(sessionRef.current || '').trim() === sk) {
            setRows([...cleaned])
            rowsRef.current = [...cleaned]
          }
        } else if (pendingCount > 0 && statusItems.length) {
          const pendingIds = new Set(statusItems.map((i) => i.messageId))
          const consumedLocal = steers
            .filter((s) => !pendingIds.has(s.messageId))
            .map((s) => s.messageId)
          if (consumedLocal.length) promoteConsumedSteersToRows(sk, consumedLocal)
          setPendingSteers((prev) => {
            const keep = prev.filter((s) => s.sessionKey !== sk || pendingIds.has(s.messageId))
            const existing = new Set(keep.filter((s) => s.sessionKey === sk).map((s) => s.messageId))
            const add = statusItems
              .filter((i) => !existing.has(i.messageId) && !isTaskNotificationInject(i))
              .map((i) => ({
                id: i.messageId,
                messageId: i.messageId,
                text: i.text,
                sessionKey: sk,
              }))
            return [...keep, ...add]
          })
        }

        let needsContinue: { messageId: string; text: string; sessionKey: string } | null = null
        if (pendingCount > 0) {
          const still = pendingSteersRef.current.filter((s) => s.sessionKey === sk)
          if (still.length) {
            needsContinue = {
              messageId: still[0].messageId,
              text: still[0].text,
              sessionKey: sk,
            }
          } else if (statusItems.length) {
            needsContinue = {
              messageId: statusItems[0].messageId,
              text: statusItems[0].text,
              sessionKey: sk,
            }
          } else if (injects.length) {
            needsContinue = injects[0]
          }
        }

        if (needsContinue) {
          try {
            await handleSendRef.current(needsContinue.text, undefined, undefined, {
              messageId: needsContinue.messageId,
              skipTranscriptAppend: true,
              alreadyInjected: true,
            })
            midTurnInjectRef.current = midTurnInjectRef.current.filter(
              (x) => !(x.sessionKey === sk && x.messageId === needsContinue!.messageId),
            )
          } catch {
            /* retry next busy→idle */
          }
          return
        }

        midTurnInjectRef.current = midTurnInjectRef.current.filter((x) => x.sessionKey !== sk)

        const next = pendingSendQueueRef.current[0]
        if (!next) return
        const rowStill = sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
        if (isSessionExecuting(sk, { sessionRow: rowStill })) {
          return
        }
        setPendingSendQueue((prev) => prev.filter((x) => x.id !== next.id))
        await handleSendRef.current(next.text)
      })(),
    ).finally(() => {
      pendingDrainBusyRef.current = false
    })
  }, [
    selectedTurnBusy,
    selectedSessionKey,
    promoteConsumedSteersToRows,
    sessionRef,
    rowsRef,
    setRows,
    sessionsRef,
    handleSendRef,
  ])

  // 切换会话：清空本地排队；从 DB 恢复未消费 steers
  useEffect(() => {
    setPendingSendQueue([])
    pendingDrainBusyRef.current = false
    midTurnInjectRef.current = []
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) {
      setPendingSteers([])
      return
    }
    let cancelled = false
    void getPendingInjectStatus(sk).then((status) => {
      if (cancelled) return
      const items = Array.isArray(status?.items) ? status.items : []
      setPendingSteers(
        items
          .map((it: { messageId?: string; text?: string }) => ({
            id: String(it?.messageId || '').trim(),
            messageId: String(it?.messageId || '').trim(),
            text: String(it?.text || '').trim(),
            sessionKey: sk,
          }))
          .filter(
            (s: { messageId: string; text: string }) =>
              s.messageId && s.text && !isTaskNotificationInject(s),
          ),
      )
    })
    return () => {
      cancelled = true
    }
  }, [selectedSessionKey])

  return {
    pendingSendQueue,
    setPendingSendQueue,
    pendingSendQueueRef,
    pendingSteers,
    setPendingSteers,
    pendingSteersRef,
    interruptSendSteersRef,
    midTurnInjectRef,
    handleQueueWhileBusy,
    handleSteerWhileBusy,
    handleCancelPendingSend,
    handleEditPendingSend,
    promoteConsumedSteersToRows,
    handleFlushPendingSend,
    handleCancelPendingSteer,
    handleInterruptAndSendSteers,
  }
}

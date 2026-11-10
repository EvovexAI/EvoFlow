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
import {
  isSessionExecuting,
  type StopSessionOptions,
} from '../lib/session-execution/index.js'
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
    ((sessionKey: string, opts?: StopSessionOptions) => Promise<void>) | null
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

  /**
   * 流式中排队等待发送：按 sessionKey 分桶，切走再切回要还能看见。
   * （此前单数组 + 切会话清空，导致「排队消息丢了」。）
   */
  const [pendingSendQueue, setPendingSendQueueState] = useState<PendingSendItem[]>([])
  const pendingSendQueueRef = useRef(pendingSendQueue)
  pendingSendQueueRef.current = pendingSendQueue
  const queuesBySessionRef = useRef(new Map<string, PendingSendItem[]>())
  const queueOwnerSessionRef = useRef(String(selectedSessionKey || '').trim())
  /**
   * runtime pending_steers：已 ↑/steer 入队、等待下一次 before_model 消费。
   * 只在输入框上方预览，不进 transcript 气泡，直到 consumed ack。
   */
  const [pendingSteers, setPendingSteers] = useState<PendingSteerItem[]>([])
  const pendingSteersRef = useRef(pendingSteers)
  pendingSteersRef.current = pendingSteers
  /** Esc/立即发送 owns restore+send; stop handler must not also enqueue to pendingSendQueue. */
  const interruptSendSteersRef = useRef(false)
  /** interrupt+send 进行中：防快速双触（双 Enter/双 Esc）导致重复 stop+send。 */
  const interruptFlushInFlightRef = useRef(false)
  const pendingDrainBusyRef = useRef(false)
  const prevTurnBusyForDrainRef = useRef(false)
  /** 忙时 ↑ 已入 pending-inject；本轮结束后若尚未被模型消费则 skipAppend 续跑 */
  const midTurnInjectRef = useRef<Array<{ messageId: string; text: string; sessionKey: string }>>([])

  const setPendingSendQueue = useCallback(
    (updater: SetStateAction<PendingSendItem[]>) => {
      setPendingSendQueueState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater
        const sk = String(sessionRef.current || queueOwnerSessionRef.current || '').trim()
        if (sk) queuesBySessionRef.current.set(sk, next)
        return next
      })
    },
    [sessionRef],
  )

  const handleQueueWhileBusy = useCallback((text: string) => {
    const t = String(text || '').trim()
    if (!t) return
    const owner = String(sessionRef.current || '').trim()
    if (!owner) return
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `pending-${Date.now()}`
    const base =
      queuesBySessionRef.current.get(owner) ||
      (owner === queueOwnerSessionRef.current ? pendingSendQueueRef.current : [])
    if (base.length >= PENDING_SEND_QUEUE_MAX) {
      toast(`最多排队 ${PENDING_SEND_QUEUE_MAX} 条，请先发送或删除`, 'warning')
      return
    }
    const next = [...base, { id, text: t }]
    queuesBySessionRef.current.set(owner, next)
    if (owner === queueOwnerSessionRef.current) {
      setPendingSendQueueState(next)
    }
    toast('已排队，回合结束后发送', 'info')
  }, [sessionRef])

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

  const handleCancelPendingSend = useCallback(
    (id: string) => {
      setPendingSendQueue((prev) => prev.filter((x) => x.id !== id))
    },
    [setPendingSendQueue],
  )

  const handleEditPendingSend = useCallback(
    (id: string, text: string) => {
      setPendingSendQueue((prev) => prev.map((x) => (x.id === id ? { ...x, text } : x)))
    },
    [setPendingSendQueue],
  )

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
    [enqueueSteerWhileBusy, sessionRef, sessionsRef, handleSendRef, setPendingSendQueue],
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
    pendingDrainBusyRef.current = true
    try {
      try {
        await stopSessionExecutionRef.current?.(sk, {
          showToast: false,
          source: 'interrupt_send_steers',
        })
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
      pendingDrainBusyRef.current = false
    }
  }, [sessionRef, stopSessionExecutionRef, handleSendRef, setPendingSendQueue])

  /** 空 Enter / 队首插队：打断当前回合，排队消息立即作为新回合发出。
   * 与 handleInterruptAndSendSteers（Esc）同构，但发送对象是 pendingSendQueue 队首；
   * 未消费的 steers（本地 + 服务端）随本次发送一并带出，避免内容悬空。
   * 注意：服务端注入必须在 stop 之前取回——stop 宿主在 interrupt 旗标置位时
   * 也会 pop（丢弃语义），后 pop 方拿到空列表。 */
  const handleInterruptAndFlushQueue = useCallback(
    async (id?: string) => {
      const sk = String(sessionRef.current || '').trim()
      if (!sk) return
      if (interruptFlushInFlightRef.current) return
      const queueForSk =
        queuesBySessionRef.current.get(sk) ||
        (sk === queueOwnerSessionRef.current ? pendingSendQueueRef.current : [])
      const target = id ? queueForSk.find((x) => x.id === id) : queueForSk[0]
      if (!target) return
      const text = String(target.text || '').trim()
      if (!text) {
        toast('等待发送内容为空，请先填写或删除', 'warning')
        return
      }

      let serverSteerTexts: string[] = []
      try {
        const res = await restorePendingInjects(sk)
        const restored = Array.isArray(res?.restored) ? res.restored : []
        serverSteerTexts = restored
          .map((it: { text?: string }) => String(it?.text || '').trim())
          .filter((t: string) => t && !isTaskNotificationInject({ text: t }))
      } catch {
        /* ignore */
      }
      const localSteerTexts = pendingSteersRef.current
        .filter((s) => s.sessionKey === sk)
        .map((s) => String(s.text || '').trim())
        .filter(Boolean)
      const steerTexts = Array.from(new Set([...serverSteerTexts, ...localSteerTexts]))
      const merged = [...steerTexts, text].join('\n\n').trim()

      interruptFlushInFlightRef.current = true
      interruptSendSteersRef.current = true
      pendingDrainBusyRef.current = true
      try {
        try {
          await stopSessionExecutionRef.current?.(sk, {
            showToast: false,
            source: 'interrupt_flush_queue',
          })
        } catch {
          /* 打断失败仍尝试发送 */
        }
        setPendingSteers((prev) => prev.filter((s) => s.sessionKey !== sk))
        midTurnInjectRef.current = midTurnInjectRef.current.filter((x) => x.sessionKey !== sk)
        setPendingSendQueue((prev) => prev.filter((x) => x.id !== target.id))
        if (merged) {
          toast('已打断，正在立即发送排队消息…', 'info')
          await handleSendRef.current(merged)
        }
      } finally {
        interruptSendSteersRef.current = false
        pendingDrainBusyRef.current = false
        interruptFlushInFlightRef.current = false
      }
    },
    [sessionRef, stopSessionExecutionRef, handleSendRef, setPendingSendQueue],
  )

  const runPendingDrain = useCallback(
    async (skRaw: string) => {
      const sk = String(skRaw || '').trim()
      if (!sk || pendingDrainBusyRef.current) return
      if (String(sessionRef.current || '').trim() !== sk) return

      const queueForSk =
        queuesBySessionRef.current.get(sk) ||
        (sk === queueOwnerSessionRef.current ? pendingSendQueueRef.current : [])
      const injects = midTurnInjectRef.current.filter((x) => x.sessionKey === sk)
      const steers = pendingSteersRef.current.filter((s) => s.sessionKey === sk)
      const hasOrphanPendingUi = (
        getSessionRuntime(sk).rows ||
        (sk === queueOwnerSessionRef.current ? rowsRef.current : null) ||
        []
      ).some((r) => r.role === 'user' && r.pendingInject)

      if (!injects.length && !steers.length && !queueForSk.length && !hasOrphanPendingUi) {
        return
      }

      pendingDrainBusyRef.current = true
      try {
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

        if (String(sessionRef.current || '').trim() !== sk) return

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

        const queueNow =
          queuesBySessionRef.current.get(sk) ||
          (sk === queueOwnerSessionRef.current ? pendingSendQueueRef.current : [])
        const next = queueNow[0]
        if (!next) return
        const rowStill = sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
        if (isSessionExecuting(sk, { sessionRow: rowStill })) {
          return
        }
        if (String(sessionRef.current || '').trim() !== sk) return
        setPendingSendQueue((prev) => prev.filter((x) => x.id !== next.id))
        await handleSendRef.current(next.text)
      } finally {
        pendingDrainBusyRef.current = false
      }
    },
    [
      promoteConsumedSteersToRows,
      sessionRef,
      rowsRef,
      setRows,
      sessionsRef,
      handleSendRef,
      setPendingSendQueue,
    ],
  )
  const runPendingDrainRef = useRef(runPendingDrain)
  runPendingDrainRef.current = runPendingDrain

  // 切换会话：按 session 恢复本地排队；从 DB 恢复未消费 steers
  // 必须先于 busy→idle drain，以免把上一会话 busy 边沿误触发到新会话。
  useEffect(() => {
    const prevSk = queueOwnerSessionRef.current
    const sk = String(selectedSessionKey || '').trim()

    if (prevSk) {
      queuesBySessionRef.current.set(prevSk, [...pendingSendQueueRef.current])
    }

    queueOwnerSessionRef.current = sk
    pendingDrainBusyRef.current = false

    const restored = sk ? queuesBySessionRef.current.get(sk) || [] : []
    setPendingSendQueueState(restored)

    const row = sk
      ? sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
      : null
    const busy = sk ? isSessionExecuting(sk, { sessionRow: row }) : false
    // 避免把上一会话的 busy 边沿误当成当前会话的 busy→idle
    prevTurnBusyForDrainRef.current = busy

    let cancelled = false
    let resumeTimer: ReturnType<typeof setTimeout> | null = null
    if (sk && restored.length && !busy) {
      // 后台回合已结束时选中态不会再走 busy→idle，切回后补一次 drain
      resumeTimer = setTimeout(() => {
        if (!cancelled) void runPendingDrainRef.current(sk)
      }, 0)
    }

    if (!sk) {
      setPendingSteers([])
      return () => {
        cancelled = true
        if (resumeTimer) clearTimeout(resumeTimer)
      }
    }
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
      if (resumeTimer) clearTimeout(resumeTimer)
    }
  }, [selectedSessionKey, sessionsRef])

  // 当前回复结束后：① 未消费的 ↑ 注入续跑；② 再发排队队首
  useEffect(() => {
    const wasBusy = prevTurnBusyForDrainRef.current
    prevTurnBusyForDrainRef.current = selectedTurnBusy
    if (selectedTurnBusy || !wasBusy) return
    const sk = String(sessionRef.current || selectedSessionKey || '').trim()
    if (!sk) return
    void runPendingDrainRef.current(sk)
  }, [selectedTurnBusy, selectedSessionKey, sessionRef])

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
    handleInterruptAndFlushQueue,
  }
}

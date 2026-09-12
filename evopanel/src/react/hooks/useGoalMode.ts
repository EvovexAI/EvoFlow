import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ThreadGoalProposal } from '../chat-types.js'
import { evoflowInvokeGatewayJson } from '../../lib/ws-client.js'
import { markSessionGoalRunning } from '../lib/session-execution/goal-mode-state.js'
import { toast } from '../../components/toast.js'
import { notifyDesktopCompletion } from '../../lib/desktop-notification.js'
import { resolveGoalClosureTimestamp } from '../lib/goalClosureLocal.js'
import { pickDefaultPushTargetKey, parsePushTargetKey, type PushTargetOption } from '../lib/goalPushTarget.js'

const HOSTED_STATUS = { IDLE: 'idle', RUNNING: 'running', WAITING: 'waiting_reply', PAUSED: 'paused', ERROR: 'error' } as const
type HostedStatus = (typeof HOSTED_STATUS)[keyof typeof HOSTED_STATUS]

// @ts-ignore
const HOSTED_STATUS_POLL_MS = 4000
const HOSTED_STATUS_POLL_WAITING_MS = 1500

const HOSTED_DEFAULTS = {
  enabled: false,
  prompt: '',
  autoRunAfterTarget: true,
  stopPolicy: 'self',
  stepDelayMs: 1500,
  retryLimit: 2,
  initiative: 60,
  emotionalIntelligence: true,
  continuousLearning: false,
  useEvolutionSkill: false,
  feishuPushOnComplete: false,
  pushChannel: '',
  pushTargetId: '',
}

const HOSTED_RUNTIME_DEFAULT: {
  status: HostedStatus
  stepCount: number
  lastRunAt: number
  lastRunId: string
  lastError: string
  pending: boolean
  errorCount: number
} = {
  status: HOSTED_STATUS.IDLE,
  stepCount: 0,
  lastRunAt: 0,
  lastRunId: '',
  lastError: '',
  pending: false,
  errorCount: 0,
}

type SkillSupport = { loaded: boolean; evolution: boolean }

type HostedSessionConfig = {
  enabled: boolean
  prompt: string
  stepDelayMs: number
  retryLimit: number
  personaStyle: 'warm' | 'professional' | 'lively' | 'calm'
  initiative: number
  emotionalIntelligence: boolean
  continuousLearning: boolean
  useEvolutionSkill: boolean
  feishuPushOnComplete: boolean
  pushChannel: string
  pushTargetId: string
  state: typeof HOSTED_RUNTIME_DEFAULT
}

type GoalStatus = 'active' | 'paused' | 'completed' | 'cleared' | ''

type HostedPanelUiState = {
  enabled: boolean
  status: HostedStatus
  goalStatus: GoalStatus
  goalActive: boolean
  continuationSuppressed: boolean
  goalRevision: number
  prompt: string
  lastError: string
  isRunning: boolean
  isExecuting: boolean
  elapsedText: string
  personaStyle: HostedSessionConfig['personaStyle']
  initiative: number
  emotionalIntelligence: boolean
  continuousLearning: boolean
  useEvolutionSkill: boolean
  feishuPushOnComplete: boolean
  pushChannel: string
  pushTargetId: string
  pushTargets: PushTargetOption[]
  pushTargetsAvailable: boolean
  feishuPushConfigured: boolean
  skillSupport: SkillSupport
  goalSummary: string
  completionOutcome: string
}

function mapGoalStatus(raw: string): GoalStatus {
  const v = String(raw || '').trim().toLowerCase()
  if (v === 'active' || v === 'paused' || v === 'completed' || v === 'cleared') return v
  return ''
}

function isGoalActiveStatus(gs: GoalStatus): boolean {
  return gs === 'active' || gs === 'paused'
}

function shouldStartHostedPollFromBackend(data: any): boolean {
  const goalStatus = mapGoalStatus(String(data?.goal_status || data?.goalStatus || ''))
  return isGoalActiveStatus(goalStatus)
}

function goalDebugEnabled(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('EVOFLOW_GOAL_DEBUG') === '1' } catch { return false }
}

/** [hosted-stream] 调试日志已移除 */
function goalStreamLog(_event: string, _data?: Record<string, unknown>) {
  /* no-op: 日志已移除 */
}

function iconForGoalUi(goalActive: boolean, isExecuting: boolean, status: HostedStatus) {
  if (!goalActive) return '○'
  if (status === HOSTED_STATUS.ERROR) return '!'
  if (isExecuting) return '▶'
  return '●'
}

function formatHostedElapsed(startMs: number): string {
  if (!startMs) return '0s'
  const sec = Math.max(0, Math.floor((Date.now() - startMs) / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}:${s.toString().padStart(2, '0')}`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}:${rm.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function mapBackendStatus(s: string): HostedStatus {
  const v = String(s || '').toLowerCase()
  if (v === 'running') return HOSTED_STATUS.RUNNING
  if (v === 'waiting') return HOSTED_STATUS.WAITING
  if (v === 'paused') return HOSTED_STATUS.PAUSED
  if (v === 'error') return HOSTED_STATUS.ERROR
  return HOSTED_STATUS.IDLE
}

let cachedSkillSupport: SkillSupport | null = null
let skillSupportInflight: Promise<SkillSupport> | null = null

export function useGoalMode({
  sessionKey,
  chatModelName: _chatModelName,
  onGoalClosureReport,
  onGoalRunningChange,
  onGoalSendingChange,
  onRefreshChatHistory,
  onSendGoalMessage,
}: {
  sessionKey: string | null
  chatModelName: string
  /** @deprecated 目标对话内容走 DB 历史，不再注入 system 行 */
  onAppendSystemMessage?: (text: string) => void
  onGoalClosureReport?: (p: { sessionKey: string; outcome: string; body: string; ts?: number }) => void
  onGoalRunningChange?: (running: boolean, sessionKey: string) => void
  onGoalSendingChange?: (sending: boolean) => void
  /** 目标步进或 EvoFlow run 推进时刷新 chat 历史（仅步完成/结束时） */
  onRefreshChatHistory?: () => void | Promise<void>
  /** Web 目标模式：与普通 chatSend 同链路发出首条目标 */
  onSendGoalMessage?: (prompt: string, sessionKey: string) => void | Promise<void>
}) {
  const sessionKeyRef = useRef(sessionKey)
  useEffect(() => { sessionKeyRef.current = sessionKey }, [sessionKey])

  const onGoalClosureReportRef = useRef(onGoalClosureReport)
  useEffect(() => { onGoalClosureReportRef.current = onGoalClosureReport }, [onGoalClosureReport])

  const onGoalRunningChangeRef = useRef(onGoalRunningChange)
  useEffect(() => { onGoalRunningChangeRef.current = onGoalRunningChange }, [onGoalRunningChange])

  const onRefreshChatHistoryRef = useRef(onRefreshChatHistory)
  useEffect(() => { onRefreshChatHistoryRef.current = onRefreshChatHistory }, [onRefreshChatHistory])

  const onGoalSendingChangeRef = useRef(onGoalSendingChange)
  useEffect(() => { onGoalSendingChangeRef.current = onGoalSendingChange }, [onGoalSendingChange])

  const onSendGoalMessageRef = useRef(onSendGoalMessage)
  useEffect(() => { onSendGoalMessageRef.current = onSendGoalMessage }, [onSendGoalMessage])

  const awaitingFrontendChatRef = useRef(false)
  const afterChatTurnInflightRef = useRef(false)
  const closureReportKeyRef = useRef('')
  const completionSummaryTimeoutRef = useRef<number | null>(null)
  const streamAttachInflightRef = useRef(false)

  const goalAttachAbortRef = useRef<AbortController | null>(null)

  const goalConfigRef = useRef<HostedSessionConfig | null>(null)
  const goalRuntimeRef = useRef(HOSTED_RUNTIME_DEFAULT)
  const goalSummaryRef = useRef('')
  const completionOutcomeRef = useRef('')
  const goalIdRef = useRef<string>('')
  const boundSessionKeyRef = useRef('')
  const lastPolledStepRef = useRef(0)
  const lastAttachedRunIdRef = useRef('')
  const startTimeRef = useRef<number>(0)
  const pushTargetsRef = useRef<PushTargetOption[]>([])
  const feishuPushConfiguredRef = useRef(false)
  const skillSupportRef = useRef<SkillSupport>({ loaded: false, evolution: false })

  const goalStatusRef = useRef<GoalStatus>('')
  const continuationSuppressedRef = useRef(false)
  const goalRevisionRef = useRef(1)
  const goalStartGraceUntilRef = useRef(0)
  const emptyByKeyStreakRef = useRef(0)
  const pollIntervalRef = useRef<number | null>(null)

  const [panelOpen, setPanelOpen] = useState(false)
  // @ts-ignore
  const [ui, setUi] = useState<HostedPanelUiState>({
    enabled: false,
    status: HOSTED_STATUS.IDLE,
    goalStatus: '',
    goalActive: false,
    continuationSuppressed: false,
    goalRevision: 1,
    prompt: '',
    lastError: '',
    isRunning: false,
    isExecuting: false,
    elapsedText: '0s',
    initiative: 60,
    emotionalIntelligence: true,
    continuousLearning: false,
    useEvolutionSkill: false,
    feishuPushOnComplete: false,
    pushChannel: '',
    pushTargetId: '',
    pushTargets: [],
    pushTargetsAvailable: false,
    feishuPushConfigured: false,
    skillSupport: { loaded: false, evolution: false },
    goalSummary: '',
    completionOutcome: '',
  })

  const elapsedIntervalRef = useRef<number | null>(null)

  const markHostedRunning = useCallback((sk: string, running: boolean) => {
    markSessionGoalRunning(sk, running)
  }, [])

  const log = useCallback((event: string, data?: any) => {
    if (!goalDebugEnabled()) return
    try { console.debug(`[hosted] ${event}`, data ?? '') } catch { /* ignore */ }
  }, [])

  /** 切换会话时立即清掉运行态绑定，避免 A 会话 Goal 显示在 B 会话。 */
  const resetHostedGoalViewState = useCallback((opts?: { keepPromptConfig?: boolean; previousSessionKey?: string }) => {
    // NOTE: Do NOT call markHostedRunning(prevSk, false) here — the previous
    // session's goal may still be running on the backend.  session-execution
    // hosted-state tracks *all* sessions with active goals for the 🤖 badge.
    // session's running flag when the backend actually reports the goal as completed /
    // idle (handled in syncFromBackendStatus).
    goalIdRef.current = ''
    boundSessionKeyRef.current = ''
    goalStatusRef.current = ''
    closureReportKeyRef.current = ''
    if (completionSummaryTimeoutRef.current != null) { window.clearTimeout(completionSummaryTimeoutRef.current); completionSummaryTimeoutRef.current = null }
    continuationSuppressedRef.current = false
    goalRevisionRef.current = 1
    awaitingFrontendChatRef.current = false
    afterChatTurnInflightRef.current = false
    lastPolledStepRef.current = 0
    lastAttachedRunIdRef.current = ''
    startTimeRef.current = 0
    goalRuntimeRef.current = { ...HOSTED_RUNTIME_DEFAULT }
    goalSummaryRef.current = ''
    completionOutcomeRef.current = ''
    if (!opts?.keepPromptConfig || !goalConfigRef.current) {
      goalConfigRef.current = {
        ...(HOSTED_DEFAULTS as any),
        state: { ...HOSTED_RUNTIME_DEFAULT },
      }
    } else {
      goalConfigRef.current.enabled = false
      goalConfigRef.current.state = { ...HOSTED_RUNTIME_DEFAULT }
    }
    setPanelOpen(false)
    setUi((prev) => ({
      ...prev,
      enabled: false,
      status: HOSTED_STATUS.IDLE,
      goalStatus: '',
      goalActive: false,
      continuationSuppressed: false,
      goalRevision: 1,
      lastError: '',
      isRunning: false,
      isExecuting: false,
      elapsedText: '0s',
    }))
  }, [markHostedRunning])

  const isGoalBoundToCurrentSession = useCallback(() => {
    const curSk = String(sessionKeyRef.current || '').trim()
    const boundSk = String(boundSessionKeyRef.current || '').trim()
    return !!curSk && !!boundSk && curSk === boundSk
  }, [])

  const saveDraftTimerRef = useRef<number | null>(null)

  const saveSettingsToBackend = useCallback(async (sk: string) => {
    const cfg = goalConfigRef.current
    const key = String(sk || '').trim()
    if (!cfg || !key) return
    const backendConfig = {
      prompt: String(cfg.prompt || ''),
      step_delay_ms: Math.max(200, parseInt(String(cfg.stepDelayMs || HOSTED_DEFAULTS.stepDelayMs), 10)),
      retry_limit: Math.max(0, parseInt(String(cfg.retryLimit || HOSTED_DEFAULTS.retryLimit), 10)),
      initiative: cfg.initiative,
      emotional_intelligence: cfg.emotionalIntelligence,
      feishu_push_on_complete: cfg.feishuPushOnComplete,
      push_channel: cfg.pushChannel,
      push_target_id: cfg.pushTargetId,
    }
    try {
      await evoflowInvokeGatewayJson(`/api/goal/settings-by-key/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: backendConfig }),
      })
    } catch (e: any) {
      log('settings:save-failed', { sk: key, msg: String(e?.message || '') })
    }
  }, [log])

  const persistConfig = useCallback(() => {
    const sk = String(sessionKeyRef.current || '').trim()
    if (!sk) return
    if (saveDraftTimerRef.current) window.clearTimeout(saveDraftTimerRef.current)
    saveDraftTimerRef.current = window.setTimeout(() => {
      void saveSettingsToBackend(sk)
    }, 400)
  }, [saveSettingsToBackend])

  const persistConfigForSk = useCallback((sk: string) => {
    if (!sk) return
    void saveSettingsToBackend(sk)
  }, [saveSettingsToBackend])

  const syncUiFromRefs = useCallback(() => {
    const cfg = goalConfigRef.current
    if (!cfg) return
    const rt = goalRuntimeRef.current
    const goalStatus = goalStatusRef.current
    const boundToCurrent = isGoalBoundToCurrentSession()
    const goalActive =
      boundToCurrent && isGoalActiveStatus(goalStatus)
    const isExecuting =
      boundToCurrent && (rt.status === HOSTED_STATUS.RUNNING || rt.status === HOSTED_STATUS.WAITING)
    // isRunning：目标仍活跃即视为「AI 仍在场」，含 PAUSED（判定器/续跑间隙）与 WAITING（待用户）。
    const isRunning = goalActive && rt.status !== HOSTED_STATUS.IDLE
    setUi((prev) => ({
      ...prev,
      enabled: goalActive,
      status: rt.status,
      goalStatus,
      goalActive,
      continuationSuppressed: continuationSuppressedRef.current,
      goalRevision: goalRevisionRef.current,
      prompt: cfg.prompt,
      personaStyle: cfg.personaStyle,
      initiative: cfg.initiative,
      emotionalIntelligence: cfg.emotionalIntelligence,
      continuousLearning: cfg.continuousLearning,
      useEvolutionSkill: cfg.useEvolutionSkill,
      feishuPushOnComplete: cfg.feishuPushOnComplete,
      pushChannel: cfg.pushChannel,
      pushTargetId: cfg.pushTargetId,
      pushTargets: pushTargetsRef.current,
      pushTargetsAvailable: feishuPushConfiguredRef.current,
      lastError: rt.lastError || '',
      goalSummary: goalSummaryRef.current,
      completionOutcome: completionOutcomeRef.current,
      isExecuting,
      isRunning,
    }))
  }, [isGoalBoundToCurrentSession])

  const stopPoll = useCallback(() => {
    if (pollIntervalRef.current != null) {
      window.clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    goalAttachAbortRef.current?.abort()
    goalAttachAbortRef.current = null
  }, [])

  const clearRunTimers = useCallback(() => {
    if (elapsedIntervalRef.current != null) { window.clearInterval(elapsedIntervalRef.current); elapsedIntervalRef.current = null }
    if (completionSummaryTimeoutRef.current != null) { window.clearTimeout(completionSummaryTimeoutRef.current); completionSummaryTimeoutRef.current = null }
  }, [])

  const clearTimers = useCallback(() => {
    stopPoll()
    clearRunTimers()
  }, [clearRunTimers, stopPoll])

  const startElapsedTicker = useCallback(() => {
    if (elapsedIntervalRef.current != null) window.clearInterval(elapsedIntervalRef.current)
    const tick = () => {
      const el = formatHostedElapsed(startTimeRef.current)
      setUi((prev) => (prev.elapsedText === el ? prev : { ...prev, elapsedText: el }))
    }
    tick()
    elapsedIntervalRef.current = window.setInterval(tick, 1000)
  }, [])

  const stopElapsedTicker = useCallback(() => {
    if (elapsedIntervalRef.current != null) { window.clearInterval(elapsedIntervalRef.current); elapsedIntervalRef.current = null }
  }, [])

  const tryAttachChatStream = useCallback(async (sk: string, reason = 'unknown') => {
    const key = String(sk || '').trim()
    const curSk = String(sessionKeyRef.current || '').trim()
    if (!key || curSk !== key) {
      goalStreamLog('attach:skip', { reason: 'session-key-mismatch', trigger: reason, sessionKey: key })
      return
    }
    if (streamAttachInflightRef.current) return
    streamAttachInflightRef.current = true
    goalStreamLog('attach:refresh-history-only', { trigger: reason, sessionKey: key })
    try {
      await onRefreshChatHistoryRef.current?.()
    } catch (e: any) {
      goalStreamLog('attach:error', {
        trigger: reason,
        sessionKey: key,
        error: String(e?.message || e || 'unknown'),
      })
    } finally {
      streamAttachInflightRef.current = false
    }
  }, [])

  const pollAttachChatStream = useCallback(async (sk: string) => {
    const key = String(sk || '').trim()
    const curSk = String(sessionKeyRef.current || '').trim()
    if (!key || curSk !== key) return
    goalStreamLog('poll-attach:refresh-history-only', { sessionKey: key })
    try {
      await onRefreshChatHistoryRef.current?.()
    } catch {
      /* ignore */
    }
  }, [])

  const emitGoalClosureReport = useCallback((sk: string, outcome: string, body: string, ts?: number) => {
    const key = String(sk || '').trim()
    const summary = String(body || '').trim()
    if (!key || !summary) return
    const dedupeKey = `${key}:${summary.slice(0, 120)}`
    if (closureReportKeyRef.current === dedupeKey) return
    closureReportKeyRef.current = dedupeKey
    onGoalClosureReportRef.current?.({ sessionKey: key, outcome, body: summary, ts })
  }, [])

  const syncFromBackendStatus = useCallback((data: any) => {
    const curSk = String(sessionKeyRef.current || '').trim()
    const dataSk = String(data?.associated_session_key || data?.associatedSessionKey || data?.sessionKey || '').trim()
    if (dataSk && curSk && dataSk !== curSk) {
      // Still update session-execution hosted-state so the session list shows the 🤖 badge
      // for other sessions that have an active goal, even when viewing a different session.
      const otherStatus = mapBackendStatus(String(data?.status || 'idle'))
      const otherGoalStatusRaw = mapGoalStatus(String(data?.goal_status || data?.goalStatus || ''))
      const otherHostedId = String(data?.id || data?.hostedId || '')
      const otherGoalActive =
        isGoalActiveStatus(otherGoalStatusRaw) ||
        (otherHostedId && (otherStatus === HOSTED_STATUS.RUNNING || otherStatus === HOSTED_STATUS.WAITING || otherStatus === HOSTED_STATUS.PAUSED))
      // @ts-ignore
      markHostedRunning(dataSk, otherGoalActive)
      goalStreamLog('sync:skip-session-mismatch-but-badge-updated', { curSk, dataSk, otherGoalActive })
      return
    }
    const boundSk = dataSk || String(boundSessionKeyRef.current || curSk || '').trim()
    const sk = boundSk || curSk
    const status = mapBackendStatus(String(data?.status || 'idle'))
    const stepCount = Number(data?.current_step || data?.stepCount || 0)
    const lastError = String(data?.last_error || data?.lastError || '')
    const pendingFeedback = !!data?.pending_feedback || !!data?.pending
    const hostedId = String(data?.id || data?.hostedId || '')
    const goalStatusRaw = mapGoalStatus(String(data?.goal_status || data?.goalStatus || ''))
    const continuationSuppressed = !!data?.continuation_suppressed || !!data?.continuationSuppressed
    const goalRevision = Number(data?.goal_revision || data?.goalRevision || 1)
    const goalSummary = String(data?.goal_summary || data?.goalSummary || '').trim()
    const completionOutcome = String(data?.completion_outcome || data?.completionOutcome || '').trim()
    if (goalSummary) goalSummaryRef.current = goalSummary
    if (completionOutcome) completionOutcomeRef.current = completionOutcome

    if (hostedId) goalIdRef.current = hostedId
    if (boundSk) boundSessionKeyRef.current = boundSk
    continuationSuppressedRef.current = continuationSuppressed
    goalRevisionRef.current = Math.max(1, goalRevision)

    const goalActive =
      isGoalActiveStatus(goalStatusRaw) ||
      (hostedId && (status === HOSTED_STATUS.RUNNING || status === HOSTED_STATUS.WAITING || status === HOSTED_STATUS.PAUSED))
    if (goalStatusRaw) goalStatusRef.current = goalStatusRaw
    else if (goalActive) {
      goalStatusRef.current = continuationSuppressed && status === HOSTED_STATUS.PAUSED ? 'paused' : 'active'
    }

    const prevStatus = goalRuntimeRef.current.status
    const inStartGrace = Date.now() < goalStartGraceUntilRef.current
    const polledStepCount = Number(stepCount) || 0
    if (
      inStartGrace &&
      goalIdRef.current &&
      goalStatusRaw === 'completed' &&
      isGoalActiveStatus(goalStatusRef.current || 'active') &&
      polledStepCount === 0
    ) {
      goalStreamLog('sync:ignore-stale-completed-during-start-grace', {
        sessionKey: sk,
        hostedId: goalIdRef.current,
        polledGoalStatus: goalStatusRaw,
        polledStepCount,
      })
      return
    }
    const isTerminal = !goalActive

    goalRuntimeRef.current = {
      ...goalRuntimeRef.current,
      status,
      stepCount,
      lastError,
      pending: pendingFeedback,
    }

    const cfg = goalConfigRef.current
    // @ts-ignore
    if (cfg) cfg.enabled = goalActive

    if (stepCount > lastPolledStepRef.current) {
      lastPolledStepRef.current = stepCount
      lastAttachedRunIdRef.current = ''
      void onRefreshChatHistoryRef.current?.()
    }

    syncUiFromRefs()

    // PAUSED = 目标判断中：本地流式 final 已落库，勿 dbOnly 全量 reload（会清掉尚未写库的 assistant 正文）
    if (goalActive && (status === HOSTED_STATUS.RUNNING || status === HOSTED_STATUS.WAITING)) {
      const curSk = String(sessionKeyRef.current || '').trim()
      if (curSk && curSk === boundSk) {
        goalStreamLog('sync:will-attach', {
          sessionKey: boundSk,
          hostedStatus: status,
          goalStatus: goalStatusRef.current,
          hostedId,
          stepCount,
        })
        void tryAttachChatStream(boundSk, 'sync-from-backend')
      } else {
        goalStreamLog('sync:attach-skipped-session-mismatch', {
          boundSk,
          selectedSessionKey: curSk,
          hostedStatus: status,
        })
      }
    }

    if (isTerminal) {
      stopElapsedTicker()
      clearRunTimers()
      startTimeRef.current = 0
      awaitingFrontendChatRef.current = false
      afterChatTurnInflightRef.current = false
      if (cfg) cfg.enabled = false
      const summaryForReport = goalSummaryRef.current || goalSummary
      const outcomeForReport = completionOutcomeRef.current || completionOutcome
      goalStatusRef.current = goalStatusRaw || ''
      continuationSuppressedRef.current = false
      goalIdRef.current = ''
      boundSessionKeyRef.current = ''
      goalRuntimeRef.current = { ...HOSTED_RUNTIME_DEFAULT, status, lastError, stepCount }
      syncUiFromRefs()
      onGoalRunningChangeRef.current?.(false, sk)
      markHostedRunning(sk, false)

      const shouldNotify =
        prevStatus !== HOSTED_STATUS.IDLE ||
        !!(summaryForReport || outcomeForReport)
      if (shouldNotify) {
        const outcome = outcomeForReport || (status === HOSTED_STATUS.ERROR ? '执行异常' : '任务完成')
        const goalLabel = cfg?.prompt?.slice(0, 80) || '目标任务'
        const reason =
          summaryForReport ||
          lastError ||
          (status === HOSTED_STATUS.ERROR ? '执行过程中发生错误' : `${goalLabel} · 共 ${stepCount} 轮`)
        if (prevStatus !== HOSTED_STATUS.IDLE) {
          toast(outcome, status === HOSTED_STATUS.ERROR ? 'error' : 'success')
          void notifyDesktopCompletion({
            title: 'EvoFlow · 目标完成',
            body: `${cfg?.prompt?.slice(0, 80) || '目标任务'}：${outcome}`,
            tag: `hosted:${sk}:done`,
          })
        }
        if (summaryForReport) {
          stopPoll()
          emitGoalClosureReport(sk, outcome, reason, resolveGoalClosureTimestamp(data))
        } else if (prevStatus !== HOSTED_STATUS.IDLE) {
          stopPoll()
          emitGoalClosureReport(sk, outcome, reason, resolveGoalClosureTimestamp(data))
        } else {
          stopPoll()
        }
      } else {
        stopPoll()
      }
    } else if (goalActive) {
      markHostedRunning(sk, true)
      const isExecuting = status === HOSTED_STATUS.RUNNING || status === HOSTED_STATUS.WAITING
      onGoalRunningChangeRef.current?.(isExecuting, sk)
    }
  }, [clearRunTimers, emitGoalClosureReport, markHostedRunning, stopElapsedTicker, stopPoll, syncUiFromRefs, tryAttachChatStream])

  const pollHostedStatus = useCallback(async (sk: string) => {
    const key = String(sk || '').trim()
    if (!key) return
    try {
      const data = await evoflowInvokeGatewayJson(`/api/goal/by-key/${encodeURIComponent(key)}`)
      if (data) {
        emptyByKeyStreakRef.current = 0
        goalStreamLog('poll:hosted-by-key', {
          sessionKey: key,
          hostedId: data?.id ?? null,
          status: data?.status ?? null,
          goalStatus: data?.goal_status ?? data?.goalStatus ?? null,
          currentStep: data?.current_step ?? null,
          associatedSessionKey: data?.associated_session_key ?? null,
        })
        syncFromBackendStatus(data)
      } else if (String(boundSessionKeyRef.current || '') === key) {
        emptyByKeyStreakRef.current += 1
        const inGrace = Date.now() < goalStartGraceUntilRef.current
        goalStreamLog('poll:hosted-by-key-empty', {
          sessionKey: key,
          inGrace,
          streak: emptyByKeyStreakRef.current,
          hostedId: goalIdRef.current,
        })
        if (inGrace || emptyByKeyStreakRef.current < 2) {
          return
        }
        const prevStatus = goalRuntimeRef.current.status
        const outcome = completionOutcomeRef.current || (prevStatus === HOSTED_STATUS.ERROR ? '执行异常' : '任务完成')
        const goalLabel = goalConfigRef.current?.prompt?.slice(0, 80) || '目标任务'
        const reason = goalSummaryRef.current || goalRuntimeRef.current.lastError || `${goalLabel} · 共 ${goalRuntimeRef.current.stepCount} 轮`
        goalIdRef.current = ''
        goalStatusRef.current = ''
        continuationSuppressedRef.current = false
        goalRuntimeRef.current = { ...HOSTED_RUNTIME_DEFAULT }
        goalSummaryRef.current = ''
        completionOutcomeRef.current = ''
        syncUiFromRefs()
        onGoalRunningChangeRef.current?.(false, key)
        markHostedRunning(key, false)
        stopPoll()
        if (prevStatus !== HOSTED_STATUS.IDLE) {
          emitGoalClosureReport(key, outcome, reason, resolveGoalClosureTimestamp({ last_run_at: goalRuntimeRef.current.lastRunAt }))
        } else if (reason) {
          emitGoalClosureReport(key, outcome, reason)
        }
      }
    } catch (e: any) {
      log('poll:error', { sk: key, msg: String(e?.message || '') })
    }
  }, [emitGoalClosureReport, log, markHostedRunning, stopPoll, syncFromBackendStatus, syncUiFromRefs])

  const startHostedPoll = useCallback((boundSk: string) => {
    const sk = String(boundSk || '').trim()
    if (!sk) return
    stopPoll()
    const tick = () => { void pollHostedStatus(sk) }
    tick()
    pollIntervalRef.current = window.setInterval(tick, HOSTED_STATUS_POLL_WAITING_MS)
  }, [pollHostedStatus, stopPoll])

  const loadGoalSessionConfig = useCallback(async () => {
    const sk = String(sessionKeyRef.current || '').trim()
    if (!sk) return

    // 加载前先断开运行态绑定（draft 配置随后从 API 覆盖）
    goalIdRef.current = ''
    boundSessionKeyRef.current = ''
    goalStatusRef.current = ''
    continuationSuppressedRef.current = false
    awaitingFrontendChatRef.current = false
    goalRuntimeRef.current = { ...HOSTED_RUNTIME_DEFAULT }
    goalSummaryRef.current = ''
    completionOutcomeRef.current = ''

    let data: any
    try {
      data = await evoflowInvokeGatewayJson(`/api/goal/settings-by-key/${encodeURIComponent(sk)}`)
    } catch {
      data = null
    }
    const cur = (data?.config && typeof data.config === 'object') ? data.config : {}
    const runtime = (data?.runtime && typeof data.runtime === 'object') ? data.runtime : HOSTED_RUNTIME_DEFAULT
    const cfg: HostedSessionConfig = {
      ...(HOSTED_DEFAULTS as any),
      ...(cur || {}),
      state: {
        ...HOSTED_RUNTIME_DEFAULT,
        status: mapBackendStatus(String(runtime.status || 'idle')),
        stepCount: Number(runtime.stepCount) || 0,
        lastRunAt: Number(runtime.lastRunAt) || 0,
        lastRunId: String(runtime.lastRunId || ''),
        lastError: String(runtime.lastError || ''),
        pending: Boolean(runtime.pending),
        errorCount: Number(runtime.errorCount) || 0,
      },
    }
    const configured = feishuPushConfiguredRef.current
    if (!configured) {
      cfg.feishuPushOnComplete = false
    } else if (!Object.prototype.hasOwnProperty.call(cur, 'feishuPushOnComplete')) {
      cfg.feishuPushOnComplete = true
    }
    cfg.pushChannel = String(cur.pushChannel || cur.push_channel || cfg.pushChannel || '')
    cfg.pushTargetId = String(cur.pushTargetId || cur.push_target_id || cfg.pushTargetId || '')
    if (cfg.feishuPushOnComplete && configured && !cfg.pushChannel && !cfg.pushTargetId) {
      const defaultKey = pickDefaultPushTargetKey(pushTargetsRef.current)
      if (defaultKey) {
        const parsed = parsePushTargetKey(defaultKey)
        cfg.pushChannel = parsed.channel
        cfg.pushTargetId = parsed.targetId
      }
    }
    goalConfigRef.current = cfg

    const gs = mapGoalStatus(String(data?.goalStatus || data?.goal_status || ''))
    const hid = String(data?.hostedSessionId || data?.hosted_session_id || '').trim()
    goalSummaryRef.current = String(data?.goalSummary || data?.goal_summary || data?.runtime?.goalSummary || '').trim()
    completionOutcomeRef.current = String(
      data?.completionOutcome || data?.completion_outcome || data?.runtime?.completionOutcome || '',
    ).trim()
    const goalActiveFromDb = isGoalActiveStatus(gs) && cfg.enabled
    if (goalActiveFromDb && hid) {
      goalStatusRef.current = gs
      goalIdRef.current = hid
      boundSessionKeyRef.current = sk
      continuationSuppressedRef.current = Boolean(data?.continuationSuppressed ?? data?.continuation_suppressed)
      goalRevisionRef.current = Number(data?.goalRevision ?? data?.goal_revision) || 1
      goalRuntimeRef.current = {
        ...HOSTED_RUNTIME_DEFAULT,
        status: mapBackendStatus(String(runtime.status || 'idle')),
        stepCount: Number(runtime.stepCount) || 0,
        lastRunAt: Number(runtime.lastRunAt) || 0,
        lastRunId: String(runtime.lastRunId || ''),
        lastError: String(runtime.lastError || ''),
        pending: Boolean(runtime.pending),
        errorCount: Number(runtime.errorCount) || 0,
      }
    } else {
      cfg.enabled = false
    }
    if (!goalActiveFromDb && gs === 'completed' && goalSummaryRef.current) {
      emitGoalClosureReport(
        sk,
        completionOutcomeRef.current || '任务完成',
        goalSummaryRef.current,
      )
    }
    syncUiFromRefs()
  }, [emitGoalClosureReport, syncUiFromRefs])

  const loadSkillSupport = useCallback(async () => {
    if (cachedSkillSupport) {
      skillSupportRef.current = cachedSkillSupport
      setUi((prev) => ({ ...prev, skillSupport: cachedSkillSupport! }))
      return
    }
    if (skillSupportInflight) {
      const support = await skillSupportInflight
      skillSupportRef.current = support
      setUi((prev) => ({ ...prev, skillSupport: support }))
      return
    }
    skillSupportInflight = (async () => {
      try {
        const mod = await import('../../lib/skill-catalog.js')
        const list = await mod.loadSkillCatalog()
        const has = (re: RegExp) => list.some((x) => re.test(String(x?.name || '').toLowerCase()))
        return { loaded: true, evolution: has(/evolution|self[-_ ]?evolution|持续进化|进化/) } satisfies SkillSupport
      } catch {
        return { loaded: true, evolution: false } satisfies SkillSupport
      }
    })()
    try {
      const support = await skillSupportInflight
      cachedSkillSupport = support
      skillSupportRef.current = support
      setUi((prev) => ({ ...prev, skillSupport: support }))
    } finally {
      skillSupportInflight = null
    }
  }, [])

  const startGoal = useCallback(async () => {
    const cfg = goalConfigRef.current
    if (!cfg) { toast('目标配置尚未加载完成，请稍后再试', 'warning'); return }
    const prompt = (cfg.prompt || '').trim()
    if (!prompt) { toast('请输入任务目标', 'warning'); return }
    const boundSk = String(sessionKeyRef.current || '').trim()
    if (!boundSk) { toast('请先选择或进入一个会话，再启动目标', 'warning'); return }

    const stepDelayMs = Math.max(200, parseInt(String(cfg.stepDelayMs || HOSTED_DEFAULTS.stepDelayMs), 10))
    const retryLimit = Math.max(0, parseInt(String(cfg.retryLimit || HOSTED_DEFAULTS.retryLimit), 10))

    cfg.enabled = true
    cfg.prompt = prompt
    cfg.stepDelayMs = stepDelayMs
    cfg.retryLimit = retryLimit
    await persistConfigForSk(boundSk)

    const backendConfig = {
      prompt,
      step_delay_ms: stepDelayMs,
      retry_limit: retryLimit,
      persona_style: cfg.personaStyle,
      initiative: cfg.initiative,
      emotional_intelligence: cfg.emotionalIntelligence,
      feishu_push_on_complete: cfg.feishuPushOnComplete,
      push_channel: cfg.pushChannel,
      push_target_id: cfg.pushTargetId,
    }

    try {
      goalStreamLog('start:request', { sessionKey: boundSk, promptLen: prompt.length })
      const data = await evoflowInvokeGatewayJson('/api/goal/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          associated_session_key: boundSk,
          config: backendConfig,
          channel_type: 'web',
          channel_chat_id: boundSk,
          use_frontend_chat: true,
        }),
      })
      goalStreamLog('start:ok', {
        sessionKey: boundSk,
        hostedId: data?.id ?? null,
        status: data?.status ?? null,
        goalStatus: data?.goal_status ?? data?.goalStatus ?? null,
        awaitingFrontendChat: data?.awaiting_frontend_chat ?? data?.awaitingFrontendChat ?? null,
      })
      goalStartGraceUntilRef.current = Date.now() + 30_000
      emptyByKeyStreakRef.current = 0
      goalIdRef.current = String(data?.id || '')
      boundSessionKeyRef.current = boundSk
      awaitingFrontendChatRef.current = !!(data?.awaiting_frontend_chat ?? data?.awaitingFrontendChat)
      goalStatusRef.current = 'active'
      continuationSuppressedRef.current = false
      goalRevisionRef.current = 1
      lastPolledStepRef.current = 0
      lastAttachedRunIdRef.current = ''
      goalRuntimeRef.current = {
        ...HOSTED_RUNTIME_DEFAULT,
        status: awaitingFrontendChatRef.current ? HOSTED_STATUS.WAITING : HOSTED_STATUS.RUNNING,
        lastRunAt: Date.now(),
      }
      startTimeRef.current = Date.now()
      cfg.enabled = true
      syncUiFromRefs()
      startElapsedTicker()
      onGoalRunningChangeRef.current?.(true, boundSk)
      markHostedRunning(boundSk, true)
      startHostedPoll(boundSk)
      // 后端已确认目标启动，立即关闭弹窗（不等聊天消息流式发送完成，否则弹窗会一直挂到流式结束）
      setPanelOpen(false)

      if (awaitingFrontendChatRef.current) {
        goalStreamLog('start:chat-send', { sessionKey: boundSk, promptLen: prompt.length })
        try {
          await onSendGoalMessageRef.current?.(prompt, boundSk)
        } catch (sendErr: any) {
          goalStreamLog('start:chat-send-error', {
            sessionKey: boundSk,
            error: String(sendErr?.message || sendErr || 'unknown'),
          })
          throw sendErr
        }
      } else {
        void onRefreshChatHistoryRef.current?.()
        void pollAttachChatStream(boundSk)
      }
      setPanelOpen(false)
      toast('目标已启动', 'success')
    } catch (e: any) {
      goalStreamLog('start:error', {
        sessionKey: boundSk,
        error: String(e?.message || e || 'unknown'),
      })
      cfg.enabled = false
      syncUiFromRefs()
      toast(`目标启动失败：${String(e?.message || '启动失败')}`, 'error')
    }
  }, [markHostedRunning, persistConfigForSk, pollAttachChatStream, startElapsedTicker, startHostedPoll, syncUiFromRefs])

  const notifyAfterFrontendChatTurn = useCallback(async (assistantText: string) => {
    const hostedId = goalIdRef.current
    const curSk = String(sessionKeyRef.current || '').trim()
    const boundSk = String(boundSessionKeyRef.current || '').trim()
    if (!hostedId || !awaitingFrontendChatRef.current || afterChatTurnInflightRef.current) return
    // 目标已结束（非 active/paused）时不再触发 after-chat-turn，避免普通对话误触发目标流程
    if (!isGoalActiveStatus(goalStatusRef.current)) {
      awaitingFrontendChatRef.current = false
      return
    }
    if (boundSk && curSk && boundSk !== curSk) {
      goalStreamLog('after-chat-turn:skip-session-mismatch', { curSk, boundSk, hostedId })
      return
    }
    afterChatTurnInflightRef.current = true
    try {
      goalStreamLog('after-chat-turn:request', {
        hostedId,
        textLen: String(assistantText || '').length,
      })
      await evoflowInvokeGatewayJson(`/api/goal/${encodeURIComponent(hostedId)}/after-chat-turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant_text: String(assistantText || '') }),
      })
      awaitingFrontendChatRef.current = false
      syncUiFromRefs()
      // @ts-ignore
      void startHostedPoll()
      goalStreamLog('after-chat-turn:ok', { hostedId })
    } catch (e: any) {
      goalStreamLog('after-chat-turn:error', {
        hostedId,
        error: String(e?.message || e || 'unknown'),
      })
    } finally {
      afterChatTurnInflightRef.current = false
    }
  }, [pollAttachChatStream, startHostedPoll, syncUiFromRefs])

  const hostedApiPost = useCallback(async (path: string) => {
    const hostedId = goalIdRef.current
    if (!hostedId) return false
    try {
      await evoflowInvokeGatewayJson(`/api/goal/${encodeURIComponent(hostedId)}${path}`, { method: 'POST' })
      return true
    } catch {
      return false
    }
  }, [])

  const endGoal = useCallback(async (opts?: { reason?: string; detail?: string; sk?: string }) => {
    const targetSk = String(opts?.sk || sessionKeyRef.current || boundSessionKeyRef.current || '').trim()
    const reason = opts?.reason || '用户结束目标'
    const detail = opts?.detail || ''
    const cfg = goalConfigRef.current
    const capturedStepCount = goalRuntimeRef.current.stepCount

    const hostedId = goalIdRef.current
    if (hostedId) {
      try {
        await evoflowInvokeGatewayJson(`/api/goal/${encodeURIComponent(hostedId)}/end`, { method: 'POST' })
      } catch { /* ignore */ }
    }

    if (cfg) cfg.enabled = false
    goalIdRef.current = ''
    boundSessionKeyRef.current = ''
    goalStatusRef.current = ''
    continuationSuppressedRef.current = false
    lastPolledStepRef.current = 0
    goalRuntimeRef.current = { ...HOSTED_RUNTIME_DEFAULT }
    goalSummaryRef.current = ''
    completionOutcomeRef.current = ''
    startTimeRef.current = 0
    clearTimers()
    stopElapsedTicker()
    syncUiFromRefs()
    onGoalRunningChangeRef.current?.(false, targetSk)
    markHostedRunning(targetSk, false)

    const userStopped = reason === '用户停止目标'
    const toastDone = !userStopped && /完成|结束|达到最大|定时|时间|调度|任务/.test(reason)
    toast(userStopped ? '目标已停止' : '目标已结束', toastDone ? 'success' : 'info')
    if (toastDone) {
      const goalLabel = cfg?.prompt ? cfg.prompt.slice(0, 80) : '目标任务'
      void notifyDesktopCompletion({
        title: 'EvoFlow · 目标完成',
        body: `${goalLabel}：${reason}`,
        tag: `hosted:${targetSk}:done`,
      })
    }
    if (opts !== undefined) {
      const closureBody = detail || `${cfg?.prompt?.slice(0, 80) || '目标任务'} · 共 ${capturedStepCount} 轮`
      emitGoalClosureReport(targetSk, reason, closureBody)
    }
  }, [clearTimers, emitGoalClosureReport, markHostedRunning, stopElapsedTicker, syncUiFromRefs])

  const stopGoal = useCallback(async () => {
    const hostedId = goalIdRef.current
    const rt = goalRuntimeRef.current
    const isExecuting = rt.status === HOSTED_STATUS.RUNNING || rt.status === HOSTED_STATUS.WAITING
    if (hostedId && isExecuting) {
      await hostedApiPost('/stop').catch(() => false)
    }
    await endGoal({ reason: '用户停止目标' })
  }, [endGoal, hostedApiPost])

  const startGoalWithPrompt = useCallback(async (prompt: string) => {
    const g = String(prompt || '').trim()
    if (!g) { toast('请输入任务目标', 'warning'); return }
    if (!goalConfigRef.current) await loadGoalSessionConfig()
    const cfg = goalConfigRef.current
    if (!cfg) { toast('目标配置加载失败，请稍后再试', 'warning'); return }
    cfg.prompt = g
    const sk = String(sessionKeyRef.current || '').trim()
    if (sk) await persistConfigForSk(sk)
    syncUiFromRefs()
    await startGoal()
  }, [loadGoalSessionConfig, persistConfigForSk, startGoal, syncUiFromRefs])

  const applyGoalProposal = useCallback(
    (proposal: ThreadGoalProposal, opts?: { start?: boolean }) => {
      void (async () => {
        if (!goalConfigRef.current) await loadGoalSessionConfig()
        const cfg = goalConfigRef.current
        if (!cfg) { toast('目标配置加载失败，请稍后再试', 'warning'); return }
        const g = (proposal.goal || '').trim()
        if (!g) { toast('目标方案缺少任务目标', 'warning'); return }
        cfg.prompt = g
        // @ts-ignore
        const ps = proposal.personaStyle
        if (ps === 'warm' || ps === 'professional' || ps === 'lively' || ps === 'calm') cfg.personaStyle = ps
        if (typeof proposal.stepDelayMs === 'number') cfg.stepDelayMs = Math.max(200, Math.min(120_000, Math.round(proposal.stepDelayMs)))
        if (typeof proposal.retryLimit === 'number') cfg.retryLimit = Math.max(0, Math.min(20, Math.round(proposal.retryLimit)))
        if (typeof proposal.useEvolutionSkill === 'boolean') cfg.useEvolutionSkill = proposal.useEvolutionSkill
        if (typeof proposal.feishuPushOnComplete === 'boolean') {
          cfg.feishuPushOnComplete = feishuPushConfiguredRef.current ? proposal.feishuPushOnComplete : false
        }
        if (typeof proposal.pushChannel === 'string') cfg.pushChannel = proposal.pushChannel
        if (typeof proposal.pushTargetId === 'string') cfg.pushTargetId = proposal.pushTargetId
        if (cfg.feishuPushOnComplete && feishuPushConfiguredRef.current && !cfg.pushChannel && !cfg.pushTargetId) {
          const defaultKey = pickDefaultPushTargetKey(pushTargetsRef.current)
          if (defaultKey) {
            const parsed = parsePushTargetKey(defaultKey)
            cfg.pushChannel = parsed.channel
            cfg.pushTargetId = parsed.targetId
          }
        }
        const sk = String(sessionKeyRef.current || '').trim()
        if (sk) await persistConfigForSk(sk)
        syncUiFromRefs()
        setPanelOpen(true)
        if (opts?.start) void startGoal()
      })()
    },
    [loadGoalSessionConfig, persistConfigForSk, startGoal, syncUiFromRefs],
  )

  const setDraft = useCallback((next: Partial<Pick<HostedSessionConfig, 'prompt' | 'initiative' | 'emotionalIntelligence' | 'continuousLearning' | 'useEvolutionSkill' | 'feishuPushOnComplete' | 'pushChannel' | 'pushTargetId'>> & { pushTargetKey?: string }) => {
    const cfg = goalConfigRef.current
    if (!cfg) return
    if (typeof next.prompt === 'string') cfg.prompt = next.prompt
    if (typeof next.initiative === 'number') cfg.initiative = Math.max(0, Math.min(100, next.initiative))
    if (typeof next.emotionalIntelligence === 'boolean') cfg.emotionalIntelligence = next.emotionalIntelligence
    if (typeof next.continuousLearning === 'boolean') cfg.continuousLearning = next.continuousLearning
    if (typeof next.useEvolutionSkill === 'boolean') cfg.useEvolutionSkill = next.useEvolutionSkill
    if (typeof next.pushTargetKey === 'string') {
      const parsed = parsePushTargetKey(next.pushTargetKey)
      cfg.pushChannel = parsed.channel
      cfg.pushTargetId = parsed.targetId
    }
    if (typeof next.pushChannel === 'string') cfg.pushChannel = next.pushChannel
    if (typeof next.pushTargetId === 'string') cfg.pushTargetId = next.pushTargetId
    if (typeof next.feishuPushOnComplete === 'boolean') {
      if (!feishuPushConfiguredRef.current && next.feishuPushOnComplete) return
      cfg.feishuPushOnComplete = next.feishuPushOnComplete
      if (next.feishuPushOnComplete && !cfg.pushChannel && !cfg.pushTargetId) {
        const defaultKey = pickDefaultPushTargetKey(pushTargetsRef.current)
        if (defaultKey) {
          const parsed = parsePushTargetKey(defaultKey)
          cfg.pushChannel = parsed.channel
          cfg.pushTargetId = parsed.targetId
        }
      }
      if (!next.feishuPushOnComplete) {
        cfg.pushChannel = ''
        cfg.pushTargetId = ''
      }
    }
    persistConfig()
    syncUiFromRefs()
  }, [persistConfig, syncUiFromRefs])

  const onUserClarificationSubmitted = useCallback(async (answerText: string) => {
    const cfg = goalConfigRef.current
    if (!cfg?.enabled) return
    const hostedId = goalIdRef.current
    if (!hostedId) return
    try {
      await evoflowInvokeGatewayJson(`/api/goal/${encodeURIComponent(hostedId)}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: answerText }),
      })
      void onRefreshChatHistoryRef.current?.()
    } catch (e: any) {
      toast(`反馈提交失败：${String(e?.message || '提交失败')}`, 'error')
    }
  }, [])

  /** 手动刷新目标状态（侧栏刷新按钮调用）：重新加载配置 + 拉取最新运行时 + 确保 poll */
  const refreshGoalStatus = useCallback(async (sk?: string) => {
    const key = String(sk || sessionKeyRef.current || '').trim()
    if (!key) return
    goalStreamLog('refresh-hosted-status', { sessionKey: key })
    await loadGoalSessionConfig()
    if (String(sessionKeyRef.current || '').trim() !== key) return
    try {
      const data = await evoflowInvokeGatewayJson(`/api/goal/by-key/${encodeURIComponent(key)}`)
      if (String(sessionKeyRef.current || '').trim() !== key) return
      if (data) {
        syncFromBackendStatus(data)
        if (shouldStartHostedPollFromBackend(data)) {
          const hostedId = String(data?.id || '')
          if (hostedId) goalIdRef.current = hostedId
          boundSessionKeyRef.current = key
          startTimeRef.current = Number(data?.created_at || 0) * 1000 || Date.now()
          startElapsedTicker()
          startHostedPoll(key)
        }
      } else {
        goalIdRef.current = ''
        boundSessionKeyRef.current = ''
        goalStatusRef.current = ''
        goalRuntimeRef.current = { ...HOSTED_RUNTIME_DEFAULT }
        goalSummaryRef.current = ''
        completionOutcomeRef.current = ''
        const cfg = goalConfigRef.current
        if (cfg) cfg.enabled = false
        syncUiFromRefs()
        markHostedRunning(key, false)
      }
    } catch {
      /* ignore */
    }
  }, [loadGoalSessionConfig, syncFromBackendStatus, startElapsedTicker, startHostedPoll, syncUiFromRefs, markHostedRunning])

  useEffect(() => {
    let cancelled = false
    const sk = String(sessionKey || '').trim()
    if (!sk) {
      // Defer state updates to avoid cascading renders
      requestAnimationFrame(() => {
        if (!cancelled) resetHostedGoalViewState()
      })
      return
    }

    const prevBound = String(boundSessionKeyRef.current || '').trim()
    if (prevBound && prevBound !== sk) {
      stopPoll()
      stopElapsedTicker()
    }
    // Defer state updates to avoid cascading renders
    requestAnimationFrame(() => {
      if (!cancelled) resetHostedGoalViewState({ keepPromptConfig: false })
    })

    void (async () => {
      try {
        await loadGoalSessionConfig()
        if (cancelled || String(sessionKeyRef.current || '').trim() !== sk) return

        const data = await evoflowInvokeGatewayJson(`/api/goal/by-key/${encodeURIComponent(sk)}`)
        if (cancelled || String(sessionKeyRef.current || '').trim() !== sk) return

        if (data) {
          syncFromBackendStatus(data)
          if (shouldStartHostedPollFromBackend(data)) {
            const hostedId = String(data?.id || '')
            if (hostedId) goalIdRef.current = hostedId
            boundSessionKeyRef.current = sk
            startTimeRef.current = Number(data?.created_at || 0) * 1000 || Date.now()
            startElapsedTicker()
            startHostedPoll(sk)
          }
        } else {
          goalIdRef.current = ''
          boundSessionKeyRef.current = ''
          goalStatusRef.current = ''
          goalRuntimeRef.current = { ...HOSTED_RUNTIME_DEFAULT }
          goalSummaryRef.current = ''
          completionOutcomeRef.current = ''
          const cfg = goalConfigRef.current
          if (cfg) cfg.enabled = false
          syncUiFromRefs()
          markHostedRunning(sk, false)
        }
      } catch {
        if (!cancelled && String(sessionKeyRef.current || '').trim() === sk) {
          resetHostedGoalViewState({ keepPromptConfig: true })
        }
      }
    })()

    void (async () => {
      let targets: PushTargetOption[] = []
      let configured = false
      try {
        const mod = await import('../../lib/tauri-api.js')
        const d = await mod.api.automationFeishuPushDefault()
        configured = !!(d?.configured || (Array.isArray(d?.targets) && d.targets.length))
        targets = Array.isArray(d?.targets) ? d.targets : []
      } catch {
        configured = false
        targets = []
      }
      if (cancelled) return
      pushTargetsRef.current = targets
      feishuPushConfiguredRef.current = configured
      setUi((p) => ({
        ...p,
        pushTargets: targets,
        pushTargetsAvailable: configured,
        feishuPushConfigured: configured,
      }))
      const cfg = goalConfigRef.current
      if (cfg && !configured) {
        cfg.feishuPushOnComplete = false
        cfg.pushChannel = ''
        cfg.pushTargetId = ''
      } else if (cfg?.feishuPushOnComplete && configured && !cfg.pushChannel && !cfg.pushTargetId) {
        const defaultKey = pickDefaultPushTargetKey(targets)
        if (defaultKey) {
          const parsed = parsePushTargetKey(defaultKey)
          cfg.pushChannel = parsed.channel
          cfg.pushTargetId = parsed.targetId
          syncUiFromRefs()
        }
      }
    })()

    return () => {
      cancelled = true
      const boundSk = String(boundSessionKeyRef.current || '').trim()
      if (String(sessionKey || '').trim() !== boundSk) {
        stopElapsedTicker()
        stopPoll()
      }
    }
  }, [
    sessionKey,
    loadGoalSessionConfig,
    resetHostedGoalViewState,
    syncFromBackendStatus,
    startHostedPoll,
    startElapsedTicker,
    stopElapsedTicker,
    stopPoll,
    syncUiFromRefs,
    markHostedRunning,
  ])

  useEffect(() => {
    // Defer to avoid cascading renders
    requestAnimationFrame(() => {
      void loadSkillSupport()
    })
  }, [loadSkillSupport])
  useEffect(() => () => { clearTimers() }, [clearTimers])

  const statusText = useMemo(() => {
    if (!ui.goalActive) return '未启用'
    const elapsedSuffix = ui.elapsedText ? ` · ${ui.elapsedText}` : ''
    if (ui.status === HOSTED_STATUS.ERROR) {
      return ui.lastError ? `异常: ${ui.lastError}${elapsedSuffix}` : `异常${elapsedSuffix}`
    }
    if (ui.isExecuting) return `运行中${elapsedSuffix}`
    if (ui.status === HOSTED_STATUS.PAUSED) return `目标判断中${elapsedSuffix}`
    if (ui.status === HOSTED_STATUS.WAITING) return `等待你回复${elapsedSuffix}`
    return `目标进行中${elapsedSuffix}`
  }, [ui.goalActive, ui.isExecuting, ui.status, ui.elapsedText, ui.lastError])

  return {
    goal: {
      panelOpen,
      setPanelOpen,
      ui,
      statusText,
      goalStatusIcon: iconForGoalUi(ui.goalActive, ui.isExecuting, ui.status),
      setDraft,
      startGoal,
      startGoalWithPrompt,
      stopGoal,
      applyGoalProposal,
      handleGoalStateEvent: syncFromBackendStatus,
      refreshGoalStatus,
    },
    goalCapture: {
      onChatFinal: async (_payload: unknown, assistantText: string) => {
        if (!awaitingFrontendChatRef.current) return
        await notifyAfterFrontendChatTurn(String(assistantText || ''))
      },
      onTargetAssistantText: async (assistantText: string) => {
        if (!awaitingFrontendChatRef.current) return
        const text = String(assistantText || '').trim()
        if (!text) return
        await notifyAfterFrontendChatTurn(text)
      },
      onUserClarificationSubmitted,
    },
  }
}
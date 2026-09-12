import { useEffect, useRef, useState } from 'react'
import { loadBoundPlanFromApi } from '../../lib/plan-from-api.js'
import { planViewFromStructuredInput } from '../../lib/plan-from-task.js'
import { promptSaveTaskAsApp } from '../../lib/save-task-as-app.js'
import { PlanDetailModal } from './PlanDetailModal.js'
import type { StructuredPlanInput } from './PlanDetailView.js'
import type { CollabSubtaskSnapshot } from '../chat-types.js'

export type PlanExecConfirmProps = {
  taskId: string
  taskName?: string
  planTitle?: string
  subtaskCount: number
  /** 仅「待启动」等可授权态显示 */
  showStartExecution?: boolean
  statusLabel?: string
  /** 流式/工具回退；展示以 GET /tasks?session_key=… 为准 */
  planStructuredFallback?: StructuredPlanInput | null
  /** 父级已从 API 同步正文时跳过组件内 listTasks(session_key) */
  skipApiFetch?: boolean
  syncedSubtasks?: CollabSubtaskSnapshot[]
  /** 聊天 session_key（计划查询主键） */
  sessionKey?: string
  /** 仅禁用「开始执行」；「查看计划」永不 disabled */
  busy?: boolean
  /** 仅展示「查看计划」（执行中/已完成/已点过开始执行后） */
  viewPlanOnly?: boolean
  /** 用户手动关闭面板，本任务不再弹出 */
  onDismiss?: (taskId: string) => void
  onStartExecution: (taskId: string) => void
}

function planFallbackContentSig(fallback: StructuredPlanInput | null | undefined): string {
  if (!fallback) return ''
  const steps = Array.isArray(fallback.steps) ? fallback.steps : []
  return [
    String(fallback.goal || '').trim(),
    steps.length,
    String(fallback.flowchartMermaid || '').trim(),
    String(fallback.openQuestions || '').trim(),
  ].join('|')
}

/** 计划定稿后：挂在 plan 工具块外部的执行确认条（正文来自 GET /tasks?session_key=…） */
export function PlanExecConfirm({
  taskId,
  taskName,
  planTitle,
  subtaskCount,
  showStartExecution = false,
  statusLabel,
  planStructuredFallback,
  skipApiFetch = false,
  syncedSubtasks: _syncedSubtasks,
  sessionKey,
  busy,
  viewPlanOnly = false,
  onDismiss,
  onStartExecution,
}: PlanExecConfirmProps) {
  const [apiPlan, setApiPlan] = useState<StructuredPlanInput | null>(null)
  const [apiLoading, setApiLoading] = useState(false)
  const [apiError, setApiError] = useState('')
  const [planModalOpen, setPlanModalOpen] = useState(false)
  const [planModalData, setPlanModalData] = useState<StructuredPlanInput | null>(null)
  const [planModalLoading, setPlanModalLoading] = useState(false)
  const [planModalError, setPlanModalError] = useState('')
  const [resolvedTaskId, setResolvedTaskId] = useState('')
  const [savingAsApp, setSavingAsApp] = useState(false)
  const lastFetchKeyRef = useRef('')
  const planStructuredFallbackRef = useRef(planStructuredFallback)

  useEffect(() => {
    planStructuredFallbackRef.current = planStructuredFallback
  }, [planStructuredFallback])

  const hintTaskId = String(taskId || '').trim()
  const sk = String(sessionKey || '').trim()
  const fallbackSig = planFallbackContentSig(planStructuredFallback)
  const hasInlinePlan = !!(
    planStructuredFallback?.goal &&
    Array.isArray(planStructuredFallback.steps) &&
    planStructuredFallback.steps.length > 0
  )

  useEffect(() => {
    const fallback = planStructuredFallbackRef.current ?? null
    if (!sk) {
      queueMicrotask(() => {
        setApiPlan(null)
        setApiError(hintTaskId ? '暂时无法加载计划，请稍后重试' : '')
        setResolvedTaskId(hintTaskId)
        setApiLoading(false)
      })
      return
    }

    if (skipApiFetch && hasInlinePlan && fallback) {
      setApiPlan(fallback)
      setResolvedTaskId(hintTaskId)
      setApiError('')
      setApiLoading(false)
      lastFetchKeyRef.current = `${sk}:${hintTaskId}:${fallbackSig}:preloaded`
      return
    }

    const fetchKey = `${sk}:${hintTaskId}:${fallbackSig}`
    if (lastFetchKeyRef.current === fetchKey) return
    lastFetchKeyRef.current = fetchKey

    if (fallback?.goal) {
      setApiPlan((prev) => prev || fallback)
      setApiError('')
    }

    let cancelled = false
    if (!hasInlinePlan) setApiLoading(true)

    void loadBoundPlanFromApi({
      sessionKey: sk,
      hintTaskId,
      fallback,
    })
      .then(({ plan, taskId: tidFromApi }) => {
        if (cancelled) return
        setApiPlan(plan)
        setResolvedTaskId(tidFromApi || hintTaskId)
        if (!plan) {
          setApiError('暂时无法加载计划，请稍后重试')
        } else {
          setApiError('')
        }
      })
      .catch((e) => {
        if (cancelled) return
        setApiPlan((prev) => prev || fallback || null)
        setResolvedTaskId(hintTaskId)
        setApiError(String((e as Error).message || e) || '按 session 加载计划失败')
      })
      .finally(() => {
        if (!cancelled) setApiLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sk, hintTaskId, fallbackSig, hasInlinePlan, skipApiFetch])

  const fallbackPlan = planViewFromStructuredInput(planStructuredFallback ?? null)
  const displayPlan = planViewFromStructuredInput(apiPlan ?? planStructuredFallback ?? null)
  const nm = String(planTitle || displayPlan?.goal || taskName || '').trim() || '当前主任务'
  const canStart = !!showStartExecution && !viewPlanOnly
  const pillText = String(statusLabel || '').trim() || (canStart ? '待启动' : '')
  const isExecuting = pillText.includes('执行中')
  const showReviseHint = !isExecuting
  const stepCount = displayPlan?.steps?.length ?? 0
  const hasInlineBody = !!(displayPlan?.goal && stepCount > 0)
  const effectiveTaskId = resolvedTaskId || hintTaskId

  function closePlanModal() {
    setPlanModalOpen(false)
    setPlanModalData(null)
    setPlanModalLoading(false)
    setPlanModalError('')
  }

  function buildPlanModalPayload(
    parsed: ReturnType<typeof planViewFromStructuredInput>,
    structured: StructuredPlanInput | null | undefined,
  ): StructuredPlanInput | null {
    if (!parsed?.goal) return null
    return {
      goal: parsed.goal,
      flowchartMermaid: String(
        parsed.flowchartMermaid || structured?.flowchartMermaid || '',
      ).trim(),
      steps: (parsed.steps ?? structured?.steps) as StructuredPlanInput['steps'],
      validation: parsed.validation,
      openQuestions: parsed.openQuestions,
    }
  }

  function openPlanDetailModal() {
    const parsed = displayPlan || fallbackPlan
    const structured = apiPlan ?? planStructuredFallback ?? null
    const immediate = buildPlanModalPayload(parsed, structured) ?? parsed
    setPlanModalOpen(true)
    setPlanModalError('')
    if (immediate?.goal) {
      setPlanModalData(immediate)
      setPlanModalLoading(false)
      return
    }
    if (!sk) {
      setPlanModalData(immediate)
      setPlanModalLoading(false)
      if (!immediate) {
        setPlanModalError('暂无计划正文，请稍候或刷新页面')
      }
      return
    }
    setPlanModalLoading(true)
    setPlanModalData(immediate)
    void loadBoundPlanFromApi({
      sessionKey: sk,
      hintTaskId,
      fallback: planStructuredFallback ?? null,
    })
      .then(({ plan }) => {
        if (plan) {
          setPlanModalData(plan)
          setPlanModalError('')
        } else {
          setPlanModalError(`session ${sk} 下无计划数据`)
        }
      })
      .catch((e) => {
        setPlanModalError(String((e as Error).message || e) || '加载计划失败')
        if (fallbackPlan) setPlanModalData(fallbackPlan)
      })
      .finally(() => setPlanModalLoading(false))
  }

  const canSaveAsApp = !!(effectiveTaskId && (hasInlineBody || stepCount > 0 || subtaskCount > 0))

  function handleSaveAsApp() {
    const tid = String(effectiveTaskId || taskId || '').trim()
    if (!tid || savingAsApp) return
    setSavingAsApp(true)
    promptSaveTaskAsApp({
      taskId: tid,
      defaultName: String(taskName || planTitle || displayPlan?.goal || '').trim(),
      defaultDescription: String(displayPlan?.goal || '').trim(),
    })
    // Modal is fire-and-forget; clear busy after open so button stays usable if cancelled.
    window.setTimeout(() => setSavingAsApp(false), 400)
  }

  const planModalNode = (
    <PlanDetailModal
      open={planModalOpen}
      loading={planModalLoading && !planModalData?.goal}
      error={planModalError && !planModalData?.goal ? planModalError : ''}
      plan={planModalData}
      onClose={closePlanModal}
    />
  )

  return (
    <>
      <div className="react-chat-plan-exec-strip" role="region" aria-label="计划执行确认">
        <div className="react-chat-plan-exec-strip-accent" aria-hidden="true" />
        <div className="react-chat-plan-exec-strip-inner">
          <div className="react-chat-plan-exec-strip-main">
            <span className="react-chat-plan-exec-strip-kicker">
              {canStart ? '计划已定稿' : '计划状态'}
            </span>
            <p className="react-chat-plan-exec-strip-title" title={nm}>
              {nm}
            </p>
            {!apiLoading && hasInlineBody && displayPlan?.goal && displayPlan.goal !== nm ? (
              <p className="react-chat-plan-exec-strip-preview" title={displayPlan.goal}>
                {displayPlan.goal}
              </p>
            ) : null}
            {!apiLoading && apiError && !hasInlineBody ? (
              <p className="react-chat-plan-exec-strip-preview react-chat-plan-exec-strip-preview--warn">
                {apiError}
              </p>
            ) : null}
            <div className="react-chat-plan-exec-strip-meta">
              {pillText ? (
                <span className="react-chat-plan-exec-strip-pill react-chat-plan-exec-strip-pill--muted">
                  {pillText}
                </span>
              ) : null}
              {stepCount > 0 ? (
                <span className="react-chat-plan-exec-strip-pill">{stepCount} 个步骤</span>
              ) : subtaskCount > 0 ? (
                <span className="react-chat-plan-exec-strip-pill">{subtaskCount} 个子任务</span>
              ) : null}
              {showReviseHint ? (
                <span className="react-chat-plan-exec-strip-hint">
                  修改请直接在下方输入框说明
                </span>
              ) : null}
            </div>
          </div>
          <div className="react-chat-plan-exec-strip-actions">
            {canStart && onDismiss ? (
              <button
                type="button"
                className="btn btn-ghost sm react-chat-plan-dismiss-btn"
                onClick={() => {
                  const tid = String(effectiveTaskId || taskId || '').trim()
                  if (tid) onDismiss(tid)
                }}
                title="关闭并本任务不再提示"
              >
                不再提示
              </button>
            ) : null}
            {canSaveAsApp ? (
              <button
                type="button"
                className="btn btn-ghost sm react-chat-plan-save-app-btn"
                disabled={savingAsApp}
                title="将当前计划沉淀为可填参复用的工作流"
                onClick={() => handleSaveAsApp()}
              >
                另存为工作流
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost sm react-chat-plan-view-btn"
              aria-disabled={false}
              onClick={() => void openPlanDetailModal()}
            >
              查看计划
            </button>
            {canStart ? (
              <button
                type="button"
                className="btn btn-primary sm"
                disabled={!!busy}
                aria-busy={!!busy}
                onClick={() => {
                  if (busy) return
                  closePlanModal()
                  onStartExecution(effectiveTaskId)
                }}
              >
                {busy ? '启动中…' : '开始执行'}
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {planModalNode}
    </>
  )
}

/** @deprecated 请使用输入区上方的 PlanExecConfirm（bottom dock） */
export function PlanExecConfirmDock(props: PlanExecConfirmProps) {
  return <PlanExecConfirm {...props} />
}

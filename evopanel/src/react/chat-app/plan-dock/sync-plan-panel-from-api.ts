/**
 * syncPlanPanelFromApi implementation — extracted from ChatApp (P14).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { StructuredPlanInput } from '../../components/PlanDetailView.js'
import { collabSnapshotFromTaskRow } from '../../../lib/ws-client.js'
import { computePlanExecStripUi, resolvePlanBoundTaskId } from '../../../lib/plan-exec-ui.js'
import { syncPlanDockStateFromApi } from '../../../lib/plan-from-api.js'
import { planDockApiHide, planDockApiShow, tracePlanDockApi } from '../../../lib/plan-dock-api.js'
import type { PlanDockApiView, PlanPanelHit, PlanStreamLatch } from './types.js'
import type { CollabSubtaskSnapshot, CollabTaskSnapshot, ThreadPanelState } from '../../chat-types.js'

export type SyncPlanPanelFromApiOpts = {
  source: string
  sessionKey?: string
  hintTaskId?: string
  preview?: string
  fallback?: Record<string, unknown> | null
  planOutput?: Record<string, unknown> | null
  boundPlanReady?: boolean
  bypassCache?: boolean
  openSidebar?: boolean
}

export type SyncPlanPanelFromApiCtx = {
  sessionRef: MutableRefObject<string>
  selectedSessionKey: string
  sessionTasksFetchSeqRef: MutableRefObject<number>
  planAppliedForRef: MutableRefObject<string>
  planFromApiLoadedRef: MutableRefObject<string>
  planApiSyncInflightRef: MutableRefObject<Promise<void> | null>
  planDockApiViewRef: MutableRefObject<PlanDockApiView | null>
  planStreamLatchRef: MutableRefObject<PlanStreamLatch>
  lastPlanPanelHitRef: MutableRefObject<PlanPanelHit | null>
  threadCollabSnapshotRef: MutableRefObject<string>
  suppressedPlanExecDockKeysRef: MutableRefObject<Set<string>>
  userAuthorizedTaskIdsRef: MutableRefObject<Set<string>>
  threadPanelState: {
    collabSubtasks?: CollabSubtaskSnapshot[] | null
    collabTask?: CollabTaskSnapshot | null
    collabPhase?: string | null
  }
  isActiveSessionFetch: (sessionKey: string, fetchSeq: number) => boolean
  applyPlanDockApiView: (view: PlanDockApiView) => void
  applyTaskProgressSnapshot: (
    snap: Record<string, unknown> | null,
    opts?: { sessionKey?: string },
  ) => void
  publishPlanPanelHit: (hit: PlanPanelHit | null) => void
  setPlanStreamLatched: Dispatch<SetStateAction<boolean>>
  setPlanPanelHit: Dispatch<SetStateAction<PlanPanelHit | null>>
  setThreadPanelState: Dispatch<SetStateAction<ThreadPanelState>>
  setBoundTaskId: Dispatch<SetStateAction<string | null>>
  openSessionSidebar: () => void
  suppressPlanExecDock: (taskId: string) => void
  isPlanExecDockSuppressed: (taskId: string, subCount: number) => boolean
  planExecSuppressToken: (taskId: string) => string
  bumpSubtasksApiRefresh: () => void
}

export async function syncPlanPanelFromApi(
  ctx: SyncPlanPanelFromApiCtx,
  opts: SyncPlanPanelFromApiOpts,
): Promise<void> {

      const source = String(opts.source || 'unknown').trim() || 'unknown'
      const fetchSeq = ctx.sessionTasksFetchSeqRef.current
      const captureSk = String(
        opts.sessionKey || ctx.sessionRef.current || ctx.selectedSessionKey || '',
      ).trim()
      if (!ctx.isActiveSessionFetch(captureSk, fetchSeq)) return
      let tid = String(opts.hintTaskId || '').trim()
      tracePlanDockApi('sync_start', { source, sessionKey: captureSk, hintTaskId: tid })
      const skipTaskResolve = !!tid || source === 'session_refresh' || !!opts.bypassCache
      if (!skipTaskResolve && captureSk) {
        tid = await resolvePlanBoundTaskId({
          sessionKey: captureSk,
          planOutput: opts.planOutput ?? null,
          hintTaskId: String(ctx.threadPanelState.collabSubtasks?.[0]?.parentTaskId || '').trim(),
        })
        if (!ctx.isActiveSessionFetch(captureSk, fetchSeq)) return
      }
      if (!skipTaskResolve && !tid && opts.planOutput) {
        tid = await resolvePlanBoundTaskId({
          sessionKey: captureSk,
          planOutput: opts.planOutput,
          hintTaskId: String(ctx.threadPanelState.collabSubtasks?.[0]?.parentTaskId || '').trim(),
        })
        if (!ctx.isActiveSessionFetch(captureSk, fetchSeq)) return
      }
      if (!ctx.isActiveSessionFetch(captureSk, fetchSeq)) return
      const applyKey = tid ? `${captureSk}:${tid}` : ''
      if (!opts.bypassCache && applyKey && ctx.planAppliedForRef.current === applyKey) {
        tracePlanDockApi('sync_skip_dedupe', { source, applyKey })
        if (ctx.planDockApiViewRef.current) return
      }

      const run = async () => {
        const hide = (reason: string, extra?: Record<string, unknown>) => {
          ctx.applyPlanDockApiView(
            planDockApiHide(source, reason, {
              taskId: tid || undefined,
              taskStatus: typeof extra?.taskStatus === 'string' ? extra.taskStatus : undefined,
            }) as PlanDockApiView,
          )
        }

        if (!captureSk) {
          hide('no_session_key')
          if (opts.fallback) {
            ctx.setThreadPanelState((prev) => ({
              ...prev,
              planInputFallback: opts.fallback || prev.planInputFallback || null,
              collabPhase: prev.collabPhase === 'executing' ? prev.collabPhase : 'planning',
            }))
          }
          return
        }

        const fallbackStructured = opts.fallback
          ? {
              goal: String(opts.fallback.goal || ''),
              flowchartMermaid: String(opts.fallback.flowchartMermaid || ''),
              steps: (opts.fallback.steps || []) as Array<Record<string, unknown>>,
              validation: opts.fallback.validation as string[] | undefined,
              openQuestions: String(opts.fallback.openQuestions || '无'),
            }
          : null
        if (!ctx.isActiveSessionFetch(captureSk, fetchSeq)) return
        const sync = await syncPlanDockStateFromApi(
          {
            sessionKey: captureSk,
            hintTaskId: tid,
            fallback: fallbackStructured,
          },
          { bypassCache: !!opts.bypassCache },
        )
        if (!ctx.isActiveSessionFetch(captureSk, fetchSeq)) return
        if (sync.taskId) tid = sync.taskId
        const resolvedApplyKey = tid ? `${captureSk}:${tid}` : applyKey
        if (resolvedApplyKey) {
          ctx.planAppliedForRef.current = resolvedApplyKey
          ctx.planFromApiLoadedRef.current = `${captureSk}:${tid}:${String(sync.plan?.goal || opts.fallback?.goal || '').slice(0, 48)}`
        }

        let collabAppliedFromSyncRow = false
        const applyCollabOnceFromSyncRow = () => {
          if (collabAppliedFromSyncRow || !(sync as Record<string, unknown>).taskRow || !tid) return
          const snap = collabSnapshotFromTaskRow((sync as Record<string, unknown>).taskRow as Record<string, unknown>)
          if (!snap) return
          collabAppliedFromSyncRow = true
          ctx.applyTaskProgressSnapshot(snap, { sessionKey: captureSk })
        }
        if (source === 'session_enter' && (sync as Record<string, unknown>).taskRow) {
          applyCollabOnceFromSyncRow()
          ctx.threadCollabSnapshotRef.current = captureSk
        }

        if (tid && sync.taskStatus === 'planned' && !sync.executionAuthorized) {
          const suppressToken = ctx.planExecSuppressToken(tid)
          const wasAuthorized = ctx.userAuthorizedTaskIdsRef.current.has(tid)
          if (!wasAuthorized) {
            ctx.suppressedPlanExecDockKeysRef.current.delete(suppressToken)
            for (const k of [...ctx.suppressedPlanExecDockKeysRef.current]) {
              if (k === suppressToken || k.startsWith(`${suppressToken}:`)) {
                ctx.suppressedPlanExecDockKeysRef.current.delete(k)
              }
            }
          }
        }

        const rowSubCount = Array.isArray(((sync as Record<string, unknown>).taskRow as { subtasks?: unknown[] } | null)?.subtasks)
          ? (((sync as Record<string, unknown>).taskRow as { subtasks?: unknown[] }).subtasks?.length ?? 0)
          : 0
        const subCount = rowSubCount || ctx.threadPanelState.collabSubtasks?.length || 0
        if (tid && ctx.isPlanExecDockSuppressed(tid, subCount)) {
          hide('suppressed', { taskStatus: sync.taskStatus })
          return
        }

        const fromApi = sync.plan
          ? {
              goal: String(sync.plan.goal || '').trim(),
              flowchartMermaid: String(sync.plan.flowchartMermaid || '').trim(),
              steps: (Array.isArray(sync.plan.steps) ? sync.plan.steps : []) as StructuredPlanInput['steps'],
              validation: sync.plan.validation as string[] | undefined,
              openQuestions: String(sync.plan.openQuestions || '无').trim(),
            }
          : null
        const planInputForState = fromApi

        if (!sync.showPlanDock || !planInputForState?.goal || !tid) {
          if (
            source === 'session_enter' &&
            !(sync as Record<string, unknown>).taskRow &&
            !tid &&
            !sync.taskStatus
          ) {
            tracePlanDockApi('session_enter_idle', { source, sessionKey: captureSk, note: 'no bound task yet' })
            return
          }
          if (
            sync.taskStatus === 'planning' &&
            !sync.executionAuthorized &&
            (source === 'stream_final' || source.startsWith('stream_final_'))
          ) {
            tracePlanDockApi('sync_wait_planned', { source, sessionKey: captureSk, taskId: tid })
            return
          }
          if (
            ctx.planDockApiViewRef.current?.show &&
            String(ctx.planDockApiViewRef.current.taskId || '').trim() === tid &&
            sync.taskStatus === 'planned' &&
            !sync.executionAuthorized
          ) {
            tracePlanDockApi('sync_keep_planned_dock', { source, taskId: tid })
            return
          }
          hide(sync.pastPlanGate ? 'past_plan_gate' : !tid ? 'no_task_id' : 'not_planned', {
            taskStatus: sync.taskStatus,
          })
          if (sync.pastPlanGate && tid) {
            ctx.suppressPlanExecDock(tid)
            ctx.setBoundTaskId(tid)
            applyCollabOnceFromSyncRow()
            if (rowSubCount > 0) ctx.bumpSubtasksApiRefresh()
            // Task passed plan gate (executing/completed/authorized):
            // clear stream latch + cached plan hit so subsequent non-plan turns
            // don't keep planCtxAtFinal=true and re-trigger refreshPlanDockAfterStreamFinal.
            ctx.planStreamLatchRef.current = null
            ctx.lastPlanPanelHitRef.current = null
            ctx.setPlanStreamLatched(false)
            ctx.setPlanPanelHit(null)
          }
          return
        }

        const effectiveTaskStatus = sync.taskStatus || 'planned'
        const effectiveExecutionAuthorized = sync.executionAuthorized
        const stripUi = computePlanExecStripUi({
          status: effectiveTaskStatus,
          executionAuthorized: effectiveExecutionAuthorized,
          boundPlanReady: true,
          hasPlanToolSuccess: true,
        })
        const showStartExecution =
          effectiveTaskStatus === 'planned' && !effectiveExecutionAuthorized
            ? true
            : stripUi.showStartExecution
        const planStructured: StructuredPlanInput = {
          goal: String(planInputForState.goal || sync.plan?.goal || '').trim(),
          flowchartMermaid: String(planInputForState.flowchartMermaid || sync.plan?.flowchartMermaid || '').trim(),
          steps: (planInputForState.steps || sync.plan?.steps || []) as StructuredPlanInput['steps'],
          validation: (planInputForState.validation || sync.plan?.validation) as string[] | undefined,
          openQuestions: String(planInputForState.openQuestions || sync.plan?.openQuestions || '无').trim(),
        }
        const suppressToken = ctx.planExecSuppressToken(tid)
        ctx.suppressedPlanExecDockKeysRef.current.delete(suppressToken)
        for (const k of [...ctx.suppressedPlanExecDockKeysRef.current]) {
          if (k === suppressToken || k.startsWith(`${suppressToken}:`)) {
            ctx.suppressedPlanExecDockKeysRef.current.delete(k)
          }
        }
        ctx.applyPlanDockApiView(
          planDockApiShow(source, {
            taskId: tid,
            taskName: ctx.threadPanelState.collabTask?.name,
            taskStatus: effectiveTaskStatus,
            statusLabel: stripUi.statusLabel,
            showStartExecution,
            planStructured,
            subtaskCount: subCount,
            toolCallId: '',
          }) as PlanDockApiView,
        )

        ctx.publishPlanPanelHit({
          planInput: planInputForState,
          boundPlanReady: opts.boundPlanReady ?? true,
          taskId: tid,
          planOutput: opts.planOutput ?? undefined,
        })
        if (tid) ctx.setBoundTaskId(tid)
        applyCollabOnceFromSyncRow()
        // @ts-ignore
        ctx.setThreadPanelState((prev) => {
          if (String(ctx.sessionRef.current || '').trim() !== captureSk) return prev
          const prevTid = String(prev.collabTask?.taskId || prev.boundTaskId || '').trim()
          const alreadyAuthorized = !!prev.collabTask?.executionAuthorized
          const executing =
            String(prev.collabPhase || '')
              .trim()
              .toLowerCase() === 'executing' ||
            String(prev.collabTask?.lifecycleStage || '')
              .trim()
              .toLowerCase() === 'executing'
          if (alreadyAuthorized || executing) {
            return {
              ...prev,
              boundTaskId: tid || prev.boundTaskId,
              planInputFallback: planInputForState || prev.planInputFallback || null,
              collabPhase: prev.collabPhase,
              collabTask: {
                ...(prev.collabTask || {}),
                taskId: tid || prev.collabTask?.taskId,
                executionAuthorized: true,
                boundPlanPreview:
                  String(opts.preview || prev.collabTask?.boundPlanPreview || '').trim() || undefined,
              },
            }
          }
          if (prevTid && tid && prevTid !== tid) {
            for (const k of [...ctx.suppressedPlanExecDockKeysRef.current]) {
              if (k.startsWith(`${prevTid}:`)) ctx.suppressedPlanExecDockKeysRef.current.delete(k)
            }
          }
          return {
            ...prev,
            boundTaskId: tid || prev.boundTaskId,
            planInputFallback: planInputForState || prev.planInputFallback || null,
            collabPhase: 'plan_ready',
            clarification: null,
            collabTask: {
              ...(prev.collabTask || {}),
              taskId: tid || prev.collabTask?.taskId,
              boundPlanReady: true,
              boundPlanPreview:
                String(
                  opts.preview ||
                    planStructured.goal ||
                    prev.collabTask?.boundPlanPreview ||
                    '',
                ).trim() || undefined,
              executionAuthorized: false,
              status: effectiveTaskStatus,
            },
          }
        })
        if (opts.openSidebar) ctx.openSessionSidebar()
      }

      if (ctx.planApiSyncInflightRef.current) {
        try {
          await ctx.planApiSyncInflightRef.current
        } catch {
          /* ignore */
        }
        if (!opts.bypassCache && applyKey && ctx.planAppliedForRef.current === applyKey && ctx.planDockApiViewRef.current) {
          tracePlanDockApi('sync_skip_after_inflight', { source, applyKey })
          return
        }
      }
      const promise = run()
        .catch((e) => {
          tracePlanDockApi('sync_error', { source, message: String((e as Error)?.message || e) })
          ctx.applyPlanDockApiView(planDockApiHide(source, 'sync_error') as PlanDockApiView)
        })
        .finally(() => {
          if (ctx.planApiSyncInflightRef.current === promise) {
            ctx.planApiSyncInflightRef.current = null
          }
          tracePlanDockApi('sync_done', { source })
        })
      ctx.planApiSyncInflightRef.current = promise
      return promise
}

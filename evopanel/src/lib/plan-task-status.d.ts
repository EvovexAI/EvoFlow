export const PLAN_DOCK_TASK_STATUS: 'planned'

export function isTaskExecutionAuthorized(
  task?: { status?: string; executionAuthorized?: boolean; boundPlanReady?: boolean } | null,
): boolean

export function isTerminalTaskStatus(status?: string): boolean

export function isActiveExecTaskStatus(status?: string): boolean

export function isPlanAwaitingUserExecStart(
  task?: { status?: string; executionAuthorized?: boolean; boundPlanReady?: boolean } | null,
  opts?: { hasPlanBody?: boolean; boundPlanReady?: boolean },
): boolean

export function formatPlanTaskStatusLabel(
  task?: { status?: string; executionAuthorized?: boolean } | null,
): string

export function isPlanExecDockEligible(input: {
  collabTask?: { status?: string; executionAuthorized?: boolean; boundPlanReady?: boolean } | null
  hasPlanBody?: boolean
}): boolean

export function isPlanFormulated(
  task?: { boundPlanReady?: boolean; planGoal?: string; boundPlanPreview?: string } | null,
  opts?: { hasPlanBody?: boolean; boundPlanReady?: boolean },
): boolean

export function shouldShowCollabSubtaskSidebar(
  task?: { status?: string; executionAuthorized?: boolean; boundPlanReady?: boolean; planGoal?: string; boundPlanPreview?: string } | null,
  opts?: { execConfirmPending?: boolean; boundPlanReady?: boolean; hasPlanBody?: boolean },
): boolean

export function shouldShowCollabWorkflowPanel(
  task?: { status?: string; executionAuthorized?: boolean; boundPlanReady?: boolean; planGoal?: string; boundPlanPreview?: string } | null,
  opts?: { boundPlanReady?: boolean; hasPlanBody?: boolean },
): boolean

export function shouldAutoOpenCollabExecPanel(
  task?: { status?: string; executionAuthorized?: boolean; boundPlanReady?: boolean; planGoal?: string; boundPlanPreview?: string } | null,
  opts?: { execConfirmPending?: boolean; boundPlanReady?: boolean; hasPlanBody?: boolean; collabPhase?: string },
): boolean

import type { GoalState } from "@zcode/shared/zcode-protocol-v4";

const INTERNAL_GOAL_VERIFICATION_FALLBACK_NEXT_ACTION =
  "Continue verifying and completing the goal.";

interface ConversationGoalIterationSummary {
  iteration: number;
  title: string | null;
  items: GoalState["iterations"][number]["items"];
  completedCount: number;
  totalCount: number;
  completed: boolean;
  verificationOutcome: GoalState["verifications"][number]["outcome"] | null;
}

function visibleNextAction(value: string | undefined): string | null {
  const nextAction = value?.trim();
  if (!nextAction || nextAction === INTERNAL_GOAL_VERIFICATION_FALLBACK_NEXT_ACTION) {
    return null;
  }
  return nextAction;
}

function requiredIterationCount(goal: GoalState): number {
  const maxTodoIteration = (goal.iterations ?? []).reduce(
    (maximum, entry) => Math.max(maximum, entry.iteration),
    0,
  );
  const maxVerificationIteration = goal.verifications.reduce(
    (maximum, entry) => Math.max(maximum, entry.iteration),
    0,
  );
  const latestVerification = goal.verifications.findLast(
    (entry) => entry.iteration === goal.iteration,
  );
  const continuationIsOpen =
    goal.status === "active" ||
    goal.status === "notSatisfied" ||
    (goal.status === "paused" && latestVerification?.outcome === "notSatisfied");
  const statusIteration = continuationIsOpen ? goal.iteration + 1 : Math.max(1, goal.iteration);
  return Math.max(1, statusIteration, maxTodoIteration, maxVerificationIteration);
}

/** 从 V4 权威 goal 投影构造右上角逐轮摘要；不从 renderer timeline 反推轮次。 */
export function buildConversationGoalIterationSummaries(
  goal: GoalState,
): ConversationGoalIterationSummary[] {
  const todoByIteration = new Map(
    (goal.iterations ?? []).map((entry) => [entry.iteration, entry.items] as const),
  );
  const verificationByIteration = new Map(
    goal.verifications.map((entry) => [entry.iteration, entry] as const),
  );
  const rows: ConversationGoalIterationSummary[] = [];

  for (let iteration = 1; iteration <= requiredIterationCount(goal); iteration += 1) {
    const items = todoByIteration.get(iteration) ?? [];
    const completedCount = items.filter((item) => item.status === "completed").length;
    const previousVerification = verificationByIteration.get(iteration - 1);
    rows.push({
      iteration,
      title:
        iteration === 1
          ? goal.summaryTitle?.trim() || goal.objective.trim() || null
          : visibleNextAction(previousVerification?.nextAction),
      items,
      completedCount,
      totalCount: items.length,
      completed: items.length > 0 && completedCount >= items.length,
      verificationOutcome: verificationByIteration.get(iteration)?.outcome ?? null,
    });
  }

  return rows.sort((left, right) => {
    if (left.completed !== right.completed) return left.completed ? -1 : 1;
    return left.iteration - right.iteration;
  });
}

export function getConversationGoalElapsedSeconds(goal: GoalState, now: number): number {
  const baseSeconds = Math.max(0, Math.floor(goal.timeUsedSeconds ?? 0));
  const isRunning =
    goal.status === "active" || goal.status === "verifying" || goal.status === "notSatisfied";
  if (!isRunning || goal.activeRunStartedAtMs == null) return baseSeconds;
  return baseSeconds + Math.max(0, Math.floor((now - goal.activeRunStartedAtMs) / 1000));
}

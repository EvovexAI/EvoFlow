import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunPhase,
  type WorkflowRunState,
} from "./workflow-runs.js";

/**
 * `phase-entered` 的归约：控制流经过了
 * 一个 `phase("…")` 标记。住在 reducer 主文件之外与并发观察同一个理由——主文件的 max-lines 门。
 *
 * 不碰 nodes / actors——标记不是一步工作。`rounds` 取 **max** 而不是 +1：引擎在 resume 重跑时会
 * 把前缀再发一遍（标记没有 journal 行可去重），单调归约让重放逐条无变化；ordinal 缺席（旧 CLI /
 * 残缺载荷）按 1 记。触界语义与 actors / nodes 同族：拒绝新条目、已有条目照常更新，超界事实仍在
 * journal 里；`currentPhase` 不受上限约束——「控制流在哪」是事实，进不了表也要说。
 */
/**
 * `run-launched` 的归约：锚点（inputId）
 * 是事件归属的事，状态不装它；这里只搬运脚本声明的阶段表 `phaseNames`，按声明序、裁到与 `phases`
 * 同一对界。缺席或空表 → 原样返回（只抬水位），键不建：UI 据缺席画一个隐含站点。
 * 同一世只记一次，所以 resume 的 `run-started` 不清它、重放逐条无变化。
 *
 * 「同时在跑」表 `phaseAlongside` 搭它的车（下标指向的正是被接受的那张 `phaseNames`），所以
 * 只在名字表立住之后才读，且按那张表的长度裁齐——见 {@link readPhaseAlongside}。
 */
export function reduceRunLaunched(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  if (!Array.isArray(payload.phaseNames)) return run;
  const phaseNames: string[] = [];
  for (const raw of payload.phaseNames) {
    if (typeof raw !== "string") continue;
    const name = raw.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
    if (name.length === 0) continue;
    phaseNames.push(name);
    if (phaseNames.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
  }
  if (phaseNames.length === 0) return run;
  const phaseAlongside = readPhaseAlongside(payload.phaseAlongside, phaseNames.length);
  return { ...run, phaseNames, ...(phaseAlongside === undefined ? {} : { phaseAlongside }) };
}

/**
 * 「同时在跑」表的搬运，只在 `phaseNames` 被接受之后调用。
 *
 * 下标指向的是**被接受的**那张名字表，所以整张表按它的长度裁齐（载荷更短时补空数组），逐项再
 * 过一遍：整数、落在 `[0, count)`、不是自己（一个阶段不与自己并行）、去重保序、条数同界。越界
 * 的下标会让侧栏把双线段连到一个不存在的站上，所以宁可少画。
 *
 * 一项都不剩时返回 `undefined`：键不建，UI 据缺席画一条直线——与 `phaseNames` 空表同一姿态。
 */
function readPhaseAlongside(raw: unknown, count: number): number[][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: number[][] = [];
  let any = false;
  for (let index = 0; index < count; index += 1) {
    const entry: unknown = raw[index];
    const indexes: number[] = [];
    if (Array.isArray(entry)) {
      for (const value of entry) {
        if (typeof value !== "number" || !Number.isInteger(value)) continue;
        if (value < 0 || value >= count || value === index) continue;
        if (indexes.includes(value)) continue;
        indexes.push(value);
        if (indexes.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
      }
    }
    if (indexes.length > 0) any = true;
    out.push(indexes);
  }
  return any ? out : undefined;
}

export function reducePhaseEntered(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const raw = typeof payload.name === "string" ? payload.name : undefined;
  const name = raw?.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
  if (name === undefined || name.length === 0) return run;
  const ordinal =
    typeof payload.ordinal === "number" && Number.isInteger(payload.ordinal) && payload.ordinal > 0
      ? payload.ordinal
      : 1;
  const existing = run.phases ?? [];
  const index = existing.findIndex((phase) => phase.name === name);
  let phases: WorkflowRunPhase[];
  let truncated = run.truncated === true;
  if (index >= 0) {
    const current = existing[index]!;
    phases =
      current.rounds >= ordinal
        ? existing
        : existing.map((phase, i) => (i === index ? { ...phase, rounds: ordinal } : phase));
  } else if (existing.length >= WORKFLOW_RUNS_LIMITS.maxPhases) {
    phases = existing;
    truncated = true;
  } else {
    phases = [...existing, { name, rounds: ordinal }];
  }
  return {
    ...run,
    phases,
    currentPhase: name,
    ...(truncated ? { truncated: true } : {}),
  };
}

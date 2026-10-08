// ============================================================
// workflowRuns 的键级增量：diff（生产侧）、apply（消费侧）与规范键序
// ============================================================
// 为什么存在：`workflowRuns` 是一个**高频**状态键，而 `state.updated` 的语义是键级整体替换。
// 一条引擎事件只改一个节点，却要把整张表重发一遍——每事件 O(N) 字节、一条 run 全程 O(N²)。
// 节点/子代理被压在 256 上、宽 fan-out 一撞界就静默丢实例，根子都在这里。本模块把「这一步
// 改了什么」算出来，让线上的字节数与**改动量**成正比，而不是与状态大小成正比。
//
// 三条结构性事实，读下面的代码前先知道，否则几处会像兜底：
//   1. reducer 只在表满时**淘汰**终态条目，绝不重排（workflow-runs-eviction.ts）。所以 diff 的
//      快路径仍然是按下标对齐比较，只在对不齐时才退到键化路径算出「哪些走了」；真遇到重排
//      它认不出来，只能整键重发（见 RESYNC）。
//   2. reducer 只给**变化的那条 run** 造新对象，其余 run 与未改动的条目保持引用不变。所以
//      diff 的第一道闸是引用比较，深比较只发生在真正动过的那条 run 上。
//   3. 正确性绝不依赖引用：引用相等只是快路径，不等时一律退回结构比较。
//
// 契约：对任意一对 reducer 产出的 (prior, next)，
// `JSON.stringify(applyAll(带 prior 的快照, diff(prior, next)).workflowRuns) === JSON.stringify(next)`
// ——**逐字节**，不只是深相等。键序因此是本模块的一等公民，见 {@link canonicalWorkflowRun}。

import type {
  ConversationDelta,
  WorkflowRunEntryRef,
  WorkflowRunHeaderKey,
  WorkflowRunRemovedDelta,
  WorkflowRunUpdatedDelta,
} from "./delta.js";
import {
  WORKFLOW_RUNS_LIMITS,
  workflowRunSchema,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "./workflow-runs.js";

/**
 * run 对象的**规范键序** = `workflowRunSchema` 的声明序。
 *
 * 逐字节一致里唯一不靠「值相等」保证的一环就是键序：reducer 用 `{...run, 新键: v}` 推进状态，
 * 新出现的可选键（reports / phases / concurrency…）因此按**到达顺序**缀在对象尾部，而 apply
 * 重建 run 时没有那段历史。两边各自按这张表重排一次，序就对齐了——这也是为什么 reducer 的
 * 出口同样要走一遍本函数（那是一处，不是两处）。
 *
 * 键序从 schema 派生，避免独立维护字段表导致生产者和消费者使用不同的 run 结构。
 */
const WORKFLOW_RUN_KEYS = Object.keys(workflowRunSchema.shape) as (keyof WorkflowRunState)[];
const WORKFLOW_RUN_KEY_SET: ReadonlySet<string> = new Set<string>(WORKFLOW_RUN_KEYS);

/** header = run 减去两张按 (siteId, ordinal) 增量同步的表。顺序仍是 schema 声明序。 */
export const WORKFLOW_RUN_HEADER_KEYS: readonly WorkflowRunHeaderKey[] = WORKFLOW_RUN_KEYS.filter(
  (key): key is WorkflowRunHeaderKey => key !== "actors" && key !== "nodes",
);

/**
 * header 里的**必填**键，同样从 schema 派生（`safeParse(undefined)` 通过 = 可缺省）。
 * 它只用在一处：判一条 `workflowRun.updated` 的 header 够不够格让一条未知 run **出生**。
 */
const runShape = workflowRunSchema.shape as unknown as Record<
  string,
  { safeParse: (value: unknown) => { success: boolean } }
>;
const WORKFLOW_RUN_REQUIRED_HEADER_KEYS: readonly WorkflowRunHeaderKey[] =
  WORKFLOW_RUN_HEADER_KEYS.filter((key) => !runShape[key]!.safeParse(undefined).success);

/** 两张实例表的去重键。`\0` 分隔的理由与 reducer 的派生 actor 状态逐字相同：("a",12) 与 ("a1",2) 不能撞车。 */
export function workflowRunEntryKey(entry: { siteId: string; ordinal: number }): string {
  return `${entry.siteId}\0${entry.ordinal}`;
}

/**
 * 按规范键序重建一个 run 对象（浅重建：嵌套值原样搬运引用，它们本来就来自同一份事实）。
 *
 * `undefined` 值的键按缺席处理，与 `JSON.stringify` 的语义对齐——协议线上只有「键在场」与
 * 「键缺席」两态，没有第三态。schema 之外的键按原序缀在尾部：本模块没有资格替调用方丢数据。
 */
export function canonicalWorkflowRun(run: WorkflowRunState): WorkflowRunState {
  const source = run as unknown as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of WORKFLOW_RUN_KEYS) {
    const value = source[key];
    if (value !== undefined) canonical[key] = value;
  }
  for (const key of Object.keys(source)) {
    if (WORKFLOW_RUN_KEY_SET.has(key)) continue;
    const value = source[key];
    if (value !== undefined) canonical[key] = value;
  }
  return canonical as unknown as WorkflowRunState;
}

/**
 * JSON 值的结构相等。reducer 的幂等判据（原来是整条 run 的 `JSON.stringify` 比对，每事件
 * O(N) 字节）与 diff 的「这个键/条目变了吗」共用这一份，两处判据不会再各说各话。
 *
 * 与 `JSON.stringify` 的差别只有两处，两处都是**更**准确：键序不参与判定；`undefined` 值的键
 * 与缺席等同（stringify 也会丢掉它们）。
 */
export function jsonValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonValueEqual(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let present = 0;
  for (const key of Object.keys(left)) {
    const value = left[key];
    if (value === undefined) continue;
    present += 1;
    if (!jsonValueEqual(value, right[key])) return false;
  }
  let expected = 0;
  for (const key of Object.keys(right)) if (right[key] !== undefined) expected += 1;
  return present === expected;
}

/** reducer 的幂等判据：同一条事件重放后内容无变化即不产 delta、不抬 revision。 */
export function workflowRunUnchanged(previous: WorkflowRunState, next: WorkflowRunState): boolean {
  return jsonValueEqual(previous, next);
}

/**
 * 一条 header 够不够格让**未知 run 出生**：必填键一个不缺。
 *
 * 只有 diff 的「诞生」分支会造出完整 header——已有 run 的增量里 `runId` 永远不变、因此永远不在
 * patch 里，于是若干条增量合并（coalesce 规则 6）也**拼不出**一条完整 header。这条不变量是
 * 合并规则得以成立的支点：合并不会把两条对未知 run 的 no-op 变成一次凭空出生。
 */
export function isCompleteWorkflowRunHeader(header: unknown): boolean {
  if (typeof header !== "object" || header === null) return false;
  const record = header as Record<string, unknown>;
  return WORKFLOW_RUN_REQUIRED_HEADER_KEYS.every((key) => record[key] !== undefined);
}

/**
 * 两个 workflowRuns 状态之间的键级增量。
 *
 * 退路只有一条：认不出的结构变化（条目被删或被重排，见文件头第 1 条）或「没有任何 op 却
 * revision 动了」时，整键重发一条 `state.updated`。它在协议上完全合法（键级整体替换），
 * 在 coalesce 里是一道屏障，代价只是退回改造前的字节数。
 */
export function diffWorkflowRunsState(
  prior: WorkflowRunsState | undefined,
  next: WorkflowRunsState,
): ConversationDelta[] {
  const priorRuns = prior?.runs ?? [];
  const nextIds = new Set(next.runs.map((run) => run.runId));
  const ops: ConversationDelta[] = [];
  // 淘汰先发、按 prior 序：客户端先把走了的 run 摘掉，剩下的增量都作用在活着的表上。
  for (const run of priorRuns) {
    if (nextIds.has(run.runId)) continue;
    ops.push({ op: "workflowRun.removed", runId: run.runId, revision: next.revision });
  }
  const priorById = new Map(priorRuns.map((run) => [run.runId, run]));
  for (const run of next.runs) {
    const before = priorById.get(run.runId);
    if (before === run) continue;
    const op = diffWorkflowRun(before, run, next.revision);
    if (op === null) return [{ op: "state.updated", patch: { workflowRuns: next } }];
    if (op !== undefined) ops.push(op);
  }
  // 一条 op 都没有却 revision 变了：容器版本没有自己的载体，只能整键重发。
  // reducer 不产生这种输入（无变化时它返回 null），所以这条在生产上不会走到。
  if (ops.length === 0 && (prior?.revision ?? -1) !== next.revision) {
    return [{ op: "state.updated", patch: { workflowRuns: next } }];
  }
  return ops;
}

/** 单条 run 的增量：`undefined` = 无变化，`null` = 认不出的结构变化（整键重发）。 */
function diffWorkflowRun(
  before: WorkflowRunState | undefined,
  run: WorkflowRunState,
  revision: number,
): WorkflowRunUpdatedDelta | undefined | null {
  const source = run as unknown as Record<string, unknown>;
  // key 是 header 键的联合，逐键写回时 TS 会把值收窄成 never；这里按记录装配、出口处再定型。
  const patch: Record<string, unknown> = {};
  const cleared: WorkflowRunHeaderKey[] = [];
  if (before === undefined) {
    // 诞生：整条 header（含 runId，客户端据它判断这条 op 够不够格建表）+ 全部条目。
    for (const key of WORKFLOW_RUN_HEADER_KEYS) {
      const value = source[key];
      if (value !== undefined) patch[key] = value;
    }
    return {
      op: "workflowRun.updated",
      runId: run.runId,
      revision,
      run: patch as WorkflowRunUpdatedDelta["run"],
      ...(run.actors.length > 0 ? { actors: [...run.actors] } : {}),
      ...(run.nodes.length > 0 ? { nodes: [...run.nodes] } : {}),
    };
  }
  const previous = before as unknown as Record<string, unknown>;
  for (const key of WORKFLOW_RUN_HEADER_KEYS) {
    const left = previous[key];
    const right = source[key];
    if (left === right) continue;
    if (right === undefined) {
      cleared.push(key);
      continue;
    }
    if (left !== undefined && jsonValueEqual(left, right)) continue;
    patch[key] = right;
  }
  const actors = diffWorkflowRunEntries(before.actors, run.actors);
  const nodes = diffWorkflowRunEntries(before.nodes, run.nodes);
  if (actors === null || nodes === null) return null;
  const changedHeader = Object.keys(patch).length > 0 || cleared.length > 0;
  if (!changedHeader && actors === undefined && nodes === undefined) return undefined;
  // 键序 = 施加序（header → 删除 → upsert）：同一个键被删又被加时它落在表尾，与顺序施加
  // 两条 op 一致。
  return {
    op: "workflowRun.updated",
    runId: run.runId,
    revision,
    ...(Object.keys(patch).length > 0 ? { run: patch as WorkflowRunUpdatedDelta["run"] } : {}),
    ...(cleared.length > 0 ? { cleared } : {}),
    ...(actors?.removed.length ? { removedActors: actors.removed } : {}),
    ...(nodes?.removed.length ? { removedNodes: nodes.removed } : {}),
    ...(actors?.changed.length ? { actors: actors.changed } : {}),
    ...(nodes?.changed.length ? { nodes: nodes.changed } : {}),
  };
}

/** 一张实例表这一步的变化：走掉的条目（只带身份）+ 变了的条目（整条，按 next 的顺序）。 */
interface EntryDiff<T> {
  removed: WorkflowRunEntryRef[];
  changed: T[];
}

/**
 * 两张实例表之间的变化。`undefined` = 无变化，`null` = 认不出的结构变化（整键重发）。
 *
 * 快路径按**下标对齐**比较：reducer 的常态是追加与原地更新，这条路径上未改动的条目只做一次
 * 指针比较。第一次对不齐（下标处身份不同，或 prior 比 next 长）说明有条目走了——那是腾位
 * （workflow-runs-eviction.ts），于是退到键化路径把「哪些走了」算出来。
 *
 * 键化路径仍然要求**幸存者按下标对齐**：删除之外的顺序变化这个模型表达不了（协议里没有
 * 条目移动语法），只能整键重发。
 */
function diffWorkflowRunEntries<T extends { siteId: string; ordinal: number }>(
  before: readonly T[],
  after: readonly T[],
): EntryDiff<T> | undefined | null {
  if (before === after) return undefined;
  if (before.length <= after.length) {
    const changed: T[] = [];
    let aligned = true;
    for (let index = 0; index < after.length && aligned; index += 1) {
      const entry = after[index]!;
      const previous = before[index];
      if (previous === undefined) {
        changed.push(entry);
        continue;
      }
      if (previous === entry) continue;
      if (previous.siteId !== entry.siteId || previous.ordinal !== entry.ordinal) aligned = false;
      else if (!jsonValueEqual(previous, entry)) changed.push(entry);
    }
    if (aligned) return changed.length > 0 ? { removed: [], changed } : undefined;
  }
  return diffWorkflowRunEntriesByKey(before, after);
}

function diffWorkflowRunEntriesByKey<T extends { siteId: string; ordinal: number }>(
  before: readonly T[],
  after: readonly T[],
): EntryDiff<T> | undefined | null {
  const survives = new Set(after.map(workflowRunEntryKey));
  const removed: WorkflowRunEntryRef[] = [];
  const survivors: T[] = [];
  for (const entry of before) {
    if (survives.has(workflowRunEntryKey(entry))) survivors.push(entry);
    else removed.push({ siteId: entry.siteId, ordinal: entry.ordinal });
  }
  if (survivors.length > after.length) return null;
  const changed: T[] = [];
  for (let index = 0; index < after.length; index += 1) {
    const entry = after[index]!;
    const previous = survivors[index];
    if (previous === undefined) {
      changed.push(entry);
      continue;
    }
    // 幸存者必须仍按原序坐在 next 的前缀上，否则就是重排——退回整键重发。
    if (previous.siteId !== entry.siteId || previous.ordinal !== entry.ordinal) return null;
    if (previous === entry || jsonValueEqual(previous, entry)) continue;
    changed.push(entry);
  }
  if (removed.length === 0 && changed.length === 0) return undefined;
  return { removed, changed };
}

/**
 * `workflowRun.updated` 的应用。
 *
 * 容器 revision 取 **max**：coalesce 允许把靠后的 op 合并到靠前的位置上（规则 6），于是输出序列
 * 的最后一条不一定携带最高 revision。revision 按契约单调，max 让「合并前后终态逐字节一致」这条
 * 定律不依赖 op 的位置。
 *
 * 身份：未改动的 run 与未改动的条目保持引用不变，变化的那条 run 与容器是新对象——GUI 正是按
 * 这两级引用做 memo。
 */
export function applyWorkflowRunUpdated(
  state: WorkflowRunsState | undefined,
  delta: WorkflowRunUpdatedDelta,
): WorkflowRunsState {
  const runs = state?.runs ?? [];
  const revision = Math.max(state?.revision ?? 0, delta.revision);
  const index = runs.findIndex((run) => run.runId === delta.runId);
  if (index < 0) {
    // 未知 run + 完整 header = 诞生；未知 run + 残缺 header = 这条 op 说的不是客户端手上的事实，
    // 按 no-op 处理（与 row.upserted 命中未加载行同一条裁决），只让容器 revision 跟上。
    if (!isCompleteWorkflowRunHeader(delta.run)) {
      return state !== undefined && state.revision === revision ? state : { revision, runs };
    }
    const born = canonicalWorkflowRun({
      ...(delta.run as Partial<WorkflowRunState>),
      actors: delta.actors === undefined ? [] : [...delta.actors],
      nodes: delta.nodes === undefined ? [] : [...delta.nodes],
    } as WorkflowRunState);
    return { revision, runs: [...runs, born] };
  }
  const existing = runs[index]!;
  const merged: Record<string, unknown> = { ...existing, ...delta.run };
  // 「零条 ⇒ 键缺席」是好几个键的协议约定，所以增量必须说得出「这个键没了」。
  for (const key of delta.cleared ?? []) delete merged[key];
  // 施加序：header → 删除 → upsert。同一个键在一条 op 里被删又被加时它落在表尾，与顺序施加
  // 两条 op 的结果一致；反过来（先加后删）会把一条刚回来的条目又摘掉。
  const actors = removeWorkflowRunEntries(existing.actors, delta.removedActors);
  const nodes = removeWorkflowRunEntries(existing.nodes, delta.removedNodes);
  if (actors !== existing.actors) merged.actors = actors;
  if (nodes !== existing.nodes) merged.nodes = nodes;
  if (delta.actors !== undefined && delta.actors.length > 0) {
    merged.actors = upsertWorkflowRunEntries(actors, delta.actors);
  }
  if (delta.nodes !== undefined && delta.nodes.length > 0) {
    merged.nodes = upsertWorkflowRunEntries(nodes, delta.nodes);
  }
  const next = [...runs];
  next[index] = canonicalWorkflowRun(merged as unknown as WorkflowRunState);
  return { revision, runs: next };
}

/** `workflowRun.removed` 的应用：把这条 run 摘掉。未知 runId 只让 revision 跟上。 */
export function applyWorkflowRunRemoved(
  state: WorkflowRunsState | undefined,
  delta: WorkflowRunRemovedDelta,
): WorkflowRunsState {
  const runs = state?.runs ?? [];
  const revision = Math.max(state?.revision ?? 0, delta.revision);
  const remaining = runs.filter((run) => run.runId !== delta.runId);
  if (remaining.length === runs.length) {
    return state !== undefined && state.revision === revision ? state : { revision, runs };
  }
  return { revision, runs: remaining };
}

/**
 * 按 (siteId, ordinal) 摘掉条目；一条都没命中时返回**同一个数组**（未提到的表要保住引用）。
 * 未命中的键是定义明确的 no-op：合并把两条 op 的删除取了并集，其中一些在这个客户端手上
 * 根本没到过。
 */
function removeWorkflowRunEntries<T extends { siteId: string; ordinal: number }>(
  current: readonly T[],
  removed: readonly { siteId: string; ordinal: number }[] | undefined,
): T[] {
  if (removed === undefined || removed.length === 0) return current as T[];
  const dropped = new Set(removed.map(workflowRunEntryKey));
  const next = current.filter((entry) => !dropped.has(workflowRunEntryKey(entry)));
  return next.length === current.length ? (current as T[]) : next;
}

/**
 * 按 (siteId, ordinal) upsert：已有键原地替换、新键追加到尾部。
 *
 * 客户端**绝不**施加任何上界（maxNodes / maxActors / maxRuns）：只有生产者有资格淘汰，而且
 * 淘汰必须说出来（`workflowRun.removed` / `removedActors` / `removedNodes`）。客户端自行裁剪
 * 只会让两侧悄悄分叉。
 */
function upsertWorkflowRunEntries<T extends { siteId: string; ordinal: number }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const next = [...current];
  const indexByKey = new Map<string, number>();
  next.forEach((entry, index) => indexByKey.set(workflowRunEntryKey(entry), index));
  for (const entry of incoming) {
    const key = workflowRunEntryKey(entry);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, next.length);
      next.push(entry);
      continue;
    }
    next[index] = entry;
  }
  return next;
}

/**
 * 一条 `workflowRun.updated` 的四张条目表都在线上界之内吗。
 *
 * 真正会超界的是**两张删除表**。合并出来的 upsert 表自己就有界：按合并规则，先者 upsert 的键
 * 凡被后者删掉的都已去掉，所以留下的每一个键在这条 op 施加完之后都还在表里，而表本身 ≤ 界。
 * 删除表没有这条护栏——合并分不出「窗口里刚出生又被淘汰的键」和「客户端早就拿着的键」，
 * 每次淘汰都让出一个位子，一个够宽的 flush 窗口里被删掉的不同键因此可以多于 1024 条。
 * 淘汰之前这不可能：表只增不减，一世之内被碰过的不同键最多就是表界那么多。
 *
 * 超界载荷会让整个 patch 解析失败、整帧被丢；publisher 的两道限制（500 op / 1 MiB）在这个
 * 量级上都不会响。四张表都查是因为这道闸很便宜，而且不该依赖上面那条论证一直成立。
 *
 * 合并是**优化**，所以拒绝合并永远是安全的：两条 op 各自都在界内，逐条投递的终态一个字节都不差。
 */
export function workflowRunUpdateWithinWireBounds(
  delta: WorkflowRunUpdatedDelta,
  limits: WorkflowRunWireBounds = WORKFLOW_RUNS_LIMITS,
): boolean {
  return (
    (delta.actors?.length ?? 0) <= limits.maxActors &&
    (delta.removedActors?.length ?? 0) <= limits.maxActors &&
    (delta.nodes?.length ?? 0) <= limits.maxNodes &&
    (delta.removedNodes?.length ?? 0) <= limits.maxNodes
  );
}

/**
 * 条目表的容量上限，默认使用 {@link WORKFLOW_RUNS_LIMITS}。
 * 增量应用和合并必须使用一致的上限。
 */
export interface WorkflowRunWireBounds {
  readonly maxActors: number;
  readonly maxNodes: number;
}

/** 合并两条同 run 的 `workflowRun.updated`（coalesce 规则 6 的载荷部分，规则本身在 coalesce.ts）。 */
export function mergeWorkflowRunUpdates(
  earlier: WorkflowRunUpdatedDelta,
  later: WorkflowRunUpdatedDelta,
): WorkflowRunUpdatedDelta {
  const run: Record<string, unknown> = { ...earlier.run, ...later.run };
  // header 键与 `cleared` 互为反面，合并时必须彼此对消：后设值的键不再是"被清掉的"，
  // 后清掉的键也不再有值。留一半会让 apply 先写后删（或先删后写），结果取决于键序。
  const laterCleared = new Set<string>(later.cleared ?? []);
  for (const key of laterCleared) delete run[key];
  const cleared: WorkflowRunHeaderKey[] = [];
  for (const key of earlier.cleared ?? []) {
    if (run[key] === undefined && !cleared.includes(key)) cleared.push(key);
  }
  for (const key of later.cleared ?? []) {
    if (!cleared.includes(key)) cleared.push(key);
  }
  const removedActors = mergeRemovedRefs(earlier.removedActors, later.removedActors);
  const removedNodes = mergeRemovedRefs(earlier.removedNodes, later.removedNodes);
  const actors = mergeEntryLists<WorkflowRunActor>(
    earlier.actors,
    later.actors,
    later.removedActors,
  );
  const nodes = mergeEntryLists<WorkflowRunNode>(earlier.nodes, later.nodes, later.removedNodes);
  return {
    op: "workflowRun.updated",
    runId: later.runId,
    // 取最高水位：合并后的 op 坐在靠前的位置上，靠 apply 的 max 让容器版本仍然收在最高 revision。
    revision: Math.max(earlier.revision, later.revision),
    ...(Object.keys(run).length > 0 ? { run: run as WorkflowRunUpdatedDelta["run"] } : {}),
    ...(cleared.length > 0 ? { cleared } : {}),
    ...(removedActors === undefined ? {} : { removedActors }),
    ...(removedNodes === undefined ? {} : { removedNodes }),
    ...(actors === undefined ? {} : { actors }),
    ...(nodes === undefined ? {} : { nodes }),
  };
}

/** 两侧的删除取并集，按首次出现去重（删除是按键过滤，顺序不影响结果，只影响字节）。 */
function mergeRemovedRefs(
  earlier: readonly WorkflowRunEntryRef[] | undefined,
  later: readonly WorkflowRunEntryRef[] | undefined,
): WorkflowRunEntryRef[] | undefined {
  if (earlier === undefined && later === undefined) return undefined;
  const merged: WorkflowRunEntryRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...(earlier ?? []), ...(later ?? [])]) {
    const key = workflowRunEntryKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return merged.length > 0 ? merged : undefined;
}

/**
 * 条目表按键后来者覆盖、按首次出现保序；两侧都没有条目时返回 undefined（键不建）。
 *
 * **先者 upsert 的键凡是被后者删掉的一律去掉**：顺序施加时它先进表、再被后者摘走，所以合并后
 * 的 op 里根本不该有它。若后者又把同一个键加了回来，它只在后者的表里出现一次，于是落在表尾
 * ——顺序施加得到的正是这个位置。
 */
function mergeEntryLists<T extends { siteId: string; ordinal: number }>(
  earlier: readonly T[] | undefined,
  later: readonly T[] | undefined,
  laterRemoved: readonly WorkflowRunEntryRef[] | undefined,
): T[] | undefined {
  if (earlier === undefined && later === undefined) return undefined;
  const dropped = new Set((laterRemoved ?? []).map(workflowRunEntryKey));
  const kept =
    dropped.size === 0
      ? (earlier ?? [])
      : (earlier ?? []).filter((entry) => !dropped.has(workflowRunEntryKey(entry)));
  const merged = upsertWorkflowRunEntries(kept, later ?? []);
  return merged.length > 0 ? merged : undefined;
}

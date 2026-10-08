// Delta 应用语义的规范实现（纯函数）。
// 这是协议语义的一部分：coalesce 的「语义保持」就以本函数为裁判——
// applyAll(s, coalesce(ds)) 必须与 applyAll(s, ds) 逐字节一致（黄金测试）。
// 客户端 store 的 apply 逻辑是本函数的宿主化改写，不得引入额外分支。
import type { ConversationDelta } from "./delta.js";
import type { ConversationSnapshot } from "./snapshot.js";
import type { ConversationRow } from "./rows.js";
import type { StreamablePath } from "./core.js";
import { applyWorkflowRunRemoved, applyWorkflowRunUpdated } from "./workflow-runs-delta.js";

/**
 * 仅供服务端在未发布的候选快照内批量归约使用。
 *
 * 冷恢复逐条调用不可变 apply 时，每次 append/upsert 都复制随历史增长的
 * rows.window，并再次线性查找 rowId，长会话因此退化为 O(N²)。候选快照尚未对外可见，
 * 可以在这条明确的隔离边界内复用同一份数组和增量索引；普通客户端仍使用上面的
 * 不可变语义，避免已发布快照被后续事件篡改。
 */
export interface MutableConversationSnapshotAccumulator {
  snapshot: ConversationSnapshot;
  rowIndexById: Map<number, number>;
}

export function createMutableConversationSnapshotAccumulator(
  snapshot: ConversationSnapshot,
): MutableConversationSnapshotAccumulator {
  const window = [...snapshot.rows.window];
  return {
    snapshot: {
      ...snapshot,
      rows: { ...snapshot.rows, window },
    },
    rowIndexById: new Map(window.map((row, index) => [row.rowId, index])),
  };
}

// row.delta 只允许作用于流式态行（不变量，服务端保证）。
// 本函数按协议语义实现为：路径不存在/行不存在时 no-op（patch 命中未加载行 = no-op）。
function appendToRow(row: ConversationRow, path: StreamablePath, append: string): ConversationRow {
  switch (path) {
    case "text":
      if (row.kind === "assistantText" || row.kind === "reasoning") {
        return { ...row, text: row.text + append };
      }
      return row;
    case "inputText":
      if (row.kind === "toolCall") {
        return { ...row, inputText: row.inputText + append };
      }
      return row;
    case "output.text":
      if (row.kind === "toolCall" && row.output) {
        return {
          ...row,
          output: { ...row.output, text: row.output.text + append },
        };
      }
      return row;
    case "summaryText":
      if (row.kind === "subagent") {
        return { ...row, summaryText: row.summaryText + append };
      }
      return row;
  }
}

/** 应用单条 delta，返回新快照（入参不被修改）。 */
export function applyConversationDelta(
  snapshot: ConversationSnapshot,
  delta: ConversationDelta,
): ConversationSnapshot {
  switch (delta.op) {
    case "row.appended":
      return {
        ...snapshot,
        rows: {
          ...snapshot.rows,
          window: [...snapshot.rows.window, delta.row],
          totalCount: snapshot.rows.totalCount + 1,
          firstRowId: snapshot.rows.firstRowId ?? delta.row.rowId,
        },
      };
    case "row.upserted": {
      const index = snapshot.rows.window.findIndex((row) => row.rowId === delta.row.rowId);
      // 未加载 rowId = no-op（被逐出的行只能经 rows/range 取回）。
      if (index === -1) return snapshot;
      const window = [...snapshot.rows.window];
      window[index] = delta.row;
      return { ...snapshot, rows: { ...snapshot.rows, window } };
    }
    case "row.removed": {
      const window = snapshot.rows.window.filter((row) => row.rowId < delta.fromRowId);
      const removed = snapshot.rows.window.length - window.length;
      const removesEntireActiveBranch =
        snapshot.rows.firstRowId !== null && delta.fromRowId <= snapshot.rows.firstRowId;
      return {
        ...snapshot,
        rows: {
          ...snapshot.rows,
          window,
          // rewind 首轮后 rowId 继续单调递增；若保留旧 firstRowId，UI 会把
          // 旧分支留下的 rowId 空洞误判成“加载更早”。全量和尾窗都必须在从首行
          // 开始裁剪时清空 active-branch 分页锚点与计数，下一次 append 再建立新首行。
          totalCount: removesEntireActiveBranch
            ? 0
            : Math.max(0, snapshot.rows.totalCount - removed),
          firstRowId: removesEntireActiveBranch ? null : snapshot.rows.firstRowId,
        },
      };
    }
    case "row.delta": {
      const index = snapshot.rows.window.findIndex((row) => row.rowId === delta.rowId);
      const target = snapshot.rows.window[index];
      if (index === -1 || target === undefined) return snapshot;
      const window = [...snapshot.rows.window];
      window[index] = appendToRow(target, delta.path, delta.append);
      return { ...snapshot, rows: { ...snapshot.rows, window } };
    }
    case "state.updated":
      // 键级整体替换：patch 中在场的键覆盖，绝不深合并。
      return { ...snapshot, ...delta.patch };
    // workflowRuns 是唯一开了增量口子的状态键（delta.ts 的注释讲了为什么）。规则整份住在
    // workflow-runs-delta.ts：两个 twin 都只转调它，两边的语义因此没有走散的余地。
    case "workflowRun.updated":
      return {
        ...snapshot,
        workflowRuns: applyWorkflowRunUpdated(snapshot.workflowRuns, delta),
      };
    case "workflowRun.removed":
      return {
        ...snapshot,
        workflowRuns: applyWorkflowRunRemoved(snapshot.workflowRuns, delta),
      };
  }
}

/** 按序应用一串 delta。 */
export function applyConversationDeltas(
  snapshot: ConversationSnapshot,
  deltas: readonly ConversationDelta[],
): ConversationSnapshot {
  let current = snapshot;
  for (const delta of deltas) {
    current = applyConversationDelta(current, delta);
  }
  return current;
}

/**
 * 在未发布候选快照上原地应用单条 delta；语义必须与 applyConversationDelta 一致。
 * 调用者不得把 accumulator.snapshot 暴露给订阅者后继续调用本函数。
 */
export function applyConversationDeltaMutable(
  accumulator: MutableConversationSnapshotAccumulator,
  delta: ConversationDelta,
): void {
  const snapshot = accumulator.snapshot;
  switch (delta.op) {
    case "row.appended":
      accumulator.rowIndexById.set(delta.row.rowId, snapshot.rows.window.length);
      snapshot.rows.window.push(delta.row);
      snapshot.rows.totalCount += 1;
      snapshot.rows.firstRowId ??= delta.row.rowId;
      return;
    case "row.upserted": {
      const index = accumulator.rowIndexById.get(delta.row.rowId);
      if (index === undefined) return;
      snapshot.rows.window[index] = delta.row;
      return;
    }
    case "row.removed": {
      const removesEntireActiveBranch =
        snapshot.rows.firstRowId !== null && delta.fromRowId <= snapshot.rows.firstRowId;
      let writeIndex = 0;
      for (const row of snapshot.rows.window) {
        if (row.rowId >= delta.fromRowId) continue;
        snapshot.rows.window[writeIndex] = row;
        writeIndex += 1;
      }
      const removed = snapshot.rows.window.length - writeIndex;
      snapshot.rows.window.length = writeIndex;
      snapshot.rows.totalCount = removesEntireActiveBranch
        ? 0
        : Math.max(0, snapshot.rows.totalCount - removed);
      snapshot.rows.firstRowId = removesEntireActiveBranch ? null : snapshot.rows.firstRowId;
      accumulator.rowIndexById.clear();
      snapshot.rows.window.forEach((row, index) => accumulator.rowIndexById.set(row.rowId, index));
      return;
    }
    case "row.delta": {
      const index = accumulator.rowIndexById.get(delta.rowId);
      if (index === undefined) return;
      const target = snapshot.rows.window[index];
      if (target === undefined) return;
      snapshot.rows.window[index] = appendToRow(target, delta.path, delta.append);
      return;
    }
    case "state.updated":
      // 与不可变实现相同：patch 在场键整体替换，不能深合并。
      Object.assign(snapshot, delta.patch);
      return;
    // 与不可变实现调同一个纯函数：workflowRuns 是状态键不是 rows 窗口，没有「原地追加」可优化，
    // 而 accumulator.snapshot 本来就是候选快照自己的对象，赋一个新容器不会碰到已发布的快照。
    case "workflowRun.updated":
      snapshot.workflowRuns = applyWorkflowRunUpdated(snapshot.workflowRuns, delta);
      return;
    case "workflowRun.removed":
      snapshot.workflowRuns = applyWorkflowRunRemoved(snapshot.workflowRuns, delta);
  }
}

/** 按序原地应用一串 delta，仅适用于未发布的候选快照。 */
export function applyConversationDeltasMutable(
  accumulator: MutableConversationSnapshotAccumulator,
  deltas: readonly ConversationDelta[],
): void {
  for (const delta of deltas) applyConversationDeltaMutable(accumulator, delta);
}

// Coalesce 纯函数：CLI flush buffer 使用的合并规则。
// 语义要求：coalesce(deltas) 与逐条投递等价——两种 delivery profile 处理同一事件序列后，终态必须逐字节一致。任何合并都不得改变 apply 后的最终状态。
//
// 规则（封闭集合）：
//   1. 相邻同 (rowId, path) 的 row.delta → append 拼接；
//   2. 相邻 state.updated → patch 键浅合并（键内整体替换，安全）；
//   3. row.delta 后随同 rowId 的 row.upserted → 前者丢弃（整行替换蕴含所有追加）；
//   4. row.removed 是屏障，任何规则不得跨越；
//   5. 帧超限切分不在本函数（由通道层打帧）；
//   6. 同 runId 的 workflowRun.updated 向**最早**的那条合并（详见下面 mergeWorkflowRunUpdate）。
import type { ConversationDelta, WorkflowRunUpdatedDelta } from "./delta.js";
import {
  mergeWorkflowRunUpdates,
  workflowRunUpdateWithinWireBounds,
  type WorkflowRunWireBounds,
} from "./workflow-runs-delta.js";

function isBarrier(delta: ConversationDelta): boolean {
  return delta.op === "row.removed";
}

/**
 * 规则 6 的屏障：`workflowRuns` 被整键替换的地方（`state.updated` 带该键），以及**同一条 run**
 * 的 `workflowRun.removed`。其余 op 与本 run 的增量作用在互不相交的状态上，可交换——
 * 行操作不碰状态键，别的 run 的增量不碰这条 run，不带 workflowRuns 的 state.updated 不碰这个键。
 */
function isWorkflowRunBarrier(delta: ConversationDelta, runId: string): boolean {
  if (delta.op === "state.updated") return delta.patch.workflowRuns !== undefined;
  return delta.op === "workflowRun.removed" && delta.runId === runId;
}

/**
 * 规则 6：把一条 `workflowRun.updated` 合进窗口内**最后**一条同 runId 增量里。
 *
 * 为什么要往回找而不是只看相邻：一个宽 fan-out 的 run 每条引擎事件产一条增量，窗口里它们被
 * 别的 run 与行操作隔开，只合并相邻的等于一条都合不掉。
 *
 * 为什么目标是**最后**一条而不是更早的：合并一路成功时，屏障之后同一条 run 至多只剩一条增量
 * （每条新来的都并了进去），此时「最早」与「最后」是同一条 op，合并结果仍坐在最早的位置上，
 * `runs[]` 的出生序照旧保住。而合并被拒时窗口里会留下两条，这时候若还往**更早**那条合，
 * 就等于让后来的 upsert 跳到中间那条的删除**之前**——一个先删后加的键会就此消失。
 *
 * 合并后的 op 坐在靠前的位置却携带靠后的 revision，所以 apply 的容器 revision 取 max（见
 * applyWorkflowRunUpdated）。合并**拼不出**一条完整 header，因此不会把两条对未知 run 的 no-op
 * 变成一次凭空出生（见 isCompleteWorkflowRunHeader 的注释）。
 *
 * 合并出来的载荷**超出线上界**时不合并（两条 op 照原样留着，逐条投递的终态不变）：腾位让
 * 「一个窗口里被删掉的不同键 ≤ 表界」不再成立，而超界的帧会被整帧丢掉。理由见
 * workflowRunUpdateWithinWireBounds。
 *
 * 返回 true 表示已被合并（调用方不再 push）。
 */
function mergeWorkflowRunUpdate(
  result: ConversationDelta[],
  delta: WorkflowRunUpdatedDelta,
  bounds: WorkflowRunWireBounds | undefined,
): boolean {
  let target = -1;
  for (let i = result.length - 1; i >= 0; i--) {
    const prev = result[i];
    if (prev === undefined || isWorkflowRunBarrier(prev, delta.runId)) break;
    if (prev.op === "workflowRun.updated" && prev.runId === delta.runId) {
      target = i;
      break;
    }
  }
  if (target < 0) return false;
  const merged = mergeWorkflowRunUpdates(result[target] as WorkflowRunUpdatedDelta, delta);
  // 被拒时**不再往更早那条试**：那正是上面说的跨过中间那条删除的走法。
  if (!workflowRunUpdateWithinWireBounds(merged, bounds)) return false;
  result[target] = merged;
  return true;
}

/**
 * 对一个 flush 窗口内的 delta 序列做语义保持合并。
 * 输入输出均按权威日志序；纯函数，不修改入参。
 * `bounds` 默认使用协议容量上限；合并后的状态必须与逐条应用时相同。
 */
export function coalesceConversationDeltas(
  deltas: readonly ConversationDelta[],
  bounds?: WorkflowRunWireBounds,
): ConversationDelta[] {
  const result: ConversationDelta[] = [];

  for (const delta of deltas) {
    // 规则 3：row.upserted 吞掉同 rowId 更早的 row.delta。
    // 只回溯到最近的屏障（规则 4），且不越过同 rowId 的前一次 upserted/appended——
    // 越过会吞掉「上一代行」的追加，改变终态。
    if (delta.op === "row.upserted") {
      for (let i = result.length - 1; i >= 0; i--) {
        const prev = result[i];
        if (prev === undefined || isBarrier(prev)) break;
        if (prev.op === "row.delta" && prev.rowId === delta.row.rowId) {
          result.splice(i, 1);
          continue;
        }
        if (
          (prev.op === "row.upserted" || prev.op === "row.appended") &&
          prev.row.rowId === delta.row.rowId
        ) {
          break;
        }
      }
    }

    // 规则 6：淘汰吞掉该 run 此前的全部增量（出生 + 淘汰同在一个窗口 = 客户端从没见过这条 run，
    // 与逐条投递的终态等价）。回溯同样只到最近的屏障。
    if (delta.op === "workflowRun.removed") {
      for (let i = result.length - 1; i >= 0; i--) {
        const prev = result[i];
        if (prev === undefined || isWorkflowRunBarrier(prev, delta.runId)) break;
        if (prev.op === "workflowRun.updated" && prev.runId === delta.runId) result.splice(i, 1);
      }
    }

    if (delta.op === "workflowRun.updated" && mergeWorkflowRunUpdate(result, delta, bounds))
      continue;

    const last = result[result.length - 1];

    // 规则 1：相邻同 (rowId, path) 的 row.delta 拼接。
    if (
      delta.op === "row.delta" &&
      last?.op === "row.delta" &&
      last.rowId === delta.rowId &&
      last.path === delta.path
    ) {
      result[result.length - 1] = {
        op: "row.delta",
        rowId: delta.rowId,
        path: delta.path,
        append: last.append + delta.append,
      };
      continue;
    }

    // 规则 2：相邻 state.updated 浅合并（后者的键覆盖前者；键内整体替换所以安全）。
    if (delta.op === "state.updated" && last?.op === "state.updated") {
      result[result.length - 1] = {
        op: "state.updated",
        patch: { ...last.patch, ...delta.patch },
      };
      continue;
    }

    // 相邻同 rowId 的 row.upserted：留最后一条（整行替换的传递性）。
    if (
      delta.op === "row.upserted" &&
      last?.op === "row.upserted" &&
      last.row.rowId === delta.row.rowId
    ) {
      result[result.length - 1] = delta;
      continue;
    }

    result.push(delta);
  }

  return result;
}

/**
 * conflation 辅助（sessions-index 等最新态 topic 通用）：按 key 只保留每个对象的最后一次更新。
 * 保序：保留项按其「最后一次出现」的相对顺序输出。
 */
export function conflateByKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const lastIndexByKey = new Map<string, number>();
  items.forEach((item, index) => {
    lastIndexByKey.set(keyOf(item), index);
  });
  return items.filter((item, index) => lastIndexByKey.get(keyOf(item)) === index);
}

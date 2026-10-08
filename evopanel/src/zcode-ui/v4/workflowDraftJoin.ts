import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowDraftPosition } from "@/ToolCallBlocks/shared.js";
import {
  isPlainRecord,
  readWorkflowAmendTarget,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import { isAmendWorkflowToolCall, isCreateWorkflowToolCall } from "@/lib/workflowToolNames.js";

/**
 * 工作流工具行 → 草稿位置（稿号与是否已被替代）的联接表，行窗口一遍建成
 *
 * 编不过的脚本不是失败：什么都没跑，诊断交回了模型、模型改完再交。卡片要说「第几稿」与「后面还有没有
 * 更新的一稿」，这两个事实都不在单行上，只能从行序里读出来；读法只有这一处实现，卡片只读结果。
 *
 * 规则：
 * - 谱系：工具名，修订再加前驱 `run_id`。创建在创建之间数，每个 run 的修订各自从 1 数起；
 * - 稿号：1 + 同谱系、同一轮里自上一次编过（`display.ok === true`）以来编不过（`ok === false`）的行数；
 *   没有 display 的行（流式中、待确认、被拒、取消）既不计数也不清零；新的一轮从 1 数起；
 * - 被替代：窗口里同谱系后面还有行（同一轮或之后的轮都算）。
 *
 * 行窗口是有界的：前面几稿滑出窗口时稿号会偏小。稿号只用于展示，没有别的读者。
 */
export function buildWorkflowDraftByToolCallId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, WorkflowDraftPosition> {
  const byToolCallId = new Map<string, WorkflowDraftPosition>();
  // 谱系 → 该谱系最近一行的 toolCallId（用来在后一行出现时把它标为被替代）。
  const latestByLineage = new Map<string, string>();
  // 「谱系 + 轮」→ 自上次编过以来的连续失败数。
  const failuresByLineageTurn = new Map<string, number>();

  for (const row of rows ?? []) {
    if (row.kind !== "toolCall") continue;
    const lineage = workflowDraftLineage(row);
    if (lineage === undefined) continue;

    const previous = latestByLineage.get(lineage);
    if (previous !== undefined) {
      const position = byToolCallId.get(previous);
      if (position !== undefined) byToolCallId.set(previous, { ...position, superseded: true });
    }
    latestByLineage.set(lineage, row.toolCallId);

    const turnKey = `${lineage}\u0000${row.turnId}`;
    const failures = failuresByLineageTurn.get(turnKey) ?? 0;
    byToolCallId.set(row.toolCallId, { ordinal: failures + 1, superseded: false });

    const compiled = readCompiled(row);
    if (compiled === false) failuresByLineageTurn.set(turnKey, failures + 1);
    if (compiled === true) failuresByLineageTurn.set(turnKey, 0);
  }
  return byToolCallId;
}

function workflowDraftLineage(row: ToolCallRow): string | undefined {
  if (isAmendWorkflowToolCall(row)) {
    return `amend\u0000${readWorkflowAmendTarget(row.input) ?? ""}`;
  }
  return isCreateWorkflowToolCall(row) ? "create" : undefined;
}

/**
 * 这一行编过没有：`true` / `false` 读 display，没有 display 时是 `undefined`。
 * display 的 canonical 位置是 `output.display`，顶层 `display` 是旧快照的兼容通道
 * （与 `toolCallRowToLegacyNode` 同一优先级，两处读法一旦分叉，卡片与稿号就会各说各话）。
 */
function readCompiled(row: ToolCallRow): boolean | undefined {
  const display: unknown = row.output?.display ?? row.display;
  if (!isPlainRecord(display) || display.kind !== "create_workflow") return undefined;
  return typeof display.ok === "boolean" ? display.ok : undefined;
}

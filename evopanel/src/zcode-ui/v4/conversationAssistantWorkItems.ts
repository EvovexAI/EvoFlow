import type { SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  isExecuteToolCall,
  isExploreToolCall,
  isShellToolCallAwaitingCommand,
} from "@/lib/exploreToolCall.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  isConversationReasoningRowVisible,
  type ConversationReasoningVisibility,
} from "@/v4/conversationRowContext.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import {
  ENABLE_CUA_TOOL_CALL_GROUPING,
  prepareCuaGroups,
  type ConversationCuaGroupRenderItem,
} from "@/v4/conversationCuaGroups.js";

export type ConversationAssistantWorkRenderItem =
  | {
      kind: "row";
      key: string;
      row: AssistantWorkRow;
    }
  | {
      kind: "exploreGroup";
      key: string;
      rowId: number;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | ConversationCuaGroupRenderItem
  | {
      kind: "executeGroup";
      key: string;
      rowId: number;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | {
      kind: "changesGroup";
      key: string;
      rowId: number;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | {
      kind: "agentToolCall";
      key: string;
      row: ToolCallRow;
      subagentRow: SubagentRow;
    };

export const ENABLE_EXPLORE_TOOL_CALL_GROUPING = true;
export { ENABLE_CUA_TOOL_CALL_GROUPING } from "@/v4/conversationCuaGroups.js";
export const ENABLE_TERMINAL_TOOL_CALL_GROUPING = true;
export const ENABLE_CHANGES_TOOL_CALL_GROUPING = false;

interface ConversationAssistantWorkRenderOptions {
  stageTailIsRunning?: boolean;
  enableCuaGrouping?: boolean;
  enableExploreGrouping?: boolean;
  enableTerminalGrouping?: boolean;
  enableChangesGrouping?: boolean;
}

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);

const isToolCallRow = (row: AssistantWorkRow): row is ToolCallRow => row.kind === "toolCall";

const isAgentToolCallRow = (row: AssistantWorkRow): row is ToolCallRow =>
  isToolCallRow(row) && SUBAGENT_TOOL_NAMES.has(row.toolName);

function isExploreToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExploreToolCall({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function isExecuteToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExecuteToolCall({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function isChangesToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) return false;
  return resolveToolCallIdentity(toolCallRowToLegacyNode(row).toolCall).family === "file-write";
}

function shouldDeferUnclassifiedShellToolCall(row: AssistantWorkRow): boolean {
  if (!isToolCallRow(row) || (row.status !== "inputStreaming" && row.status !== "running")) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isShellToolCallAwaitingCommand({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function resolveGroupStageStatus(
  rows: readonly ToolCallRow[],
  stageTailIsRunning: boolean,
): string {
  // Explore/Execute 父节点表达的是当前工作阶段，不是子工具执行状态的汇总。
  // 子工具可能已经全部完成，但只要当前运行工作段尚未出现下一条可见边界，父阶段仍在继续；
  // 反之，后续非当前分组内容已经出现时，即使迟到的子状态仍是 running，父阶段也必须结束。
  if (stageTailIsRunning) return "in_progress";
  return rows.some((row) => row.status === "cancelled") ? "stopped" : "completed";
}

function buildExploreGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  // 分组 builder 只会在连续同类工具达到两项后调用；空数组不是合法状态，
  // 不再用伪造 identity 的兜底掩盖调用方错误。
  const firstRow = rows[0]!;
  const childToolCalls = rows.map(toolCallRowToLegacyNode);

  return {
    kind: "exploreGroup" as const,
    // 旧 key/toolId 包含末尾 row 和数量，每新增一个 Explore 子工具都会重建组件，
    // 并让 ToolLayout 用新的 toolId 读取不到用户刚保存的展开状态。聚合身份锚定首个子工具，
    // 后续只更新 children，保证流式增长期间 React identity 和展开状态 identity 都稳定。
    key: `explore:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `explore:${firstRow.toolCallId}`,
        toolName: "Explore",
        kind: "Explore",
        title: "Explore",
        input: {},
        status: resolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: typeof firstRow.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls,
    },
  };
}

function buildExecuteGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  const firstRow = rows[0]!;
  return {
    kind: "executeGroup" as const,
    // 分组 identity 如果包含末项或数量，流式新增命令会重建父组件并丢失展开状态。
    // 与 Explore 一样锚定首个真实 tool call，后续只更新 children。
    key: `execute:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `execute:${firstRow.toolCallId}`,
        toolName: "ExecuteGroup",
        kind: "executeGroup",
        title: "Execute",
        input: {},
        status: resolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: typeof firstRow.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

function buildChangesGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  const firstRow = rows[0]!;
  return {
    kind: "changesGroup" as const,
    // Changes 的展开状态必须在流式追加 Write/Edit 时保持稳定，因此身份锚定首个 tool。
    key: `changes:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `changes:${firstRow.toolCallId}`,
        toolName: "ChangesGroup",
        kind: "changesGroup",
        title: "Changes",
        input: {},
        // Changes 是 UI 阶段容器，不是真实工具；子项失败/取消只留在各自明细，
        // 父级仅表达当前阶段是否仍位于可见运行段尾部。
        status: stageTailIsRunning ? "in_progress" : "completed",
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

/**
 * Agent 工具行 ↔ subagent 行必须按 parentToolCallId 精确配对。
 *
 * 同一轮并发 Agent 工具的 tool call 行按模型输出顺序出现，但 SubagentSpawned
 * 事件按异步调度顺序到达；旧 FIFO 会把一个 Agent 的标题与另一个 childSessionId 拼在一起。
 * 仅对缺少新字段的历史数据保留“同 turn 唯一剩余一对”的无歧义兼容。
 */
function pairSubagentRows(rows: readonly AssistantWorkRow[]): {
  subagentByAgentToolRowId: Map<number, SubagentRow>;
  claimedSubagentRowIds: Set<number>;
} {
  const subagentByAgentToolRowId = new Map<number, SubagentRow>();
  const claimedSubagentRowIds = new Set<number>();
  const agentToolByTurnAndCallId = new Map<string, ToolCallRow>();
  const agentToolRows: ToolCallRow[] = [];
  const subagentRows: SubagentRow[] = [];
  const legacySubagentRows: SubagentRow[] = [];

  for (const row of rows) {
    if (isAgentToolCallRow(row)) {
      agentToolRows.push(row);
      agentToolByTurnAndCallId.set(`${row.turnId}\0${row.toolCallId}`, row);
    } else if (row.kind === "subagent") {
      subagentRows.push(row);
    }
  }
  for (const row of subagentRows) {
    if (!row.parentToolCallId) {
      legacySubagentRows.push(row);
      continue;
    }
    const host = agentToolByTurnAndCallId.get(`${row.turnId}\0${row.parentToolCallId}`);
    if (host && host.turnId === row.turnId && !subagentByAgentToolRowId.has(host.rowId)) {
      subagentByAgentToolRowId.set(host.rowId, row);
      claimedSubagentRowIds.add(row.rowId);
    }
  }

  const remainingAgentToolsByTurn = new Map<string, ToolCallRow[]>();
  for (const row of agentToolRows) {
    if (subagentByAgentToolRowId.has(row.rowId)) continue;
    const turnRows = remainingAgentToolsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      remainingAgentToolsByTurn.set(row.turnId, [row]);
    }
  }
  const legacySubagentsByTurn = new Map<string, SubagentRow[]>();
  for (const row of legacySubagentRows) {
    const turnRows = legacySubagentsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      legacySubagentsByTurn.set(row.turnId, [row]);
    }
  }
  for (const [turnId, subagentRows] of legacySubagentsByTurn) {
    const toolRows = remainingAgentToolsByTurn.get(turnId);
    if (toolRows?.length !== 1 || subagentRows.length !== 1) continue;
    const host = toolRows[0];
    const subagent = subagentRows[0];
    if (!host || !subagent) continue;
    subagentByAgentToolRowId.set(host.rowId, subagent);
    claimedSubagentRowIds.add(subagent.rowId);
  }

  return { subagentByAgentToolRowId, claimedSubagentRowIds };
}

export function buildAssistantWorkRenderItems(
  rows: readonly AssistantWorkRow[],
  reasoningVisibility: ConversationReasoningVisibility,
  options?: ConversationAssistantWorkRenderOptions,
): ConversationAssistantWorkRenderItem[] {
  const items: ConversationAssistantWorkRenderItem[] = [];
  const enableExploreGrouping = options?.enableExploreGrouping ?? ENABLE_EXPLORE_TOOL_CALL_GROUPING;
  const enableCuaGrouping = options?.enableCuaGrouping ?? ENABLE_CUA_TOOL_CALL_GROUPING;
  const enableTerminalGrouping =
    options?.enableTerminalGrouping ?? ENABLE_TERMINAL_TOOL_CALL_GROUPING;
  const enableChangesGrouping = options?.enableChangesGrouping ?? ENABLE_CHANGES_TOOL_CALL_GROUPING;
  // Explore 的阶段边界和尾部状态必须基于用户实际可见的行序。等待 command 的 Shell
  // 若只在循环中跳过，仍会占据数组位置，导致前一个 Explore 被误判为已结束；
  // 隐藏 reasoning 也有相同问题。先统一剔除暂不可见行，再做配对、分组和尾部判断。
  const visibleRows = rows.filter((row) => {
    if (
      row.kind === "reasoning" &&
      !isConversationReasoningRowVisible(row.rowId, reasoningVisibility)
    ) {
      return false;
    }
    return !shouldDeferUnclassifiedShellToolCall(row);
  });
  const { subagentByAgentToolRowId, claimedSubagentRowIds } = pairSubagentRows(visibleRows);
  const preparedRows = prepareCuaGroups(
    visibleRows,
    enableCuaGrouping,
    options?.stageTailIsRunning === true,
  );
  let index = 0;

  while (index < preparedRows.length) {
    const row = preparedRows[index];
    if (!row) {
      index += 1;
      continue;
    }

    if (row.kind === "cuaGroup") {
      items.push(row);
      index += 1;
      continue;
    }

    // 已配对进 Agent 块的 subagent 行：不再单独渲染。
    if (row.kind === "subagent" && claimedSubagentRowIds.has(row.rowId)) {
      index += 1;
      continue;
    }
    if (isToolCallRow(row)) {
      const pairedSubagent = subagentByAgentToolRowId.get(row.rowId);
      if (pairedSubagent) {
        items.push({
          kind: "agentToolCall",
          key: `agent:${row.rowId}`,
          row,
          subagentRow: pairedSubagent,
        });
        index += 1;
        continue;
      }
    }

    const isExploreRow = isExploreToolCallRow(row);
    if (!isExploreRow) {
      if (enableChangesGrouping && isChangesToolCallRow(row)) {
        const groupRows: ToolCallRow[] = [row];
        index += 1;
        while (index < preparedRows.length) {
          const nextRow = preparedRows[index];
          if (!nextRow || nextRow.kind === "cuaGroup" || !isChangesToolCallRow(nextRow)) break;
          groupRows.push(nextRow);
          index += 1;
        }
        // 单个工具不需要额外的 UI 合成层；等第二个连续同类工具到达后再升级为父分组。
        if (groupRows.length === 1) {
          const singleRow = groupRows[0]!;
          items.push({ kind: "row", key: `row:${singleRow.rowId}`, row: singleRow });
          continue;
        }
        items.push(
          buildChangesGroup(
            groupRows,
            options?.stageTailIsRunning === true && index === preparedRows.length,
          ),
        );
        continue;
      }
      if (enableTerminalGrouping && isExecuteToolCallRow(row)) {
        const groupRows: ToolCallRow[] = [row];
        index += 1;
        while (index < preparedRows.length) {
          const nextRow = preparedRows[index];
          if (!nextRow || nextRow.kind === "cuaGroup" || !isExecuteToolCallRow(nextRow)) {
            break;
          }
          groupRows.push(nextRow);
          index += 1;
        }
        // 单个工具保留自身语义和渲染，避免只包含一个子项的 Terminal 容器。
        if (groupRows.length === 1) {
          const singleRow = groupRows[0]!;
          items.push({ kind: "row", key: `row:${singleRow.rowId}`, row: singleRow });
          continue;
        }
        items.push(
          buildExecuteGroup(
            groupRows,
            options?.stageTailIsRunning === true && index === preparedRows.length,
          ),
        );
        continue;
      }
      items.push({
        kind: "row",
        key: `row:${row.rowId}`,
        row,
      });
      index += 1;
      continue;
    }

    if (!enableExploreGrouping) {
      items.push({
        kind: "row",
        key: `row:${row.rowId}`,
        row,
      });
      index += 1;
      continue;
    }

    const groupRows: ToolCallRow[] = [row];
    index += 1;
    while (index < preparedRows.length) {
      const nextRow = preparedRows[index];
      if (!nextRow || nextRow.kind === "cuaGroup" || !isExploreToolCallRow(nextRow)) {
        break;
      }
      groupRows.push(nextRow);
      index += 1;
    }
    // Explore 只有在出现第二个连续只读工具后才成立；首项必须立即按原工具展示。
    if (groupRows.length === 1) {
      items.push({ kind: "row", key: `row:${row.rowId}`, row });
      continue;
    }
    items.push(
      buildExploreGroup(
        groupRows,
        options?.stageTailIsRunning === true && index === preparedRows.length,
      ),
    );
  }

  return items;
}

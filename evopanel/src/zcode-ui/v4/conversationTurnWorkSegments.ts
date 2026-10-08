import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ENABLE_CUA_TOOL_CALL_GROUPING,
  prepareCuaGroupFlowItems,
} from "@/v4/conversationCuaGroups.js";
import { buildConversationFlowItems } from "@/v4/conversationTurnFlowItems.js";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";

export interface ConversationTurnWorkStatus {
  state: "running" | "completed" | "interrupted";
  durationMs?: number;
}

export interface ConversationTurnWorkSegment {
  key: string;
  triggerRow?: UserInputRow;
  flowItems: ConversationTurnFlowItem[];
  assistantWorkRows: AssistantWorkRow[];
  assistantHistoryRows: AssistantWorkRow[];
  assistantFollowingRows: AssistantWorkRow[];
  assistantHistoryDefaultOpen: boolean;
  workStatus?: ConversationTurnWorkStatus;
}

export function resolveConversationTurnWorkStatus(
  header: TurnHeaderRow | undefined,
  workRows: readonly AssistantWorkRow[],
  isRunning: boolean,
  durationMs: number | undefined,
  isInterrupted = false,
): ConversationTurnWorkStatus | undefined {
  if (header?.executionKind === "controlOnly") return undefined;
  const hasWork =
    isRunning ||
    workRows.length > 0 ||
    (header?.executionKind === "agent" ? durationMs !== undefined : (durationMs ?? 0) > 0);
  if (!hasWork) return undefined;
  return {
    state: isRunning ? "running" : isInterrupted ? "interrupted" : "completed",
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function resolveConversationTurnWorkDurationMs(
  header: TurnHeaderRow | undefined,
  options: { nowMs?: number },
  isRunning: boolean,
): number | undefined {
  if (!header) return undefined;
  if (header.activeMs !== undefined) return header.activeMs;
  if (header.endedAt !== undefined) return Math.max(header.endedAt - header.startedAt, 0);
  // UI 每秒传入 nowMs 只用于运行中“工作中 N 秒”；完成态缺少
  // activeMs/endedAt 时不能继续吃当前时钟，否则历史“已工作”会随时间增长。
  if (isRunning && options.nowMs !== undefined) {
    return Math.max(options.nowMs - header.startedAt, 0);
  }
  return undefined;
}

interface DraftVisualWorkSegment {
  orderedRows: ConversationRow[];
  triggerRow?: UserInputRow;
}

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isAssistantWorkRow(row: ConversationRow): row is AssistantWorkRow {
  return row.kind !== "turnHeader" && row.kind !== "userInput";
}

function splitVisualWorkSegments(rows: readonly ConversationRow[]): DraftVisualWorkSegment[] {
  const segments: DraftVisualWorkSegment[] = [];
  let current: DraftVisualWorkSegment = { orderedRows: [] };
  for (const row of rows) {
    if (isUserInputRow(row) && row.guided === true && current.orderedRows.length > 0) {
      segments.push(current);
      current = { orderedRows: [], triggerRow: row };
    }
    current.orderedRows.push(row);
  }
  if (current.orderedRows.length > 0) segments.push(current);
  return segments;
}

function resolveSegmentDurationMs(options: {
  header?: TurnHeaderRow;
  segmentIndex: number;
  triggerRow?: UserInputRow;
  nextTriggerRow?: UserInputRow;
  segmentRunning: boolean;
  segmentCount: number;
  nowMs?: number;
}): number | undefined {
  const fact =
    (options.triggerRow?.entityId
      ? options.header?.workSegments?.find(
          (candidate) => candidate.triggerEntityId === options.triggerRow?.entityId,
        )
      : undefined) ?? options.header?.workSegments?.[options.segmentIndex];
  if (fact?.activeMs !== undefined) return fact.activeMs;
  if (fact?.endedAt !== undefined) return Math.max(0, fact.endedAt - fact.startedAt);
  if (fact && options.segmentRunning && options.nowMs !== undefined) {
    return Math.max(0, options.nowMs - fact.startedAt);
  }
  if (options.segmentCount === 1) {
    return resolveConversationTurnWorkDurationMs(
      options.header,
      { nowMs: options.nowMs },
      options.segmentRunning,
    );
  }
  // 兼容旧 guide snapshot：新 CLI 会下发 workSegments；仅旧数据缺事实时才按
  // guided row 的稳定时间边界恢复，避免刷新后又退回整个 turn 的单一工时。
  const startedAt = options.triggerRow?.createdAt ?? options.header?.startedAt;
  const endedAt = options.nextTriggerRow?.createdAt ?? options.header?.endedAt;
  if (startedAt !== undefined && endedAt !== undefined) return Math.max(0, endedAt - startedAt);
  if (startedAt !== undefined && options.segmentRunning && options.nowMs !== undefined) {
    return Math.max(0, options.nowMs - startedAt);
  }
  return undefined;
}

export function buildConversationTurnWorkSegments(options: {
  key: string;
  header?: TurnHeaderRow;
  orderedRows: readonly ConversationRow[];
  assistantTailRows: readonly AssistantWorkRow[];
  latestAssistantTextRow?: AssistantTextRow;
  isRunning: boolean;
  isLastTurn: boolean;
  isInterrupted: boolean;
  forceOpenHistory: boolean;
  timelineOnly: boolean;
  nowMs?: number;
}): ConversationTurnWorkSegment[] {
  const visualDrafts = splitVisualWorkSegments(options.orderedRows);
  const tailRowIds = new Set(options.assistantTailRows.map((row) => row.rowId));
  return visualDrafts.map((segment, segmentIndex) => {
    const segmentAssistantRows = segment.orderedRows.filter(isAssistantWorkRow);
    const segmentTailRows = segmentAssistantRows.filter((row) => tailRowIds.has(row.rowId));
    const segmentFlowRows = segmentAssistantRows.filter((row) => !tailRowIds.has(row.rowId));
    const lastSegmentFlowRow = segmentFlowRows.at(-1);
    const segmentCompleted = segmentIndex < visualDrafts.length - 1 || !options.isRunning;
    const productLatestAssistantTextRow = options.latestAssistantTextRow
      ? segmentFlowRows.find((row) => row.rowId === options.latestAssistantTextRow?.rowId)
      : undefined;
    const visibleAssistantTextRow =
      productLatestAssistantTextRow && isAssistantTextRow(productLatestAssistantTextRow)
        ? productLatestAssistantTextRow
        : segmentCompleted && lastSegmentFlowRow && isAssistantTextRow(lastSegmentFlowRow)
          ? lastSegmentFlowRow
          : undefined;
    const visibleAssistantIndex = visibleAssistantTextRow
      ? segmentFlowRows.findIndex((row) => row.rowId === visibleAssistantTextRow.rowId)
      : -1;
    const segmentHistoryRows = options.timelineOnly
      ? []
      : visibleAssistantIndex < 0
        ? segmentFlowRows
        : segmentFlowRows.slice(0, visibleAssistantIndex);
    const segmentFollowingRows =
      visibleAssistantIndex < 0 ? [] : segmentFlowRows.slice(visibleAssistantIndex + 1);
    const segmentRunning = segmentIndex === visualDrafts.length - 1 && options.isRunning;
    const segmentDurationMs = resolveSegmentDurationMs({
      header: options.header,
      segmentIndex,
      triggerRow: segment.triggerRow,
      nextTriggerRow: visualDrafts[segmentIndex + 1]?.triggerRow,
      segmentRunning,
      segmentCount: visualDrafts.length,
      nowMs: options.nowMs,
    });
    const segmentWorkStatus = resolveConversationTurnWorkStatus(
      options.header,
      segmentFlowRows,
      segmentRunning,
      segmentDurationMs,
      options.isInterrupted && segmentIndex === visualDrafts.length - 1,
    );
    const segmentKey =
      segmentIndex === 0
        ? options.key
        : `${options.key}:guide:${segment.triggerRow?.entityId ?? segment.triggerRow?.rowId ?? segmentIndex}`;
    const flowItems = buildConversationFlowItems({
      orderedRows: segment.orderedRows,
      assistantHistoryRows: segmentHistoryRows,
      assistantFollowingRows: segmentFollowingRows,
      assistantTailRows: segmentTailRows,
      ...(visibleAssistantTextRow ? { visibleAssistantTextRow } : {}),
      ...(options.latestAssistantTextRow
        ? { latestAssistantTextRow: options.latestAssistantTextRow }
        : {}),
      timelineOnly: options.timelineOnly,
    });
    return {
      key: segmentKey,
      ...(segment.triggerRow ? { triggerRow: segment.triggerRow } : {}),
      flowItems: prepareCuaGroupFlowItems(flowItems, {
        enabled: ENABLE_CUA_TOOL_CALL_GROUPING,
        stageTailIsRunning: segmentRunning,
      }),
      assistantWorkRows: segmentAssistantRows,
      assistantHistoryRows: segmentHistoryRows,
      assistantFollowingRows: segmentFollowingRows,
      assistantHistoryDefaultOpen:
        !options.timelineOnly &&
        (options.forceOpenHistory ||
          (options.isLastTurn && segmentWorkStatus?.state === "running") ||
          (visualDrafts.length === 1 &&
            visibleAssistantTextRow === undefined &&
            segmentFlowRows.length > 0)),
      ...(segmentWorkStatus ? { workStatus: segmentWorkStatus } : {}),
    };
  });
}

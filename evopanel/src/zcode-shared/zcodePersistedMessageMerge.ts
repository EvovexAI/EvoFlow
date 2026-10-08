import type { ZCodePersistedMessage, ZCodePersistedMessagePart } from "./zcode-task-types-core.js";

// ZCode runtime 把同一个 user turn 里**每一轮 LLM 调用**落成独立的 assistant 消息（各带 time.created/completed）。
// 老 task projection 模型每个 turn 只有一条 assistant，UI 也按这个模型设计（一条 assistant → 一个"已工作 X 秒"块）。
// 这里把映射后相邻的 assistant 合并回一条，恢复"一个 turn 一条 assistant"的不变式；
// 旧投影数据本身就是严格交替的，对它来说是 no-op。
//
// 顺便把 turnIndex 显式按 user 计数赋值，修掉 `toTaskChatMessages` 的兜底
// `Math.floor(index / 2)` 在多 assistant 时算错的次要 bug。
export function coalesceConsecutiveZCodeAssistants(
  messages: readonly ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const merged: ZCodePersistedMessage[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    // compact/fork/goal verifier 这类 synthetic timeline 虽然 role 是 assistant，
    // 但它们是消息边界，不是同一轮正文；参与合并会吞掉横线并把维护时间算进上一条回复。
    if (
      message.role === "assistant" &&
      last?.role === "assistant" &&
      !last.syntheticTimeline &&
      !message.syntheticTimeline &&
      last.goalIteration === message.goalIteration
    ) {
      merged[merged.length - 1] = mergeAssistantPair(last, message);
      continue;
    }
    merged.push(message);
  }

  let turn = -1;
  return merged.map((message) => {
    if (message.role === "user") {
      turn += 1;
    }
    const effectiveTurn = turn < 0 ? 0 : turn;
    return message.turnIndex === effectiveTurn ? message : { ...message, turnIndex: effectiveTurn };
  });
}

function mergeAssistantPair(
  first: ZCodePersistedMessage,
  next: ZCodePersistedMessage,
): ZCodePersistedMessage {
  const firstTools = first.tools ?? [];
  const nextTools = next.tools ?? [];
  const mergedTools =
    firstTools.length + nextTools.length > 0 ? [...firstTools, ...nextTools] : undefined;

  const toolIndexOffset = firstTools.length;
  const firstParts = first.parts ?? [];
  const shiftedNextParts: ZCodePersistedMessagePart[] = (next.parts ?? []).map((part) =>
    part.type === "tool-call"
      ? { type: "tool-call", toolIndex: part.toolIndex + toolIndexOffset }
      : part,
  );
  const mergedParts =
    firstParts.length + shiftedNextParts.length > 0
      ? [...firstParts, ...shiftedNextParts]
      : undefined;

  const mergedContent = first.content + next.content;
  const mergedThought =
    first.thought === undefined && next.thought === undefined
      ? undefined
      : (first.thought ?? "") + (next.thought ?? "");

  // 任一轮还没有 completed time 就视为整 turn 未结束；duration 留空让 UI 显示"工作中"。
  const durationMs =
    first.durationMs === undefined || next.durationMs === undefined
      ? undefined
      : Math.max(next.timestamp + next.durationMs - first.timestamp, 0);

  const characterCount =
    first.characterCount === undefined && next.characterCount === undefined
      ? undefined
      : mergedContent.length;
  const mergedMessageIds = collectMergedMessageIds(first, next);

  return {
    ...first,
    content: mergedContent,
    timestamp: first.timestamp,
    model: next.model ?? first.model,
    durationMs,
    characterCount,
    interrupted: next.interrupted ?? first.interrupted,
    feedback: next.feedback ?? first.feedback,
    mergedMessageIds: mergedMessageIds.length > 0 ? mergedMessageIds : undefined,
    goalIteration: next.goalIteration ?? first.goalIteration,
    attachments: next.attachments ?? first.attachments,
    tools: mergedTools,
    thought: mergedThought,
    parts: mergedParts,
    checkpointState: next.checkpointState ?? first.checkpointState,
    checkpointReason: next.checkpointReason ?? first.checkpointReason,
    checkpointUpdatedAt: next.checkpointUpdatedAt ?? first.checkpointUpdatedAt,
    bodyRefs: next.bodyRefs ?? first.bodyRefs,
    toolSlice: next.toolSlice ?? first.toolSlice,
  };
}

function collectMergedMessageIds(
  first: ZCodePersistedMessage,
  next: ZCodePersistedMessage,
): string[] {
  const ids = [
    first.id,
    ...(first.mergedMessageIds ?? []),
    next.id,
    ...(next.mergedMessageIds ?? []),
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

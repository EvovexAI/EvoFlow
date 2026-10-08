// ZCode Protocol v4 Apply — verbatim copy from ZCode/packages/shared/src/zcode-protocol-v4/apply.ts
import type { ConversationDelta } from "./delta.js";
import type { ConversationSnapshot } from "./snapshot.js";
import type { ConversationRow } from "./rows.js";
import type { StreamablePath } from "./core.js";

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
      return { ...snapshot, ...delta.patch };
  }
}

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

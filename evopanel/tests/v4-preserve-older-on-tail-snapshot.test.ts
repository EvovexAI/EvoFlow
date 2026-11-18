import { describe, expect, it } from "vitest";
import type { ConversationRow, ConversationSnapshot } from "../src/zcode-shared/zcode-protocol-v4/index.ts";
import { mergePreservedOlderRowsIntoTailSnapshot } from "../src/zcode-ui/v4/conversationProjectionStore.ts";

function textRow(rowId: number, turnId: string, text: string): ConversationRow {
  return {
    rowId,
    turnId,
    kind: "assistantText",
    text,
    state: "complete",
    createdAt: rowId,
    createdAtSeq: 0,
  } as ConversationRow;
}

function snap(
  window: ConversationRow[],
  opts?: { totalCount?: number; firstRowId?: number | null; logEpoch?: string },
): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "s1",
    logEpoch: opts?.logEpoch ?? "1",
    seq: 100,
    revision: 1,
    control: {
      phase: "completed",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "assistant",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {} as ConversationSnapshot["availability"],
    inputRouting: {} as ConversationSnapshot["inputRouting"],
    meta: { title: "", titleSource: "default" },
    config: {} as ConversationSnapshot["config"],
    modelTransition: null,
    usage: {} as ConversationSnapshot["usage"],
    permission: {} as ConversationSnapshot["permission"],
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
    rows: {
      window,
      totalCount: opts?.totalCount ?? 100,
      firstRowId: opts?.firstRowId ?? 1,
    },
  } as ConversationSnapshot;
}

describe("mergePreservedOlderRowsIntoTailSnapshot", () => {
  it("同 epoch：前插客户端已 loadOlder 的更早行，不被尾窗整窗替换冲掉", () => {
    const previous = snap(
      [
        textRow(1, "old", "最早"),
        textRow(2, "old", "次早"),
        textRow(50, "mid", "已加载中段"),
        textRow(80, "live", "旧尾"),
      ],
      { firstRowId: 1, totalCount: 100 },
    );
    const incoming = snap(
      [textRow(80, "live", "新尾A"), textRow(81, "live", "新尾B")],
      { firstRowId: 1, totalCount: 100 },
    );

    const merged = mergePreservedOlderRowsIntoTailSnapshot(previous, incoming);
    const ids = merged.rows.window.map((r) => r.rowId);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(50);
    expect(ids).toContain(80);
    expect(ids).toContain(81);
    expect(merged.rows.window.find((r) => r.rowId === 80)?.text).toBe("新尾A");
  });

  it("epoch 变化：整窗替换，不粘旧纪元行", () => {
    const previous = snap([textRow(1, "old", "旧纪元")], { logEpoch: "1" });
    const incoming = snap([textRow(90, "new", "新纪元")], { logEpoch: "2" });
    const merged = mergePreservedOlderRowsIntoTailSnapshot(previous, incoming);
    expect(merged.rows.window.map((r) => r.rowId)).toEqual([90]);
  });

  it("prev 没有更早行：原样返回 incoming", () => {
    const previous = snap([textRow(80, "live", "a"), textRow(81, "live", "b")]);
    const incoming = snap([textRow(80, "live", "A"), textRow(81, "live", "B")]);
    const merged = mergePreservedOlderRowsIntoTailSnapshot(previous, incoming);
    expect(merged).toBe(incoming);
  });
});

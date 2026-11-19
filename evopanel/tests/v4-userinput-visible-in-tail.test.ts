/**
 * Live V4 tail / soft-cap must keep the latest realUser userInput renderable.
 * Repro: long tool streams after send → user bubble "missing" while hub still has it.
 */
import { describe, expect, it } from "vitest";
import {
  buildConversationTurnRenderUnits,
  normalizeOrderedRowsUserFirst,
} from "../src/zcode-ui/v4/conversationTurnRenderUnits.ts";
import { capProjectionWindow } from "../src/zcode-ui/v4/projectionWindowCap.ts";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function turnHeader(rowId: number, turnId: string): ConversationRow {
  return {
    rowId,
    turnId,
    kind: "turnHeader",
    state: "running",
    startedAt: rowId,
  } as ConversationRow;
}

function userInput(rowId: number, turnId: string, text: string): ConversationRow {
  return {
    rowId,
    turnId,
    kind: "userInput",
    origin: "realUser",
    text,
    createdAt: rowId,
  } as ConversationRow;
}

function toolCall(rowId: number, turnId: string): ConversationRow {
  return {
    rowId,
    turnId,
    kind: "toolCall",
    toolCallId: `tc-${rowId}`,
    toolName: "bash",
    name: "bash",
    status: "completed",
  } as ConversationRow;
}

describe("v4 userInput visibility in live tail", () => {
  it("cap over-limit keeps tail; store no longer trims on delta apply (ZCode 语义)", () => {
    // 2026-11-15 回撤：软顶裁切不再作用于 delta 帧（直播窗口只增不减，用户气泡
    // 不会被裁出窗口）；cap 纯函数只保留 tail 裁切语义（snapshot apply / 合并路径用）。
    // 直播期可见性由「服务端行内载荷截断 + 快照后 autoBackfillForRestore」保证。
    const turnId = "t-live";
    const rows: ConversationRow[] = [turnHeader(1, turnId), userInput(2, turnId, "HELLO_USER")];
    for (let i = 0; i < 120; i += 1) rows.push(toolCall(3 + i, turnId));

    const capped = capProjectionWindow(rows, 40, "tail");
    expect(capped[capped.length - 1]?.rowId).toBe(122);
    expect(capped.length).toBeLessThanOrEqual(80);
  });

  it("puts realUser into flowItems for a live running unit", () => {
    const turnId = "t-live";
    const rows: ConversationRow[] = [
      turnHeader(1, turnId),
      userInput(2, turnId, "钉住我"),
      toolCall(3, turnId),
      toolCall(4, turnId),
    ];
    const units = buildConversationTurnRenderUnits(rows, {
      sessionBusy: true,
      sessionPhase: "running",
    });
    expect(units.length).toBe(1);
    expect(units[0]?.isRunning).toBe(true);
    const visible = units.flatMap((u) => u.visibleUserInputs.map((r) => r.text));
    const flowUsers = units.flatMap((u) =>
      (u.workSegments ?? []).flatMap((s) =>
        s.flowItems
          .filter((i) => i.kind === "userInput")
          .map((i) => (i.kind === "userInput" ? i.row.text : "")),
      ),
    );
    expect(visible).toContain("钉住我");
    expect(flowUsers).toContain("钉住我");
  });
});

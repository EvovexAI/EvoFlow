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
import {
  mergeOptimisticUserInputRow,
  v4WindowHasUserText,
} from "../src/react/v4/optimisticUserInput.ts";
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

describe("乐观行 entityId(messageId) 精确认领（对齐 ZCode sourceCommandId 语义）", () => {
  function userRow(rowId: number, text: string, entityId?: string): ConversationRow {
    return {
      rowId,
      turnId: `t-${rowId}`,
      kind: "userInput",
      origin: "realUser",
      text,
      ...(entityId ? { entityId } : {}),
      createdAt: rowId,
    } as ConversationRow;
  }

  it("entityId 精确命中 → echo=true（文本被分页挤出尾窗也认领）", () => {
    const rows: ConversationRow[] = [
      userRow(1, "历史消息甲"),
      userRow(2, "长回合挤占位的工具轮消息", "m-other"),
    ];
    // 2026-11-08 实锤场景：文本「再帮我调用…」被挤出尾窗后 endsWith 永不命中
    expect(v4WindowHasUserText(rows, "再帮我调用，然后试一下我验证功能呢", "m-mine")).toBe(false);
    expect(
      v4WindowHasUserText(
        [...rows, userRow(3, "再帮我调用，然后试一下我验证功能呢", "m-mine")],
        "再帮我调用，然后试一下我验证功能呢",
        "m-mine",
      ),
    ).toBe(true);
  });

  it("entityId 不匹配不得靠文本误判（同文案二次发送场景）", () => {
    const rows: ConversationRow[] = [
      userRow(1, "再帮我调用", "m-old"),
    ];
    // 同文案重发：新 send 的 id 是 m-new，旧行不认领 → 乐观行必须照常叠加
    expect(v4WindowHasUserText(rows, "再帮我调用", "m-new")).toBe(false);
    const merged = mergeOptimisticUserInputRow(rows, "再帮我调用", "m-new");
    expect(merged.length).toBe(2);
    expect((merged[1] as { entityId?: string }).entityId).toBe("m-new");
  });

  it("无 id（IM/旧路径）回退文本匹配；有 id 时乐观行带 entityId", () => {
    const rows: ConversationRow[] = [userRow(1, "再帮我调用", "m-old")];
    expect(v4WindowHasUserText(rows, "再帮我调用")).toBe(true);
    const merged = mergeOptimisticUserInputRow([userRow(9, "上一轮")], "新消息", "m-mine");
    expect((merged[1] as { entityId?: string }).entityId).toBe("m-mine");
  });
});

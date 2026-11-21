/**
 * ConversationRowPool / shareStructure 单元测试（移植自 ZCode conversationRowSharing）。
 *
 * 契约：值深相等的行/子值换回旧引用（只复用身份不改语义）——快照替换不再全列表
 * 换身份，行级 memo 跨快照命中。绝不修改 next（可能与 apply 产出的其他快照共享结构）。
 *
 * 运行：npx vitest run tests/conversation-row-sharing.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  ConversationRowPool,
  shareStructure,
} from "../src/zcode-ui/v4/conversationRowSharing.ts";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function row(rowId: number, text: string, extra?: Record<string, unknown>): ConversationRow {
  return {
    rowId,
    turnId: `t-${rowId}`,
    kind: "assistantText",
    text,
    state: "complete",
    ...extra,
  } as ConversationRow;
}

describe("shareStructure", () => {
  it("整体相等返回 prev 引用（含等值字符串换回 prev）", () => {
    const prev = { a: "hello", list: [1, 2, 3] };
    const next = JSON.parse(JSON.stringify(prev)) as typeof prev;
    const shared = shareStructure(prev, next);
    expect(shared).toBe(prev);
  });

  it("部分相等：新外壳挂回 prev 子值", () => {
    const prev = { keep: "same", inner: { deep: "old-string-ref" }, changed: 1 };
    const next = { keep: "same", inner: { deep: "old-string-ref" }, changed: 2 };
    const shared = shareStructure(prev, next);
    expect(shared).not.toBe(prev);
    expect(shared).not.toBe(next);
    expect((shared as typeof prev).inner).toBe(prev.inner); // 深相等子对象复用 prev
    expect((shared as typeof prev).changed).toBe(2);
  });

  it("绝不修改 next（next 可能与 apply 产出的其他快照共享）", () => {
    const prev = { a: 1 };
    const next = { a: 1, b: 2 };
    const snapshotNext = { ...next };
    shareStructure(prev, snapshotNext);
    expect(snapshotNext).toEqual({ a: 1, b: 2 });
  });

  it("数组：长度相同且逐项相等复用 prev 数组；不同则逐项共享", () => {
    const prev = [1, 2, 3];
    expect(shareStructure(prev, [1, 2, 3])).toBe(prev);
    const prevRows = [{ id: 1, t: "a" }];
    const nextRows = [{ id: 1, t: "a" }, { id: 2, t: "b" }];
    const shared = shareStructure(prevRows, nextRows) as typeof nextRows;
    expect(shared[0]).toBe(prevRows[0]); // 首项深相等 → prev 引用
    expect(shared[1]).toEqual({ id: 2, t: "b" });
  });
});

describe("ConversationRowPool", () => {
  it("shareRow：深相等新行复用池中旧引用", () => {
    const pool = new ConversationRowPool();
    const old = row(7, "同一段 inputText", { toolName: "bash" });
    expect(pool.shareRow("topic-a", old)).toBe(old); // 池空 → 原引用并登记
    const fresh = JSON.parse(JSON.stringify(old)) as ConversationRow;
    const shared = pool.shareRow("topic-a", fresh);
    expect(shared).toBe(old); // 深相等 → 旧引用
    expect(shared).not.toBe(fresh);
  });

  it("shareRow：内容不同 → 新引用（不丢新内容）", () => {
    const pool = new ConversationRowPool();
    pool.shareRow("t", row(1, "旧文本"));
    const changed = pool.shareRow("t", row(1, "新文本"));
    expect((changed as { text?: string }).text).toBe("新文本");
  });

  it("池按 topic + rowId 分键：跨 topic 不串", () => {
    const pool = new ConversationRowPool();
    const a = pool.shareRow("topic-a", row(3, "A 会话的行"));
    const b = pool.shareRow("topic-b", row(3, "B 会话的行"));
    expect((a as { text?: string }).text).toBe("A 会话的行");
    expect((b as { text?: string }).text).toBe("B 会话的行");
  });

  it("shareWindow：整窗深相等复用 prevWindow 数组（快照零换引用）", () => {
    const pool = new ConversationRowPool();
    const prevWindow = [row(1, "a"), row(2, "b")];
    for (const r of prevWindow) pool.shareRow("t", r);
    const freshWindow = [
      JSON.parse(JSON.stringify(prevWindow[0])) as ConversationRow,
      JSON.parse(JSON.stringify(prevWindow[1])) as ConversationRow,
    ];
    const shared = pool.shareWindow("t", freshWindow, prevWindow);
    expect(shared).toBe(prevWindow);
  });

  it("shareWindow：部分行变化 → 变化行新引用、未变行复用", () => {
    const pool = new ConversationRowPool();
    const prevWindow = [row(1, "a"), row(2, "b"), row(3, "c")];
    for (const r of prevWindow) pool.shareRow("t", r);
    const freshWindow = [
      JSON.parse(JSON.stringify(prevWindow[0])) as ConversationRow,
      row(2, "b-已更新"), // 内容变了 → 新引用
      JSON.parse(JSON.stringify(prevWindow[2])) as ConversationRow,
    ];
    const shared = pool.shareWindow("t", freshWindow, prevWindow);
    expect(shared).not.toBe(prevWindow);
    expect(shared[0]).toBe(prevWindow[0]);
    expect(shared[1]).not.toBe(prevWindow[1]);
    expect((shared[1] as { text?: string }).text).toBe("b-已更新");
    expect(shared[2]).toBe(prevWindow[2]);
  });
});

import { describe, expect, it } from "vitest";
import {
  clearViewportStreamTap,
  listViewportStreamTapEntries,
  pushViewportStreamAguiTap,
  pushViewportStreamV4Tap,
  sessionIdFromV4Topic,
  summarizeV4Delta,
} from "../src/react/v4/v4-viewport-stream-tap.js";

describe("v4-viewport-stream-tap", () => {
  it("parses conversation topic → sessionId", () => {
    expect(sessionIdFromV4Topic("conversation/abc-123")).toBe("abc-123");
    expect(sessionIdFromV4Topic("sessions/abc")).toBe("");
  });

  it("filters V4 frames by current page tid（不把旁路会话 SSE 混进浮层）", () => {
    clearViewportStreamTap();
    pushViewportStreamV4Tap({
      topic: "conversation/tid-current",
      deliveryKind: "online",
      frame: {
        fromSeq: 1,
        toSeq: 2,
        payload: { kind: "deltas", deltas: [{ op: "row.delta", rowId: 1 }] },
      },
    });
    pushViewportStreamV4Tap({
      topic: "conversation/tid-other",
      deliveryKind: "online",
      frame: {
        fromSeq: 10,
        toSeq: 11,
        payload: { kind: "deltas", deltas: [{ op: "row.appended" }] },
      },
    });
    pushViewportStreamAguiTap({
      sessionKey: "agent:main:x",
      data: { type: "TEXT_MESSAGE_CONTENT", threadId: "tid-current", delta: "hi" },
    });

    const mine = listViewportStreamTapEntries({ sessionId: "tid-current", limit: 20 });
    expect(mine.length).toBe(2);
    expect(mine.every((e) => e.sessionId === "tid-current")).toBe(true);
    expect(mine.every((e) => !e.headline.includes("tid-other"))).toBe(true);

    const all = listViewportStreamTapEntries({ includeForeign: true, limit: 20 });
    expect(all.length).toBe(3);
    clearViewportStreamTap();
  });

  it("按 delta 分行：类型+摘要（思考/正文/工具名）可扫，不挤成一坨", () => {
    clearViewportStreamTap();
    pushViewportStreamV4Tap({
      topic: "conversation/tid-a",
      deliveryKind: "online",
      frame: {
        fromSeq: 10,
        toSeq: 12,
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.appended",
              row: {
                rowId: 80,
                kind: "reasoning",
                text: "我先核实插件状态",
                state: "streaming",
              },
            },
            {
              op: "row.delta",
              rowId: 80,
              path: "text",
              append: "，不凭记忆瞎说。",
            },
          ],
        },
      },
    });
    pushViewportStreamV4Tap({
      topic: "conversation/tid-a",
      deliveryKind: "online",
      frame: {
        fromSeq: 12,
        toSeq: 14,
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.appended",
              row: {
                rowId: 81,
                kind: "assistantText",
                text: "我先核实一下电脑控制插件",
                state: "streaming",
              },
            },
            {
              op: "row.appended",
              row: {
                rowId: 82,
                kind: "toolCall",
                toolName: "bash",
                status: "inputStreaming",
                inputText: '{"command":"ls"}',
              },
            },
          ],
        },
      },
    });

    const entries = listViewportStreamTapEntries({ sessionId: "tid-a", limit: 10 });
    // 2 帧共 4 条 delta → 4 行
    expect(entries.length).toBe(4);
    expect(entries[0]?.kindLabel).toBe("思考");
    expect(entries[0]?.summary).toContain("核实");
    expect(entries[0]?.headline).toMatch(/#80/);
    expect(entries[1]?.kindLabel).toBe("思考");
    expect(entries[2]?.kindLabel).toBe("正文");
    expect(entries[2]?.summary).toContain("电脑控制");
    expect(entries[3]?.kindLabel).toBe("工具");
    expect(entries[3]?.summary).toContain("bash");

    const deltaLine = summarizeV4Delta({
      op: "row.delta",
      rowId: 80,
      path: "text",
      append: "续写思考",
    });
    expect(deltaLine.kindLabel).toBe("思考");
    expect(deltaLine.line).toContain("思考");
    expect(deltaLine.summary).toContain("续写思考");
    clearViewportStreamTap();
  });
});

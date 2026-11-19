import { describe, expect, it } from "vitest";
import {
  clearViewportApiTap,
  listViewportApiTapEntries,
  matchViewportPageApi,
  normalizeApiUrl,
  pushViewportApiTap,
  pushViewportHistorySnapshotTap,
  pushViewportRowsRangeTap,
  sessionIdMatchesTap,
} from "../src/react/v4/v4-viewport-api-tap.js";

describe("v4-viewport-api-tap", () => {
  it("matches page APIs and skips SSE streams", () => {
    expect(matchViewportPageApi("/api/v4/conversation/subscribe")?.label).toBe(
      "查历史·订阅",
    );
    expect(matchViewportPageApi("/api/v4/conversation/catchup")?.family).toBe(
      "catchup",
    );
    expect(matchViewportPageApi("/api/v4/conversation/catchup")?.label).toBe(
      "查历史·对账",
    );
    expect(
      matchViewportPageApi(
        "/api/chat/sessions/agent:main:x/messages",
      )?.family,
    ).toBe("messages");
    expect(
      matchViewportPageApi(
        "/api/chat/sessions/agent:main:x/messages",
      )?.label,
    ).toBe("查历史·轨迹");
    expect(matchViewportPageApi("/api/v4/conversation/frames")).toBeNull();
    expect(
      matchViewportPageApi(
        "/api/langgraph/threads/abc/runs/stream",
      ),
    ).toBeNull();
    expect(matchViewportPageApi("/api/goal/start")).toBeNull();
  });

  it("normalizes absolute URLs", () => {
    expect(
      normalizeApiUrl("http://127.0.0.1:8070/api/v4/conversation/resync?x=1"),
    ).toEqual({
      path: "/api/v4/conversation/resync",
      query: "x=1",
      raw: "http://127.0.0.1:8070/api/v4/conversation/resync?x=1",
    });
  });

  it("stores subscribe as 查历史·订阅 (V4 history control plane)", () => {
    clearViewportApiTap();
    pushViewportApiTap({
      method: "POST",
      url: "/api/v4/conversation/subscribe",
      requestBody: { topic: "conversation/t1", intent: "open" },
      status: 200,
      ok: true,
      durationMs: 42,
      response: { ack: { mode: "live" } },
    });
    pushViewportApiTap({
      method: "GET",
      url: "/api/goal/start",
      status: 200,
      ok: true,
      durationMs: 1,
      response: { ok: true },
    });
    const rows = listViewportApiTapEntries({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("查历史·订阅");
    expect(rows[0]?.badge).toBe("查历史");
    expect(rows[0]?.requestText).toContain("topic");
    expect(rows[0]?.responseText).toContain("live");
    expect(rows[0]?.sessionId).toBe("t1");
    expect(rows[0]?.pageText).toContain("SSE snapshot");
    const history = listViewportApiTapEntries({ family: "history", limit: 10 });
    expect(history).toHaveLength(1);
    clearViewportApiTap();
  });

  it("filters rows_range by sessionId so foreign prefetch does not pollute", () => {
    clearViewportApiTap();
    pushViewportApiTap({
      method: "POST",
      url: "/api/v4/conversation/rows_range",
      requestBody: { sessionId: "mine-tid", beforeRowId: 10, limit: 60 },
      status: 200,
      ok: true,
      durationMs: 5,
      response: { rows: [] },
    });
    pushViewportApiTap({
      method: "POST",
      url: "/api/v4/conversation/rows_range",
      requestBody: { sessionId: "other-tid", beforeRowId: 99, limit: 60 },
      status: 200,
      ok: true,
      durationMs: 5,
      response: { rows: [{ rowId: 1 }] },
    });
    const mine = listViewportApiTapEntries({ sessionId: "mine-tid", limit: 10 });
    expect(mine).toHaveLength(1);
    expect(mine[0]?.sessionId).toBe("mine-tid");
    const all = listViewportApiTapEntries({
      sessionId: "mine-tid",
      includeForeign: true,
      limit: 10,
    });
    expect(all).toHaveLength(2);
    clearViewportApiTap();
  });

  it("labels rows_range as 查历史·上拉 and summarizes the page", () => {
    clearViewportApiTap();
    expect(matchViewportPageApi("/api/v4/conversation/rows_range")?.label).toBe(
      "查历史·上拉",
    );
    pushViewportApiTap({
      method: "POST",
      url: "/api/v4/conversation/rows_range",
      requestBody: { sessionId: "s1", beforeRowId: 100, limit: 60 },
      status: 200,
      ok: true,
      durationMs: 12,
      response: {
        rows: [
          {
            rowId: 40,
            turnId: "t-a",
            kind: "turnHeader",
            state: "completedSuccess",
          },
          {
            rowId: 41,
            turnId: "t-a",
            kind: "userInput",
            origin: "realUser",
            text: "哈哈哈",
          },
          {
            rowId: 42,
            turnId: "t-a",
            kind: "assistantText",
            text: "你好呀",
            state: "complete",
          },
        ],
        hasMore: true,
        atSeq: 9,
      },
    });
    const rows = listViewportApiTapEntries({ family: "history", limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.badge).toBe("查历史");
    expect(rows[0]?.label).toBe("查历史·上拉");
    expect(rows[0]?.pageText).toContain("beforeRowId=100");
    expect(rows[0]?.pageText).toContain("40…42");
    expect(rows[0]?.pageText).toContain("hasMore=1");
    expect(rows[0]?.historyPreviewText).toContain("用户 #41 哈哈哈");
    expect(rows[0]?.historyPreviewText).toContain("正文 #42 你好呀");
    expect(rows[0]?.headline).toContain("before=100");
    clearViewportApiTap();
  });

  it("matches store rowsRange tap (EvoFlow loadOlder choke point)", () => {
    clearViewportApiTap();
    expect(matchViewportPageApi("conversation.rowsRange")?.label).toBe(
      "查历史·上拉",
    );
    expect(sessionIdMatchesTap("5adf7845-full-uuid", "5adf7845")).toBe(true);
    pushViewportRowsRangeTap({
      source: "loadOlder",
      sessionId: "5adf7845-full-uuid",
      beforeRowId: 500,
      limit: 200,
      ok: true,
      durationMs: 8,
      response: {
        rows: [
          {
            rowId: 480,
            turnId: "t-b",
            kind: "userInput",
            origin: "realUser",
            text: "上一页",
          },
        ],
        hasMore: false,
        atSeq: 3,
      },
    });
    const rows = listViewportApiTapEntries({
      family: "history",
      sessionId: "5adf7845",
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.badge).toBe("查历史");
    expect(rows[0]?.path).toBe("conversation.rowsRange");
    expect(rows[0]?.pageText).toContain("beforeRowId=500");
    expect(rows[0]?.historyPreviewText).toContain("用户 #480 上一页");
    expect(rows[0]?.requestText).toContain("loadOlder");
    clearViewportApiTap();
  });

  it("taps SSE history snapshot as 查历史·首屏 with row preview", () => {
    clearViewportApiTap();
    expect(
      matchViewportPageApi("conversation.historySnapshot")?.label,
    ).toBe("查历史·首屏");
    pushViewportHistorySnapshotTap({
      sessionId: "sess-open",
      source: "subscribe.snapshot",
      seq: 12,
      totalCount: 80,
      rows: [
        {
          rowId: 70,
          turnId: "t1",
          kind: "userInput",
          origin: "realUser",
          text: "打开会话看到的历史",
        },
        {
          rowId: 71,
          turnId: "t1",
          kind: "assistantText",
          text: "首屏窗",
        },
      ],
    });
    const rows = listViewportApiTapEntries({
      family: "history",
      sessionId: "sess-open",
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("查历史·首屏");
    expect(rows[0]?.badge).toBe("查历史");
    expect(rows[0]?.historyPreviewText).toContain("用户 #70 打开会话看到的历史");
    expect(rows[0]?.historyPreviewText).toContain("正文 #71 首屏窗");
    expect(rows[0]?.pageText).toContain("70…71");
    expect(rows[0]?.requestText).toContain("subscribe.snapshot");
    clearViewportApiTap();
  });
});

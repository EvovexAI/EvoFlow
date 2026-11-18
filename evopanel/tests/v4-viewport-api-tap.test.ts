import { describe, expect, it } from "vitest";
import {
  clearViewportApiTap,
  listViewportApiTapEntries,
  matchViewportPageApi,
  normalizeApiUrl,
  pushViewportApiTap,
} from "../src/react/v4/v4-viewport-api-tap.js";

describe("v4-viewport-api-tap", () => {
  it("matches page APIs and skips SSE streams", () => {
    expect(matchViewportPageApi("/api/v4/conversation/subscribe")?.label).toBe(
      "subscribe",
    );
    expect(matchViewportPageApi("/api/v4/conversation/catchup")?.family).toBe(
      "catchup",
    );
    expect(
      matchViewportPageApi(
        "/api/chat/sessions/agent:main:x/messages",
      )?.family,
    ).toBe("messages");
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

  it("stores request/response for matched calls only", () => {
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
    expect(rows[0]?.label).toBe("subscribe");
    expect(rows[0]?.requestText).toContain("topic");
    expect(rows[0]?.responseText).toContain("live");
    clearViewportApiTap();
  });
});

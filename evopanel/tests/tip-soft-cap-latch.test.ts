/**
 * 2026-11-22 对齐 ZCode 全窗：releaseBalloon 退役为 no-op，不得裁掉上滚前插历史。
 * 旧闩逻辑（裁窗后再禁 autoBackfill）已删除——全窗持有即稳定滚动条。
 */
import { describe, expect, it, vi } from "vitest";
import { ConversationProjectionStore } from "../src/zcode-ui/v4/conversationProjectionStore.ts";
import type { ConversationTransport } from "../src/zcode-ui/v4/transport.ts";
import type { ConversationRow } from "../src/zcode-shared/zcode-protocol-v4/index.ts";

function makeRow(
  rowId: number,
  kind: ConversationRow["kind"],
  turnId: string,
  extra: Record<string, unknown> = {},
): ConversationRow {
  return { rowId, turnId, kind, ...extra } as ConversationRow;
}

function balloonWindow(n: number): ConversationRow[] {
  const rows: ConversationRow[] = [];
  for (let i = 1; i <= n; i += 1) {
    const turnId = `t-${Math.floor((i - 1) / 20)}`;
    if ((i - 1) % 20 === 0) {
      rows.push(makeRow(i, "turnHeader", turnId, { state: "completedSuccess" }));
    } else if ((i - 1) % 20 === 1) {
      rows.push(makeRow(i, "userInput", turnId, { origin: "realUser", text: `q${i}` }));
    } else {
      rows.push(makeRow(i, "toolCall", turnId, { status: "success", toolCallId: `tc-${i}` }));
    }
  }
  return rows;
}

function mockTransport(olderPages: ConversationRow[][]): ConversationTransport {
  let page = 0;
  return {
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
    subscribe: vi.fn(async () => ({ subscriptionId: "sub-test" })),
    unsubscribe: vi.fn(async () => {}),
    command: vi.fn(async () => ({})),
    rowsRange: vi.fn(async () => {
      const rows = olderPages[page] ?? [];
      page += 1;
      return {
        rows,
        hasMore: page < olderPages.length,
        atLogEpoch: "1",
      };
    }),
  } as unknown as ConversationTransport;
}

describe("full-window projection (ZCode align)", () => {
  it("releaseBalloon is a no-op and does not shrink the window", async () => {
    const window = balloonWindow(500);
    const store = new ConversationProjectionStore(
      "conversation/tip-latch-test",
      mockTransport([
        balloonWindow(200).map((r) => ({ ...r, rowId: r.rowId - 200 })),
      ]),
    );
    (store as unknown as { setState: (p: object) => void }).setState({
      status: "ready",
      snapshot: {
        sessionId: "tip-latch-test",
        logEpoch: "1",
        seq: 1,
        revision: 1,
        phase: "idle",
        title: "",
        control: { canStop: false, phase: "idle" },
        rows: {
          firstRowId: 1,
          lastRowId: 500,
          totalCount: 2000,
          window,
        },
      },
      loadingOlder: false,
    });

    const released = store.releaseBalloonForFollowingTip();
    expect(released).toBe(false);
    expect(store.getState().snapshot!.rows.window.length).toBe(500);

    await store.close();
  });
});

/**
 * 跟底 releaseBalloon 后不得被 autoBackfill / loadAllOlder 再灌回全量历史。
 * 复刻 f2fdc69c 14:16：3185→90 后 loading 连拉到 3185 + scrollToBottom !JUMP。
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

describe("tip soft-cap latch", () => {
  it("releaseBalloon latches so autoBackfill does not re-expand the window", async () => {
    const window = balloonWindow(500);
    const store = new ConversationProjectionStore(
      "conversation/tip-latch-test",
      mockTransport([
        balloonWindow(200).map((r) => ({ ...r, rowId: r.rowId - 200 })),
      ]),
    );
    // 注入 balloon 快照（跳过 subscribe）
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
    expect(released).toBe(true);
    const afterRelease = store.getState().snapshot!.rows.window.length;
    expect(afterRelease).toBeLessThan(500);
    expect(afterRelease).toBeLessThanOrEqual(220 * 1.5 + 40);

    await store.autoBackfillForRestore(8);
    expect(store.getState().snapshot!.rows.window.length).toBe(afterRelease);
    expect(store.getState().loadingOlder).toBe(false);

    const dir = await store.loadAllOlder();
    expect(dir.status).toBe("hydrated");
    expect(store.getState().snapshot!.rows.window.length).toBe(afterRelease);

    await store.close();
  });
});

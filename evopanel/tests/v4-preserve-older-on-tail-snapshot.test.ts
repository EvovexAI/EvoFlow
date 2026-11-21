import { describe, expect, it } from "vitest";
import type { ConversationRow, ConversationSnapshot } from "../src/zcode-shared/zcode-protocol-v4/index.ts";
import {
  applyMemoryPressureToProjectionWindow,
  mergeOlderRows,
  mergePreservedOlderRowsIntoTailSnapshot,
} from "../src/zcode-ui/v4/conversationProjectionStore.ts";

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

  it("尾窗停在旧轮时粘回本地已有的更新行（777 不被收尾 snapshot 冲掉）", () => {
    const previous = snap(
      [
        textRow(80, "t6666", "666 收到"),
        {
          ...textRow(90, "t777", "777"),
          kind: "userInput",
          origin: "realUser",
          text: "777",
        } as ConversationRow,
        {
          ...textRow(91, "t777", "777"),
          kind: "assistantText",
          text: "777",
          state: "complete",
        } as ConversationRow,
      ],
      { firstRowId: 1, totalCount: 91 },
    );
    previous.seq = 200;
    // 收尾/overflow 尾窗仍停在 6666，没带上 777
    const incoming = snap(
      [textRow(70, "t333", "333"), textRow(80, "t6666", "666 收到～😄")],
      { firstRowId: 1, totalCount: 91 },
    );
    incoming.seq = 200;

    const merged = mergePreservedOlderRowsIntoTailSnapshot(previous, incoming);
    const ids = merged.rows.window.map((r) => r.rowId);
    expect(ids).toContain(90);
    expect(ids).toContain(91);
    expect(
      merged.rows.window.some(
        (r) => r.kind === "userInput" && (r as { text?: string }).text === "777",
      ),
    ).toBe(true);
  });

  it("incoming.totalCount 已声明权威 tip 时，禁止粘回更高 rowId 幽灵尾", () => {
    // 现场：hub tip=2042 / FE 仍钉 2055 旧轮；同 epoch recovery 不得把 2053…粘回。
    const previousRows: ConversationRow[] = [];
    for (let i = 2000; i <= 2055; i += 1) {
      previousRows.push(textRow(i, i <= 2042 ? "live" : "ghost", `r${i}`));
    }
    const previous = snap(previousRows, { firstRowId: 1, totalCount: 2055 });
    previous.seq = 300;
    const incoming = snap(
      previousRows.filter((r) => r.rowId >= 1983 && r.rowId <= 2042),
      { firstRowId: 1, totalCount: 2042 },
    );
    incoming.seq = 310;

    const merged = mergePreservedOlderRowsIntoTailSnapshot(previous, incoming);
    const ids = merged.rows.window.map((r) => r.rowId);
    expect(Math.max(...ids)).toBe(2042);
    expect(ids.some((id) => id > 2042)).toBe(false);
  });

  it("过期 snapshot（seq 更小）不回退客户端已推进的窗尾", () => {
    const previous = snap(
      [
        textRow(80, "t6666", "666"),
        {
          ...textRow(90, "t777", "777"),
          kind: "userInput",
          origin: "realUser",
          text: "777",
        } as ConversationRow,
      ],
      { firstRowId: 1, totalCount: 90 },
    );
    previous.seq = 210;
    const incoming = snap([textRow(80, "t6666", "666 旧")], {
      firstRowId: 1,
      totalCount: 80,
    });
    incoming.seq = 200;

    const merged = mergePreservedOlderRowsIntoTailSnapshot(previous, incoming);
    expect(merged).toBe(previous);
    expect(
      merged.rows.window.some(
        (r) => r.kind === "userInput" && (r as { text?: string }).text === "777",
      ),
    ).toBe(true);
  });
});

describe("applyMemoryPressureToProjectionWindow", () => {
  it("上滚在途或已上拉大窗：不裁行数（防 2004↔52 抖动）", () => {
    const rows: ConversationRow[] = [];
    for (let i = 1; i <= 200; i += 1) {
      rows.push(textRow(i, "t", `r${i}`));
    }
    expect(applyMemoryPressureToProjectionWindow(rows, { loadingOlder: true })).toBeNull();
    const out = applyMemoryPressureToProjectionWindow(rows, { loadingOlder: false });
    if (out) {
      expect(out.length).toBe(rows.length);
      expect(out[0]?.rowId).toBe(1);
      expect(out[out.length - 1]?.rowId).toBe(200);
    }
  });
});

describe("mergePreservedOlderRowsIntoTailSnapshot under critical softCap", () => {
  it("prefer:tail 裁到 winFirst=94 后仍钉回已上拉的更早窗首，不得弹回 94", () => {
    // 对齐诊断：softCap=50、loadOlder 已前插到 1…、shrink prefer:tail → 94…，
    // mergePreserved 必须保住窗首，否则 beforeRowId=94 连打 / HISTORY_TOP_STUCK。
    const previousRows: ConversationRow[] = [];
    for (let i = 1; i <= 150; i += 1) {
      previousRows.push(textRow(i, i < 94 ? "old" : "live", `r${i}`));
    }
    const previous = snap(previousRows, { firstRowId: 1, totalCount: 223 });
    const incoming = snap(
      previousRows.filter((r) => r.rowId >= 94).slice(0, 50),
      { firstRowId: 1, totalCount: 223 },
    );
    expect(incoming.rows.window[0]?.rowId).toBe(94);

    const merged = mergePreservedOlderRowsIntoTailSnapshot(previous, incoming);
    expect(merged.rows.window[0]?.rowId).toBeLessThan(94);
    expect(merged.rows.window.some((r) => r.rowId === 1)).toBe(true);
    expect(merged.rows.window[merged.rows.window.length - 1]?.rowId).toBeGreaterThanOrEqual(
      incoming.rows.window[incoming.rows.window.length - 1]!.rowId,
    );
  });
});

describe("mergeOlderRows (loadOlder prefer=head)", () => {
  it("窗首必须前进到本页更早行，即使直播轮已顶满 softCap", () => {
    // 现场：winFirst=1997 卡住；rows/range 已返回更早页，合并后窗首仍不前进。
    const window: ConversationRow[] = [];
    window.push(textRow(1997, "live", "header"));
    (window[0] as { kind: string }).kind = "turnHeader";
    window.push({
      ...textRow(1998, "live", "user"),
      kind: "userInput",
      origin: "realUser",
      text: "q",
    } as ConversationRow);
    for (let i = 1999; i <= 2096; i += 1) {
      window.push({
        ...textRow(i, "live", `tool-${i}`),
        kind: "toolCall",
        status: "success",
      } as ConversationRow);
    }

    const fetched: ConversationRow[] = [];
    fetched.push({ ...textRow(1900, "prev", "h"), kind: "turnHeader" } as ConversationRow);
    fetched.push({
      ...textRow(1901, "prev", "u"),
      kind: "userInput",
      origin: "realUser",
      text: "older",
    } as ConversationRow);
    for (let i = 1902; i <= 1996; i += 1) {
      fetched.push(textRow(i, "prev", `t-${i}`));
    }

    const merged = mergeOlderRows(window, fetched, { softCap: 80, prefer: "head" });
    expect(merged).not.toBeNull();
    expect(merged![0]?.rowId).toBeLessThan(1997);
    expect(merged!.some((r) => r.rowId === 1900)).toBe(true);
    expect(merged!.some((r) => r.rowId === 1998)).toBe(true);
  });

  it("fetched 全不早于窗首时返回 null", () => {
    const window = [textRow(10, "t", "a"), textRow(11, "t", "b")];
    expect(mergeOlderRows(window, [textRow(10, "t", "a"), textRow(12, "t", "c")], { prefer: "head" })).toBeNull();
  });

  it("同轮中段上拉（无 turnHeader）窗首也必须前进——现场 before=2217 fetchedFirst=2157", () => {
    // 巨型已完成轮只露出尾部；直播是下一小轮。上拉同轮更早 tool/reasoning，本页仍无 header。
    const mega = "mega";
    const live = "live";
    const window: ConversationRow[] = [];
    for (let i = 2217; i <= 2270; i += 1) {
      window.push({
        ...textRow(i, mega, `tool-${i}`),
        kind: "toolCall",
        status: "success",
      } as ConversationRow);
    }
    window.push({ ...textRow(2271, live, "h"), kind: "turnHeader" } as ConversationRow);
    window.push({
      ...textRow(2272, live, "u"),
      kind: "userInput",
      origin: "realUser",
      text: "重启好了",
    } as ConversationRow);
    window.push(textRow(2273, live, "empty"));

    const fetched: ConversationRow[] = [];
    for (let i = 2157; i <= 2216; i += 1) {
      fetched.push({
        ...textRow(i, mega, `older-${i}`),
        kind: i % 3 === 0 ? "reasoning" : "toolCall",
        status: "success",
      } as ConversationRow);
    }

    const merged = mergeOlderRows(window, fetched, { softCap: 80, prefer: "head" });
    expect(merged).not.toBeNull();
    expect(merged![0]?.rowId).toBe(2157);
    expect(merged!.some((r) => r.rowId === 2272)).toBe(true);
  });
});


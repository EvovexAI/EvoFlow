/**
 * 视口调试「虚拟化 / 投影窗」探针：把 soft-cap、窗首尾、流式 tip、直播轮
 * 收成一张可复制的表——排「转圈但 SSE 在动 / 上滚没历史」时先看这里。
 */
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  isInFlightProjectionRow,
  liveTurnSpan,
  resolveProjectionWindowSoftCap,
  rowsForTurnId,
} from "@zcode/ui/v4/projectionWindowCap.js";
import { extractStreamMaxRowId } from "./v4-viewport-anomaly.js";

const STREAM_RECENT_MS = 8_000;

export type VirtualizationProbe = {
  softCap: number;
  windowCount: number;
  totalCount: number | null;
  /** 投影数组两端（pin 后可能首>尾） */
  winFirst: number | null;
  winLast: number | null;
  /** 窗内真实 min/max rowId */
  winMin: number | null;
  winMax: number | null;
  unsortedEnds: boolean;
  streamMaxRowId: number | null;
  streamAhead: boolean;
  streamAheadDelta: number | null;
  liveTurnId: string | null;
  liveTipRowId: number | null;
  liveInFlight: number;
  windowInFlight: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  wouldTrigger: boolean;
  following: boolean;
  softCapRatio: number;
  balloon: boolean;
  flags: string[];
};

export type VirtualizationProbeInput = {
  tid: string;
  windowRows: readonly ConversationRow[] | readonly Record<string, unknown>[];
  windowCount: number;
  totalCount: number | null;
  winFirst: number | null;
  winLast: number | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  wouldTrigger: boolean;
  following?: boolean;
  softCap?: number;
  streamEntries?: Array<{
    atMs: number;
    channel?: string;
    sessionId?: string | null;
    headline?: string;
    jsonText?: string;
  }>;
  nowMs?: number;
};

function asRows(
  rows: VirtualizationProbeInput["windowRows"],
): ConversationRow[] {
  return (rows || []) as ConversationRow[];
}

export function collectVirtualizationProbe(
  input: VirtualizationProbeInput,
): VirtualizationProbe {
  const softCap =
    typeof input.softCap === "number" && input.softCap > 0
      ? Math.floor(input.softCap)
      : resolveProjectionWindowSoftCap();
  const rows = asRows(input.windowRows);
  const windowCount =
    typeof input.windowCount === "number" ? input.windowCount : rows.length;

  let winMin: number | null = null;
  let winMax: number | null = null;
  let windowInFlight = 0;
  for (const row of rows) {
    const rid = Number(row?.rowId);
    if (Number.isFinite(rid)) {
      if (winMin == null || rid < winMin) winMin = rid;
      if (winMax == null || rid > winMax) winMax = rid;
    }
    if (isInFlightProjectionRow(row)) windowInFlight += 1;
  }

  const winFirst = input.winFirst;
  const winLast = input.winLast;
  const unsortedEnds =
    (winFirst != null && winLast != null && winFirst > winLast) ||
    (winFirst != null && winMin != null && winFirst !== winMin) ||
    (winLast != null && winMax != null && winLast !== winMax);

  const now = input.nowMs ?? Date.now();
  const streamMaxRowId = extractStreamMaxRowId(
    (input.streamEntries || []) as Parameters<typeof extractStreamMaxRowId>[0],
    input.tid,
    now - STREAM_RECENT_MS,
  );
  const streamAhead =
    streamMaxRowId != null && winLast != null && streamMaxRowId > winLast;
  const streamAheadDelta =
    streamAhead && streamMaxRowId != null && winLast != null
      ? streamMaxRowId - winLast
      : null;

  const span = liveTurnSpan(rows);
  let liveTurnId: string | null = null;
  let liveTipRowId: number | null = null;
  let liveInFlight = 0;
  if (span) {
    liveTurnId = String(rows[span.turnStart]?.turnId || "").trim() || null;
    if (liveTurnId) {
      const liveRows = rowsForTurnId(rows, liveTurnId);
      for (const row of liveRows) {
        const rid = Number(row.rowId);
        if (Number.isFinite(rid)) {
          if (liveTipRowId == null || rid > liveTipRowId) liveTipRowId = rid;
        }
        if (isInFlightProjectionRow(row)) liveInFlight += 1;
      }
    }
  }

  const softCapRatio =
    softCap > 0 ? Math.round((windowCount / softCap) * 100) / 100 : 0;
  // 与 projectionWindowCap.isProjectionWindowBallooned 同阈值（softCap×1.5）。
  const balloon = windowCount > Math.floor(softCap * 1.5);

  const flags: string[] = [];
  if (streamAhead) flags.push(`!STREAM_AHEAD+${streamAheadDelta ?? "?"}`);
  if (unsortedEnds) flags.push("!UNSORTED_ENDS");
  if (balloon) flags.push("!BALLOON");
  if (softCap <= 50) flags.push("!CRITICAL_MEM(softCap≤50)");
  else if (softCap <= 100) flags.push("!HIGH_MEM(softCap≤100)");
  if (
    typeof input.totalCount === "number" &&
    windowCount < input.totalCount &&
    softCapRatio >= 0.85
  ) {
    flags.push("SOFTCAP_TAIL");
  }
  if (
    streamMaxRowId != null &&
    liveTipRowId != null &&
    streamMaxRowId > liveTipRowId
  ) {
    flags.push("!LIVE_TIP_LAG");
  }
  if (windowInFlight === 0 && streamMaxRowId != null) {
    flags.push("!NO_INFLIGHT_IN_WINDOW");
  }

  return {
    softCap,
    windowCount,
    totalCount: input.totalCount,
    winFirst,
    winLast,
    winMin,
    winMax,
    unsortedEnds,
    streamMaxRowId,
    streamAhead,
    streamAheadDelta,
    liveTurnId,
    liveTipRowId,
    liveInFlight,
    windowInFlight,
    hasOlder: !!input.hasOlder,
    loadingOlder: !!input.loadingOlder,
    wouldTrigger: !!input.wouldTrigger,
    following: input.following !== false,
    softCapRatio,
    balloon,
    flags,
  };
}

/** 复制诊断用：固定小节，Agent 四问直接对这张表。 */
export function formatVirtualizationProbeForDiag(
  probe: VirtualizationProbe,
): string[] {
  const lines: string[] = [];
  lines.push("### 虚拟化（投影窗）");
  lines.push(
    `- 总判: ${probe.flags.length ? probe.flags.join(" · ") : "窗跟流正常"}`,
  );
  lines.push(
    `- 软顶 softCap=${probe.softCap} · 已显示=${probe.windowCount}/${probe.totalCount ?? "∅"} · 占比=${probe.softCapRatio}${probe.balloon ? " !BALLOON(>1.5×)" : ""}`,
  );
  lines.push(
    `- 窗两端(数组) ${probe.winFirst ?? "∅"}…${probe.winLast ?? "∅"} · 真实 min/max ${probe.winMin ?? "∅"}…${probe.winMax ?? "∅"}${probe.unsortedEnds ? " !UNSORTED(pin后首尾≠min/max)" : ""}`,
  );
  lines.push(
    `- 流式 tip streamMax=${probe.streamMaxRowId ?? "∅"} · 窗尾 winLast=${probe.winLast ?? "∅"}${
      probe.streamAhead
        ? ` · !STREAM_AHEAD Δ+${probe.streamAheadDelta}`
        : " · 对齐"
    }`,
  );
  lines.push(
    `- 直播轮 tid=${probe.liveTurnId ? probe.liveTurnId.slice(0, 12) : "∅"} · liveTip=${probe.liveTipRowId ?? "∅"} · inFlight(轮/窗)=${probe.liveInFlight}/${probe.windowInFlight}`,
  );
  lines.push(
    `- 上滚 hasOlder=${probe.hasOlder ? 1 : 0} loading=${probe.loadingOlder ? 1 : 0} wouldTrigger=${probe.wouldTrigger ? 1 : 0} follow=${probe.following ? 1 : 0}`,
  );
  lines.push(
    "- 读法(ZCode): follow=1 只查 tip/STREAM_AHEAD；follow=0 只查上拉 hasOlder/wouldTrigger；soft-cap 只在 snapshot/loadOlder，delta 不得裁窗。",
  );
  return lines;
}

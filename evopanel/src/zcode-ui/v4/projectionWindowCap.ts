/**
 * Renderer projection window helpers（裁切 / 瘦身 / 钉直播轮）。
 *
 * 2026-11-22 对齐 ZCode：store 持全窗，日常路径 softCap≈100k，**不再按内存水位裁行数**。
 * 现场 soft-cap + releaseBalloon → 90↔339 滚动条抽风已退役 releaseBalloon。
 *
 * 仍保留：
 * - {@link capProjectionWindow} / {@link ensureLiveTurnInProjectionWindow}：单测与极端上限
 * - {@link lightenProjectionRowsForMemory}：旧工具卡 text 瘦身（内存安全主路径）
 * - prefer `tail`/`head` 裁切算法：显式 cap 调用时用
 *
 * ZCode 契约：store 持有全会话行，虚拟列表只挂可视区；客户端绝不发明第二套焦点窗。
 * 10MB 级元凶已在服务端 mirror/hydrate 出口截断（agui_mirror._TOOL_OUTPUT_ROW_PREVIEW_MAX）。
 */
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  heavyHorizonForMemoryLevel,
  projectionSoftCapForMemoryLevel,
  resolveRendererMemoryLevel,
  type RendererMemoryLevel,
} from "../../react/lib/renderer-memory-pressure.js";

/**
 * 渲染层窗口软顶（行）。
 *
 * 2026-11-22 对齐 ZCode：投影 store 持全窗，日常路径不再裁行数。
 * 本常量与 {@link resolveProjectionWindowSoftCap} 仍保留给单测 / 显式 cap 调用；
 * 热路径一律走 resolve（已返回全窗上限）。
 */
export const PROJECTION_WINDOW_SOFT_CAP = 100_000;

/**
 * 旧 soft-cap 诊断别名（220）。
 *
 * ZCode 问题导航日常 **无行顶**：`loadAllOlder` 分页到 `!hasMore`。
 * EvoFlow 跟底也不裁窗；本常量仅供历史对照 / 探针，勿再当日常目录停手条件。
 */
export const PROJECTION_WINDOW_LEGACY_SOFT_CAP = 220;

/** @deprecated 误加的「目录行顶」；日常应对齐 ZCode 全量补拉，勿再用。 */
export const PROJECTION_WINDOW_DIRECTORY_CAP = PROJECTION_WINDOW_LEGACY_SOFT_CAP;

/** 分享全量导出允许更大窗口，避免截断分享目录。 */
export const PROJECTION_WINDOW_SHARE_CAP = 8_000;

/** 窗口内只对最近 N 行保留完整 tool output；更早的工具卡瘦身。 */
export const PROJECTION_HEAVY_HORIZON = 60;

/**
 * 超过 softCap×此倍数视为 balloon（上滚 loadOlder 不裁行会撑到全量历史）。
 * 跟底 / 回底部时应收回软顶，否则 virtualizer 按「轮」挂载会拖出数千 DOM。
 */
export const PROJECTION_WINDOW_BALLOON_RATIO = 1.5;

const MIN_KEEP = 40;
const LIGHT_TOOL_TEXT_CAP = 2_048;

/**
 * 直播轮行数顶满 / 超过 softCap 时，仍至少留给「上一问」的锚点预算。
 * turnHeader + realUser 各 1 行；留到 4 可覆盖紧邻两轮的头+问，避免发消息后
 * 上边历史整轮从窗口蒸发（用户体感：历史被吃掉一个）。
 */
const MIN_OLDER_ANCHOR_BUDGET = 4;

/** softCap 扣掉直播轮后的剩余，再与锚点下限取 max。 */
function olderAnchorBudget(softCap: number, liveLen: number): number {
  const leftover = Math.max(0, Math.floor(softCap) - Math.max(0, Math.floor(liveLen)));
  return Math.max(leftover, MIN_OLDER_ANCHOR_BUDGET);
}

function isTurnBoundary(row: ConversationRow | undefined): boolean {
  // 只认 turnHeader：落在 realUser 会裁掉紧前 header，半截轮界还会把旧结论挂窗顶。
  return !!row && row.kind === "turnHeader";
}

/** 按当前 renderer 内存水位取软顶（读不到 heap 时用默认 400）。 */
export function resolveProjectionWindowSoftCap(): number {
  return projectionSoftCapForMemoryLevel(resolveRendererMemoryLevel());
}

/** 投影窗是否已 balloon（默认 > softCap×1.5）。 */
export function isProjectionWindowBallooned(
  windowCount: number,
  softCap: number = PROJECTION_WINDOW_SOFT_CAP,
): boolean {
  const cap = Math.max(MIN_KEEP, Math.floor(softCap));
  const n = Math.max(0, Math.floor(windowCount));
  return n > Math.floor(cap * PROJECTION_WINDOW_BALLOON_RATIO);
}

function isRealUserRow(row: ConversationRow | undefined): boolean {
  return !!row && row.kind === "userInput" && row.origin === "realUser";
}

/** 行所属 turn 的起点（含紧前 turnHeader）；找不到则退回 idx。 */
function turnStartIndexForRow(
  rows: readonly ConversationRow[],
  idx: number,
): number {
  if (idx < 0 || idx >= rows.length) return Math.max(0, idx);
  const turnId = String(rows[idx]?.turnId || "").trim();
  if (turnId) {
    for (let i = 0; i <= idx; i += 1) {
      if (String(rows[i]?.turnId || "").trim() === turnId) return i;
    }
  }
  if (idx > 0 && rows[idx - 1]?.kind === "turnHeader") return idx - 1;
  if (rows[idx]?.kind === "turnHeader") return idx;
  return idx;
}

/** 该 turn 内最后一个非空 realUser 下标；没有则 -1。 */
function realUserIdxInTurn(
  rows: readonly ConversationRow[],
  turnStart: number,
  turnEndExclusive: number,
): number {
  let userIdx = -1;
  const turnId = String(rows[turnStart]?.turnId || "").trim();
  for (let i = turnStart; i < turnEndExclusive; i += 1) {
    const row = rows[i];
    if (turnId && String(row?.turnId || "").trim() !== turnId) break;
    if (!isRealUserRow(row)) continue;
    if (!String((row as { text?: string }).text || "").trim()) continue;
    userIdx = i;
  }
  return userIdx;
}

/** 非空 realUser 的时间键：createdAt 优先，其次 rowId（防埋在旧 rowId 下的新问）。 */
function realUserRecencyKey(row: ConversationRow | undefined): number {
  if (!row) return -1;
  const created = Number((row as { createdAt?: unknown }).createdAt) || 0;
  const rid = Number(row.rowId) || 0;
  // createdAt 毫秒远大于 rowId；同刻再用 rowId 破并列
  return created > 0 ? created * 1_000_000 + (rid % 1_000_000) : rid;
}

function turnIdAt(rows: readonly ConversationRow[], idx: number): string {
  return String(rows[idx]?.turnId || "").trim();
}

/** 某 turn 在 full 中的所有行（可被后写的旧轮工具插到中间，不能假设连续后缀）。 */
export function rowsForTurnId(
  rows: readonly ConversationRow[],
  turnId: string,
): ConversationRow[] {
  const id = String(turnId || "").trim();
  if (!id) return [];
  return rows.filter((row) => String(row.turnId || "").trim() === id);
}

/**
 * 直播轮组内顺序：turnHeader → userInput → 其余按 rowId。
 * 现场：同 turn 工具 rowId 小于 header 时，按纯 rowId 排会「工具在用户气泡上面」。
 */
function sortLiveTurnRowsForDisplay(rows: ConversationRow[]): ConversationRow[] {
  const headers: ConversationRow[] = [];
  const users: ConversationRow[] = [];
  const rest: ConversationRow[] = [];
  for (const row of rows) {
    if (row.kind === "turnHeader") headers.push(row);
    else if (row.kind === "userInput") users.push(row);
    else rest.push(row);
  }
  const byId = (a: ConversationRow, b: ConversationRow) => a.rowId - b.rowId;
  headers.sort(byId);
  users.sort(byId);
  rest.sort(byId);
  return [...headers, ...users, ...rest];
}

/**
 * 直播轮行挪到窗尾（组内 header/user 优先，其余按 rowId）。
 * 现场：888 的 provisional rowId 小于仍在追加的 777 工具 → 跟底只看见 777，
 * 视口列表里 888 在上面「有数据但页面底部没有」。
 */
export function pinTurnRowsAtTail(
  window: readonly ConversationRow[],
  turnId: string,
): ConversationRow[] {
  const id = String(turnId || "").trim();
  if (!id || window.length === 0) return [...window];
  const live: ConversationRow[] = [];
  const rest: ConversationRow[] = [];
  for (const row of window) {
    if (String(row.turnId || "").trim() === id) live.push(row);
    else rest.push(row);
  }
  if (live.length === 0) return [...window];
  const liveSorted = sortLiveTurnRowsForDisplay(live);
  rest.sort((a, b) => a.rowId - b.rowId);
  const lastRest = rest[rest.length - 1];
  const lastLive = liveSorted[liveSorted.length - 1];
  if (
    lastLive &&
    (!lastRest || String(lastRest.turnId || "").trim() === id) &&
    String(window[window.length - 1]?.turnId || "").trim() === id
  ) {
    // 已在尾且组内顺序已正确：避免无意义换引用
    if (
      window.length === rest.length + liveSorted.length &&
      window[window.length - 1]?.rowId === lastLive.rowId &&
      liveSorted.every((row, i) => {
        const at = window[rest.length + i];
        return at?.rowId === row.rowId && at?.kind === row.kind;
      })
    ) {
      return window as ConversationRow[];
    }
  }
  return [...rest, ...liveSorted];
}

/**
 * delta 热路径专用：不裁软顶，只在直播轮不在窗尾时钉回去。
 * 旧轮晚到的 tool/正文 append 会把新问挤回中间 → 跟底看见上轮「888」。
 *
 * 已在尾时原引用返回——禁止每帧组内重排（换数组 → virtualizer/跟底上下抖，
 * 现场 follow=1 + wheel + win716 行长高时直抖）。
 */
export function pinLiveTurnAfterDeltas(
  window: readonly ConversationRow[],
): readonly ConversationRow[] {
  if (!Array.isArray(window) || window.length < 2) return window;
  const span = liveTurnSpan(window);
  if (!span) return window;
  const liveTid = turnIdAt(window, span.turnStart);
  if (!liveTid) return window;
  if (String(window[window.length - 1]?.turnId || "").trim() === liveTid) {
    return window;
  }
  return pinTurnRowsAtTail(window, liveTid);
}

/**
 * 直播锚点 (turnStart, userIdx)。
 *
 * 优先：仍有 in-flight 的「最新」一轮（按该轮 realUser createdAt / in-flight
 * 最大 rowId），不能只取行序最早——旧轮晚到的 running 工具会把新问 888 顶掉。
 * 否则：最新非空 realUser（createdAt 优先，避免低 rowId 的新问被当成更早）。
 */
function resolveLiveTurnUserIdx(
  rows: readonly ConversationRow[],
  turnId: string,
  turnStart: number,
): number {
  let userIdx = -1;
  let bestUserKey = -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (turnIdAt(rows, i) !== turnId) continue;
    const row = rows[i];
    if (!isRealUserRow(row)) continue;
    if (!String((row as { text?: string }).text || "").trim()) continue;
    const key = realUserRecencyKey(row!);
    if (key >= bestUserKey) {
      bestUserKey = key;
      userIdx = i;
    }
  }
  if (userIdx >= 0) return userIdx;
  userIdx = turnStart;
  for (let i = 0; i < rows.length; i += 1) {
    if (turnIdAt(rows, i) !== turnId) continue;
    if (rows[i]?.kind === "userInput") return i;
  }
  return userIdx;
}

export function liveTurnSpan(
  rows: readonly ConversationRow[],
): { turnStart: number; userIdx: number } | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const inflightByTurn = new Map<string, { maxRowId: number; anyIdx: number }>();
  for (let i = 0; i < rows.length; i += 1) {
    if (!isInFlightProjectionRow(rows[i])) continue;
    const tid = turnIdAt(rows, i);
    if (!tid) continue;
    const rid = Number(rows[i]?.rowId) || 0;
    const prev = inflightByTurn.get(tid);
    if (!prev || rid > prev.maxRowId) {
      inflightByTurn.set(tid, { maxRowId: rid, anyIdx: i });
    }
  }

  let latestUserIdx = -1;
  let latestUserKey = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!isRealUserRow(row)) continue;
    if (!String((row as { text?: string }).text || "").trim()) continue;
    const key = realUserRecencyKey(row!);
    if (key >= latestUserKey) {
      latestUserKey = key;
      latestUserIdx = i;
    }
  }

  let bestInflightTid = "";
  let bestInflightScore = -1;
  let bestInflightIdx = -1;
  let bestInflightUserKey = -1;
  for (const [tid, meta] of inflightByTurn) {
    const turnRows = rowsForTurnId(rows, tid);
    let userScore = -1;
    for (const row of turnRows) {
      if (!isRealUserRow(row)) continue;
      if (!String((row as { text?: string }).text || "").trim()) continue;
      userScore = Math.max(userScore, realUserRecencyKey(row));
    }
    // 多 inflight：流式 tip（最大 rowId）优先；用户时间只作同 tip 破平。
    const score = meta.maxRowId * 1e15 + Math.max(0, userScore);
    if (score > bestInflightScore) {
      bestInflightScore = score;
      bestInflightTid = tid;
      bestInflightIdx = meta.anyIdx;
      bestInflightUserKey = userScore;
    }
  }

  // 僵尸 demote：旧 inflight（更低 tip）不能压过「更新的 realUser」且 tip 更高的轮。
  // 现场 bash@80 永久 running + 新问已在 290+ → soft-cap 钉旧轮 → !STREAM_AHEAD。
  // 注意：新 tip 轮尚无 realUser（仅 optimistic）时，latestUser 仍是旧轮——不得 demote
  // 掉更高 tip 的新 inflight（STREAM_AHEAD 回归：2154 > 2080）。
  if (
    bestInflightTid &&
    latestUserIdx >= 0 &&
    turnIdAt(rows, latestUserIdx) !== bestInflightTid &&
    latestUserKey > bestInflightUserKey
  ) {
    // 必须有真实 createdAt：否则高 rowId 的「上一问晚到 append」会 demote 掉
    // 正在跑的低 rowId 直播轮（anti #185 mega-live 回归）。
    const latestCreated =
      Number((rows[latestUserIdx] as { createdAt?: unknown })?.createdAt) || 0;
    const latestTid = turnIdAt(rows, latestUserIdx);
    let latestTurnMax = 0;
    for (const row of rowsForTurnId(rows, latestTid)) {
      latestTurnMax = Math.max(latestTurnMax, Number(row.rowId) || 0);
    }
    const inflightTip = inflightByTurn.get(bestInflightTid)?.maxRowId ?? 0;
    if (latestCreated > 0 && latestTurnMax > inflightTip) {
      const turnStart = turnStartIndexForRow(rows, latestUserIdx);
      return {
        turnStart,
        userIdx: resolveLiveTurnUserIdx(rows, latestTid, turnStart),
      };
    }
  }

  if (bestInflightTid && bestInflightIdx >= 0) {
    const turnStart = turnStartIndexForRow(rows, bestInflightIdx);
    return {
      turnStart,
      userIdx: resolveLiveTurnUserIdx(rows, bestInflightTid, turnStart),
    };
  }

  if (latestUserIdx < 0) return null;
  return {
    turnStart: turnStartIndexForRow(rows, latestUserIdx),
    userIdx: latestUserIdx,
  };
}

/**
 * 在 softCap 内从「非直播轮」向前挑完整 turn 片段，禁止窗顶落在半截轮。
 *
 * 旧逻辑按 liveStartRowId 切 older：直播轮 provisional rowId 偏小时会把
 * 后写的旧轮工具当成「更新」留在窗尾，直播问反而埋在中间。
 * 现在显式排除 liveTurnId，再按行序挑完整 turn。
 */
export function selectOlderCompleteTurnsWithinBudget(
  full: readonly ConversationRow[],
  liveStartRowId: number,
  budget: number,
  liveTurnId?: string,
): ConversationRow[] {
  const cap = Math.max(0, Math.floor(budget));
  if (cap <= 0) return [];
  const liveId = String(liveTurnId || "").trim();
  const olderFull = full.filter((row) => {
    if (liveId && String(row.turnId || "").trim() === liveId) return false;
    // 无 liveTurnId 时退回按 rowId 切（兼容旧调用）
    if (!liveId && row.rowId >= liveStartRowId) return false;
    return true;
  });
  if (olderFull.length === 0) return [];
  if (olderFull.length <= cap) {
    return olderFull[0]?.kind === "turnHeader"
      ? [...olderFull]
      : alignLeadingToTurnHeader(full, olderFull, cap);
  }

  const headers: number[] = [];
  for (let i = 0; i < olderFull.length; i += 1) {
    if (olderFull[i]?.kind === "turnHeader") headers.push(i);
  }
  if (headers.length === 0) {
    // 整段 older 都无 turnHeader：宁可空，也不把 mid-turn 挂到窗顶。
    return [];
  }

  let startIdx = headers[headers.length - 1]!;
  for (let h = headers.length - 1; h >= 0; h -= 1) {
    const candidate = headers[h]!;
    if (olderFull.length - candidate <= cap) startIdx = candidate;
    else break;
  }
  const slice = olderFull.slice(startIdx);
  if (slice.length <= cap) return slice;

  // 上一整轮仍超预算：只留该轮 turnHeader + realUser（认得出「上一问」），
  // 不要把几百条 tool 残片挂在顶上。
  const compact: ConversationRow[] = [];
  for (const row of slice) {
    if (compact.length === 0 && row.kind !== "turnHeader") continue;
    if (row.kind === "turnHeader" || row.kind === "userInput") {
      compact.push(row);
      if (compact.length >= Math.min(cap, 4)) break;
      continue;
    }
    break;
  }
  return compact[0]?.kind === "turnHeader" ? compact : [];
}

/**
 * 窗首若落在半截 turn：能小成本补到 turnHeader 就补；否则丢掉残片，
 * 让窗顶落到下一个 turnHeader（或空，交给直播轮）。
 */
export function alignLeadingToTurnHeader(
  full: readonly ConversationRow[],
  rows: readonly ConversationRow[],
  maxBackfill: number,
): ConversationRow[] {
  if (rows.length === 0) return [];
  if (rows[0]?.kind === "turnHeader") return [...rows];

  const headerInRows = rows.findIndex((row) => row.kind === "turnHeader");
  if (headerInRows > 0) return rows.slice(headerInRows);

  const lead = rows[0];
  const leadTurnId = String(lead?.turnId || "");
  const leadRowId = lead?.rowId ?? 0;
  if (!leadTurnId || leadRowId <= 0) return [];

  let headerIdx = -1;
  for (let i = 0; i < full.length; i += 1) {
    const row = full[i];
    if (row?.kind === "turnHeader" && String(row.turnId || "") === leadTurnId) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return [];

  const headerRowId = full[headerIdx]?.rowId ?? 0;
  const backfill = full.filter((row) => row.rowId >= headerRowId && row.rowId < leadRowId);
  if (backfill.length === 0) return [];
  if (backfill.length > Math.max(0, Math.floor(maxBackfill))) return [];
  return [...backfill, ...rows];
}

/** 进行中的行：软顶绝不能裁掉，否则 V4 还在 Δ、页面却没思考/工具卡。 */
export function isInFlightProjectionRow(row: ConversationRow | undefined): boolean {
  if (!row) return false;
  if (row.kind === "turnHeader") {
    const state = String((row as { state?: string }).state || "");
    return state === "running" || state.startsWith("running");
  }
  if (row.kind === "reasoning" || row.kind === "assistantText") {
    return String((row as { state?: string }).state || "") === "streaming";
  }
  if (row.kind === "toolCall") {
    const status = String((row as { status?: string }).status || "");
    return (
      status === "inputStreaming" ||
      status === "running" ||
      status === "pendingApproval" ||
      status === "awaitingInput" ||
      status === "pending" ||
      status === "executing"
    );
  }
  if (row.kind === "subagent") {
    const status = String((row as { status?: string }).status || "");
    return status === "running" || status === "streaming";
  }
  return false;
}

/**
 * 直播轮超 softCap：保留轮头+用户 + 全部 in-flight + 尽量多的尾部完成行。
 * 旧逻辑只 head+tail，会把中间正在流的思考行裁掉 → wire 仍有思考 Δ，页面空白。
 *
 * 硬约束：`after` 的最后一行（流式 tip）必须保留——否则 streamRow > winLast，
 * 页面转圈但投影不涨（STREAM_AHEAD_OF_WINDOW 现场：2154 > 2080）。
 */
export function selectLiveTurnWithinBudget(
  live: readonly ConversationRow[],
  userIdxInFull: number,
  turnStartInFull: number,
  softCap: number,
): ConversationRow[] {
  const cap = Math.max(MIN_KEEP, Math.floor(softCap));
  if (live.length <= cap) return [...live];

  const userIdxInLive = Math.max(0, userIdxInFull - turnStartInFull);
  const head = live.slice(0, userIdxInLive + 1);
  const after = live.slice(userIdxInLive + 1);
  if (after.length === 0) return [...head];

  // tip = after 内最大 rowId（不依赖调用方是否已按 id 排好）
  let tip = after[0]!;
  let tipId = Number(tip.rowId) || 0;
  for (let i = 1; i < after.length; i += 1) {
    const rid = Number(after[i]!.rowId) || 0;
    if (rid >= tipId) {
      tip = after[i]!;
      tipId = rid;
    }
  }
  const inFlight = after.filter((row) => isInFlightProjectionRow(row));
  const inFlightIds = new Set(inFlight.map((row) => row.rowId));
  const settled = after.filter((row) => !inFlightIds.has(row.rowId));
  const tipIsInFlight = inFlightIds.has(tip.rowId);

  const afterBudget = Math.max(0, cap - head.length);
  const reserved = inFlight.length + (tipIsInFlight ? 0 : 1);
  if (reserved >= afterBudget) {
    // in-flight 顶满：保 tip + 最近一段 in-flight（可略超，优先 tip 可见）
    const room = Math.max(0, afterBudget - 1);
    const restInFlight = inFlight.filter((row) => row.rowId !== tip.rowId);
    const keepIds = new Set<number>([
      ...restInFlight.slice(-room).map((row) => row.rowId),
      tip.rowId,
    ]);
    return [...head, ...after.filter((row) => keepIds.has(row.rowId))];
  }

  const tipSlot = tipIsInFlight ? 0 : 1;
  const tailBudget = Math.max(0, afterBudget - inFlight.length - tipSlot);
  const settledNoTip = settled.filter((row) => row.rowId !== tip.rowId);
  const tail = tailBudget > 0 ? settledNoTip.slice(-tailBudget) : [];
  const keepIds = new Set<number>([
    ...inFlight.map((row) => row.rowId),
    ...tail.map((row) => row.rowId),
    tip.rowId,
  ]);
  return [...head, ...after.filter((row) => keepIds.has(row.rowId))];
}

/**
 * soft-cap prefer:tail 常把同 turn 里 rowId 更小的 tool/assistant 裁掉，
 * 窗内只剩 turnHeader+user → 「AI 空了 / 已工作无内容」，高度塌缩像整段对话消失。
 * 凡窗内已出现的 turnId，从 full 补回该 turn 的全部行（可略超 softCap）。
 */
export function repairPartialTurnsInProjectionWindow(
  full: readonly ConversationRow[],
  capped: readonly ConversationRow[],
): ConversationRow[] {
  if (!Array.isArray(full) || !Array.isArray(capped) || capped.length === 0) {
    return Array.isArray(capped) ? [...capped] : [];
  }
  const present = new Set(capped.map((row) => row.rowId));
  const turnIds = new Set(
    capped.map((row) => String(row.turnId || "").trim()).filter(Boolean),
  );
  if (turnIds.size === 0) return capped as ConversationRow[];
  let missing = 0;
  for (const row of full) {
    const turnId = String(row.turnId || "").trim();
    if (!turnId || !turnIds.has(turnId)) continue;
    if (present.has(row.rowId)) continue;
    missing += 1;
  }
  if (missing === 0) return capped as ConversationRow[];
  const byId = new Map<number, ConversationRow>();
  for (const row of capped) byId.set(row.rowId, row);
  for (const row of full) {
    const turnId = String(row.turnId || "").trim();
    if (!turnId || !turnIds.has(turnId)) continue;
    byId.set(row.rowId, row);
  }
  return [...byId.values()].sort((a, b) => a.rowId - b.rowId);
}

/**
 * prefer=head 裁掉直播轮尾时：在 softCap 内把头窗与直播轮拼回。
 * 不是按埋深「只留当前轮」重建——有预算就尽量保留更早的完整 turn；
 * 直播轮本身已顶满 softCap 时仍至少钉回上一问头+问（可略超 softCap）。
 */
export function ensureLiveTurnInProjectionWindow(
  full: readonly ConversationRow[],
  capped: readonly ConversationRow[],
  softCap: number,
): readonly ConversationRow[] {
  const span = liveTurnSpan(full);
  const liveTurnId = span ? turnIdAt(full, span.turnStart) : "";
  const capLimit = Math.max(MIN_KEEP, Math.floor(softCap));
  const finish = (window: readonly ConversationRow[]) => {
    let repaired = repairPartialTurnsInProjectionWindow(full, window);
    // repair 按 rowId 排序会把「低 rowId 的新直播问」埋回旧轮中间；必须再钉回窗尾。
    if (liveTurnId) repaired = pinTurnRowsAtTail(repaired, liveTurnId);
    // repairPartialTurns 会把直播轮「缺的行」整轮补回，长工具轮又撑破 softCap。
    // 超 1.5× 时再裁直播段，保留头+问+in-flight+尾，避免 500+ 窗拖死测高（#185）。
    if (!liveTurnId || repaired.length <= Math.floor(capLimit * 1.5)) {
      return repaired;
    }
    const liveRows = rowsForTurnId(repaired, liveTurnId);
    if (liveRows.length <= capLimit) return repaired;
    const liveSorted = [...liveRows].sort((a, b) => a.rowId - b.rowId);
    let userPos = liveSorted.findIndex((r) => isRealUserRow(r));
    if (userPos < 0) userPos = 0;
    const liveKept = selectLiveTurnWithinBudget(liveSorted, userPos, 0, capLimit);
    const liveStart = Math.min(...liveKept.map((r) => r.rowId));
    const olderKeep = selectOlderCompleteTurnsWithinBudget(
      full,
      liveStart,
      olderAnchorBudget(capLimit, liveKept.length),
      liveTurnId,
    );
    return pinTurnRowsAtTail(
      olderKeep.length === 0 ? liveKept : [...olderKeep, ...liveKept],
      liveTurnId,
    );
  };

  if (!span) {
    // 无直播轮（纯历史窗）：能对齐 turnHeader 就对齐；对齐不了别掏空窗口。
    const aligned = alignLeadingToTurnHeader(
      full,
      capped,
      Math.max(MIN_KEEP, Math.floor(softCap)),
    );
    return finish(aligned.length > 0 ? aligned : capped);
  }
  // 只取本 turn 的行，绝不用 full.slice(turnStart)——后写旧轮工具会夹在中间，
  // slice 会把 777/6666 误收进「直播段」。
  const live = rowsForTurnId(full, liveTurnId);
  if (live.length === 0) return finish(capped);
  const liveStartRowId = Math.min(...live.map((r) => r.rowId));
  const present = new Set(capped.map((r) => r.rowId));
  const liveMissing = live.some((r) => !present.has(r.rowId));
  const inFlightMissing = live.some(
    (r) => isInFlightProjectionRow(r) && !present.has(r.rowId),
  );

  // 直播轮行在 full 中的下标（供 selectLiveTurnWithinBudget 算 user 相对偏移）
  const liveUserIdxInFull = span.userIdx;
  const liveTurnStartInFull = span.turnStart;

  // 直播轮已完整在窗内，且没有 in-flight 被裁掉：只修窗顶半截轮，并钉尾。
  // 长工具轮（现场 250+ 行）若整轮无脑拼回，会把 window 撑到 500–700 → 测高跟底
  // 叠成 React #185。超过 softCap 时与缺行路径一样走 selectLiveTurnWithinBudget。
  if (!liveMissing && !inFlightMissing) {
    const capNow = Math.max(MIN_KEEP, Math.floor(softCap));
    const liveSortedPresent = [...live].sort((a, b) => a.rowId - b.rowId);
    const userPosPresent = Math.max(
      0,
      liveSortedPresent.findIndex((r) => r.rowId === full[liveUserIdxInFull]?.rowId),
    );
    const liveForWindow =
      liveSortedPresent.length > capNow
        ? selectLiveTurnWithinBudget(liveSortedPresent, userPosPresent, 0, capNow)
        : liveSortedPresent;
    const aligned = alignLeadingToTurnHeader(
      full,
      capped,
      Math.max(MIN_KEEP, capNow - liveForWindow.length),
    );
    if (aligned.length === capped.length && aligned.every((row, i) => row.rowId === capped[i]?.rowId)) {
      // soft-cap prefer:tail 可能已把窗顶裁到直播轮起点，上一问整轮蒸发。
      const olderKeep = selectOlderCompleteTurnsWithinBudget(
        full,
        liveStartRowId,
        MIN_OLDER_ANCHOR_BUDGET,
        liveTurnId,
      );
      if (olderKeep.length > 0) return finish([...olderKeep, ...liveForWindow]);
      return finish(capped);
    }
    // align 若丢光 older 残片，保留原 capped 里的直播段 + 尽可能的完整 older。
    if (aligned.length === 0 || aligned[0]?.rowId === liveStartRowId) {
      const olderKeep = selectOlderCompleteTurnsWithinBudget(
        full,
        liveStartRowId,
        olderAnchorBudget(softCap, liveForWindow.length),
        liveTurnId,
      );
      return finish(olderKeep.length === 0 ? capped : [...olderKeep, ...liveForWindow]);
    }
    return finish(aligned);
  }

  const cap = Math.max(MIN_KEEP, Math.floor(softCap));
  // selectLiveTurnWithinBudget 期望 live 是连续片段且 userIdx 相对 full；
  // 交错时改为：把本 turn 行按 rowId 排好再裁。
  const liveSorted = [...live].sort((a, b) => a.rowId - b.rowId);
  const userPosInLive = Math.max(
    0,
    liveSorted.findIndex((r) => r.rowId === full[liveUserIdxInFull]?.rowId),
  );
  const liveKept = selectLiveTurnWithinBudget(
    liveSorted,
    userPosInLive,
    0,
    cap,
  );
  // 即便直播轮已占满 softCap，也绝不能把「上一问」整轮丢掉——发消息后
  // 长工具轮一撑大，旧逻辑 `liveKept.length >= cap → return liveKept` 会直接吃历史。
  const olderKeep = selectOlderCompleteTurnsWithinBudget(
    full,
    liveStartRowId,
    olderAnchorBudget(cap, liveKept.length),
    liveTurnId,
  );
  void liveTurnStartInFull;
  return finish(olderKeep.length === 0 ? liveKept : [...olderKeep, ...liveKept]);
}

/**
 * 裁到 softCap。未超限时返回原引用（避免无意义换引用触发重绘）。
 */
export function capProjectionWindow(
  rows: readonly ConversationRow[],
  softCap: number = PROJECTION_WINDOW_SOFT_CAP,
  prefer: "tail" | "head" = "tail",
): readonly ConversationRow[] {
  const cap = Math.max(MIN_KEEP, Math.floor(softCap));
  // 未触软顶一律原引用返回：软顶之上才裁，绝不重建/重排（历史不可丢）。
  if (!Array.isArray(rows) || rows.length <= cap) return rows;

  if (prefer === "head") {
    let end = cap;
    while (end < rows.length && end < cap + 40 && !isTurnBoundary(rows[end])) {
      end += 1;
    }
    if (end > cap + 40) end = cap;
    return rows.slice(0, end);
  }

  let start = rows.length - cap;
  while (start > 0 && start > rows.length - cap - 40 && !isTurnBoundary(rows[start])) {
    start -= 1;
  }
  if (start < rows.length - cap - 40) start = rows.length - cap;
  if (!isTurnBoundary(rows[start])) {
    let probe = start;
    while (probe < rows.length - MIN_KEEP && !isTurnBoundary(rows[probe])) {
      probe += 1;
    }
    if (isTurnBoundary(rows[probe])) start = probe;
  }
  return rows.slice(start);
}

export function countRealUserQueries(rows: readonly ConversationRow[]): number {
  let n = 0;
  for (const row of rows) {
    if (row.kind === "userInput" && row.origin === "realUser") n += 1;
  }
  return n;
}

function lightenToolCallRow(
  row: ConversationRow,
  opts?: { stripDisplay?: boolean },
): ConversationRow {
  if (row.kind !== "toolCall") return row;
  const output = row.output;
  if (!output || typeof output !== "object") return row;
  const text = typeof (output as { text?: unknown }).text === "string"
    ? (output as { text: string }).text
    : "";
  const hasDisplay = (output as { display?: unknown }).display != null;
  const needsTextTrim = text.length > LIGHT_TOOL_TEXT_CAP;
  const needsDisplayDrop = opts?.stripDisplay === true && hasDisplay;
  if (!needsTextTrim && !needsDisplayDrop) return row;
  return {
    ...row,
    output: {
      ...output,
      text: needsTextTrim
        ? `${text.slice(0, LIGHT_TOOL_TEXT_CAP)}\n…[trimmed for memory]`
        : text,
      ...(needsDisplayDrop ? { display: undefined } : {}),
    },
  } as ConversationRow;
}

/**
 * 保留窗口尾部 heavyHorizon 行的完整工具载荷；更早的 toolCall 截断 text。
 * high/critical 水位还会丢掉旧卡 display（截图/媒体卡是堆膨胀主因之一）。
 * 行本身还在，不等于丢掉对话历史；上滚可再 hydrate。
 */
export function lightenProjectionRowsForMemory(
  rows: readonly ConversationRow[],
  heavyHorizon: number = PROJECTION_HEAVY_HORIZON,
  opts?: { stripDisplay?: boolean },
): readonly ConversationRow[] {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const horizon = Math.max(10, Math.floor(heavyHorizon));
  if (rows.length <= horizon) return rows;
  const start = rows.length - horizon;
  const stripDisplay = opts?.stripDisplay === true;
  let changed = false;
  const next = rows.map((row, i) => {
    if (i >= start) return row;
    const light = lightenToolCallRow(row, { stripDisplay });
    if (light !== row) changed = true;
    return light;
  });
  return changed ? next : rows;
}

/** cap + lighten 一条龙：投影 apply / loadOlder 统一走这里。 */
export function capAndLightenProjectionWindow(
  rows: readonly ConversationRow[],
  opts?: {
    softCap?: number;
    prefer?: "tail" | "head";
    heavyHorizon?: number;
    memoryLevel?: RendererMemoryLevel;
  },
): readonly ConversationRow[] {
  const level = opts?.memoryLevel ?? resolveRendererMemoryLevel();
  const softCap = opts?.softCap ?? projectionSoftCapForMemoryLevel(level);
  const prefer = opts?.prefer ?? "tail";
  const heavyHorizon =
    opts?.heavyHorizon ?? heavyHorizonForMemoryLevel(level);
  const capped = capProjectionWindow(rows, softCap, prefer);
  return lightenProjectionRowsForMemory(capped, heavyHorizon, {
    stripDisplay: level !== "normal",
  });
}

/**
 * 跟底收回 balloon（已退役）。
 *
 * 2026-11-22 对齐 ZCode：store 持全窗，跟底不得裁掉上滚前插的历史（现场
 * releaseBalloon → 90↔339 → scrollToBottom !JUMP）。恒返回 null。
 * 单测若要验证旧裁窗算法，直接调 {@link capProjectionWindow}。
 */
export function releaseBalloonProjectionWindow(
  _rows: readonly ConversationRow[],
  _softCap: number = PROJECTION_WINDOW_SOFT_CAP,
): readonly ConversationRow[] | null {
  return null;
}

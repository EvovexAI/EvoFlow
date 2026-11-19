/**
 * Renderer projection soft-cap：超大会话（复刻 1k–2k+ 行）若把完整历史常驻
 * `rows.window`，切会话/重绘会被拖死，最终 WebView2 「错误代码: Out of Memory」。
 * Wire 首帧本就只给尾窗（~60），但 loadAllOlder / 长流式 delta 仍会把窗口撑爆——
 * 这里统一裁回软顶，并把窗口深处的工具卡重载荷瘦身。
 *
 * - prefer `tail`：保最新（直播追加 / 导航探测）
 * - prefer `head`：保刚补拉的更早行（用户上滚 loadOlder）
 * 裁切尽量落在 turnHeader，避免半截 turn 挂在窗口头。
 *
 * 2026-11-15 回撤「直播轮焦点窗重建」（tighten/pin）：按埋深把 rows.window 重建成
 * 只剩当前轮 ≤80 行，会把前面轮次从窗口里整个丢掉——「历史记录看不到了」的实锤
 * （ZCode 契约：store 持有全会话行，虚拟列表只挂可视区；客户端绝不发明窗口）。
 * 内存安全网保留两层：① 软顶裁切（只裁行数，不重建）；② 旧工具卡 text 瘦身
 * （display 截图/文件卡必须保留——那是历史的一部分；10MB 级元凶已在服务端
 * mirror/hydrate 出口截断，见 agui_mirror._TOOL_OUTPUT_ROW_PREVIEW_MAX）。
 */
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  heavyHorizonForMemoryLevel,
  projectionSoftCapForMemoryLevel,
  resolveRendererMemoryLevel,
  type RendererMemoryLevel,
} from "../../react/lib/renderer-memory-pressure.js";

/** 正常水位下的渲染层窗口软顶（行）。高压时见 {@link resolveProjectionWindowSoftCap}。 */
export const PROJECTION_WINDOW_SOFT_CAP = 220;

/** 分享全量导出允许更大窗口，避免截断分享目录。 */
export const PROJECTION_WINDOW_SHARE_CAP = 8_000;

/** 窗口内只对最近 N 行保留完整 tool output；更早的工具卡瘦身。 */
export const PROJECTION_HEAVY_HORIZON = 60;

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

function isRealUserRow(row: ConversationRow | undefined): boolean {
  return !!row && row.kind === "userInput" && row.origin === "realUser";
}

/**
 * 最新非空 realUser 的 (turnStart, userIdx)。turnStart 含紧前 turnHeader。
 * 用于 prefer=head 裁切后把直播轮尾钉回窗口，避免 stale_prev_turn_tail。
 */
export function liveTurnSpan(
  rows: readonly ConversationRow[],
): { turnStart: number; userIdx: number } | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let userIdx = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!isRealUserRow(row)) continue;
    if (!String((row as { text?: string }).text || "").trim()) continue;
    userIdx = i;
    break;
  }
  if (userIdx < 0) return null;
  let turnStart = userIdx;
  if (userIdx > 0 && rows[userIdx - 1]?.kind === "turnHeader") {
    turnStart = userIdx - 1;
  }
  return { turnStart, userIdx };
}

/**
 * 在 softCap 内从直播轮向前挑「完整 turn」片段，禁止窗顶落在半截轮。
 *
 * 旧逻辑按行从尾截 older，长上一轮会被截成 mid-tool 开头（现场 window=56…809、
 * !HISTORY_TOP）；loadOlder 刚并进的更早行也会被同一刀吃掉。
 */
export function selectOlderCompleteTurnsWithinBudget(
  full: readonly ConversationRow[],
  liveStartRowId: number,
  budget: number,
): ConversationRow[] {
  const cap = Math.max(0, Math.floor(budget));
  if (cap <= 0) return [];
  const olderFull = full.filter((row) => row.rowId < liveStartRowId);
  if (olderFull.length === 0) return [];
  if (olderFull.length <= cap) {
    return olderFull[0]?.kind === "turnHeader" ? [...olderFull] : alignLeadingToTurnHeader(full, olderFull, cap);
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
  if (row.kind === "reasoning" || row.kind === "assistantText") {
    return String((row as { state?: string }).state || "") === "streaming";
  }
  if (row.kind === "toolCall") {
    const status = String((row as { status?: string }).status || "");
    return (
      status === "inputStreaming" ||
      status === "running" ||
      status === "pendingApproval" ||
      status === "awaitingInput"
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
  const inFlight = after.filter((row) => isInFlightProjectionRow(row));
  const inFlightIds = new Set(inFlight.map((row) => row.rowId));
  const settled = after.filter((row) => !inFlightIds.has(row.rowId));

  const reserved = head.length + inFlight.length;
  if (reserved >= cap) {
    // in-flight 本身已顶满：保头 + in-flight（可略超 cap，优先可见性）
    return [...head, ...inFlight];
  }
  const tailBudget = cap - reserved;
  const tail = tailBudget > 0 ? settled.slice(-tailBudget) : [];
  const keepIds = new Set<number>([
    ...head.map((r) => r.rowId),
    ...inFlight.map((r) => r.rowId),
    ...tail.map((r) => r.rowId),
  ]);
  return live.filter((row) => keepIds.has(row.rowId));
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
  const finish = (window: readonly ConversationRow[]) =>
    repairPartialTurnsInProjectionWindow(full, window);

  const span = liveTurnSpan(full);
  if (!span) {
    // 无直播轮（纯历史窗）：能对齐 turnHeader 就对齐；对齐不了别掏空窗口。
    const aligned = alignLeadingToTurnHeader(
      full,
      capped,
      Math.max(MIN_KEEP, Math.floor(softCap)),
    );
    return finish(aligned.length > 0 ? aligned : capped);
  }
  const live = full.slice(span.turnStart);
  if (live.length === 0) return finish(capped);
  const liveStartRowId = live[0]?.rowId ?? 0;
  const present = new Set(capped.map((r) => r.rowId));
  const liveMissing = live.some((r) => !present.has(r.rowId));
  const inFlightMissing = live.some(
    (r) => isInFlightProjectionRow(r) && !present.has(r.rowId),
  );

  // 直播轮已完整在窗内，且没有 in-flight 被裁掉：只修窗顶半截轮。
  if (!liveMissing && !inFlightMissing) {
    const aligned = alignLeadingToTurnHeader(
      full,
      capped,
      Math.max(MIN_KEEP, Math.floor(softCap) - live.length),
    );
    if (aligned.length === capped.length && aligned.every((row, i) => row.rowId === capped[i]?.rowId)) {
      // soft-cap prefer:tail 可能已把窗顶裁到直播轮起点，上一问整轮蒸发。
      // 此时仍从 full 补回至少一轮头+问锚点（可略超 softCap，优先可见性）。
      if (capped[0]?.rowId === liveStartRowId) {
        const olderKeep = selectOlderCompleteTurnsWithinBudget(
          full,
          liveStartRowId,
          MIN_OLDER_ANCHOR_BUDGET,
        );
        if (olderKeep.length > 0) return finish([...olderKeep, ...live]);
      }
      return finish(capped);
    }
    // align 若丢光 older 残片，保留原 capped 里的直播段 + 尽可能的完整 older。
    if (aligned.length === 0 || aligned[0]?.rowId === liveStartRowId) {
      const olderKeep = selectOlderCompleteTurnsWithinBudget(
        full,
        liveStartRowId,
        olderAnchorBudget(softCap, live.length),
      );
      return finish(olderKeep.length === 0 ? capped : [...olderKeep, ...live]);
    }
    return finish(aligned);
  }

  const cap = Math.max(MIN_KEEP, Math.floor(softCap));
  const liveKept = selectLiveTurnWithinBudget(live, span.userIdx, span.turnStart, cap);
  // 即便直播轮已占满 softCap，也绝不能把「上一问」整轮丢掉——发消息后
  // 长工具轮一撑大，旧逻辑 `liveKept.length >= cap → return liveKept` 会直接吃历史。
  const olderKeep = selectOlderCompleteTurnsWithinBudget(
    full,
    liveStartRowId,
    olderAnchorBudget(cap, liveKept.length),
  );
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

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
  projectionSoftCapForMemoryLevel,
  resolveRendererMemoryLevel,
} from "../../react/lib/renderer-memory-pressure.js";

/** 正常水位下的渲染层窗口软顶（行）。高压时见 {@link resolveProjectionWindowSoftCap}。 */
export const PROJECTION_WINDOW_SOFT_CAP = 400;

/** 分享全量导出允许更大窗口，避免截断分享目录。 */
export const PROJECTION_WINDOW_SHARE_CAP = 8_000;

/** 窗口内只对最近 N 行保留完整 tool output 文本；更早的工具卡文本瘦身。 */
export const PROJECTION_HEAVY_HORIZON = 60;

const MIN_KEEP = 40;
const LIGHT_TOOL_TEXT_CAP = 2_048;

function isTurnBoundary(row: ConversationRow | undefined): boolean {
  // 只认 turnHeader：落在 realUser 会裁掉紧前 header，半截轮界还会把旧结论挂窗顶。
  return !!row && row.kind === "turnHeader";
}

/** 按当前 renderer 内存水位取软顶（读不到 heap 时用默认 400）。 */
export function resolveProjectionWindowSoftCap(): number {
  return projectionSoftCapForMemoryLevel(resolveRendererMemoryLevel());
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

function lightenToolCallRow(row: ConversationRow): ConversationRow {
  if (row.kind !== "toolCall") return row;
  const output = row.output;
  if (!output || typeof output !== "object") return row;
  const text = typeof (output as { text?: unknown }).text === "string"
    ? (output as { text: string }).text
    : "";
  if (text.length <= LIGHT_TOOL_TEXT_CAP) return row;
  // 只截断长 text；display（截图/文件 diff/媒体卡）是历史的一部分，必须保留。
  return {
    ...row,
    output: {
      ...output,
      text: `${text.slice(0, LIGHT_TOOL_TEXT_CAP)}\n…[trimmed for memory]`,
    },
  } as ConversationRow;
}

/**
 * 保留窗口尾部 heavyHorizon 行的完整工具载荷；更早的 toolCall 丢掉 display、截断 text。
 * 多轮长跑时工具卡 JSON 是 renderer OOM 主因之一，不等于丢掉对话历史（行还在）。
 */
export function lightenProjectionRowsForMemory(
  rows: readonly ConversationRow[],
  heavyHorizon: number = PROJECTION_HEAVY_HORIZON,
): readonly ConversationRow[] {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const horizon = Math.max(10, Math.floor(heavyHorizon));
  if (rows.length <= horizon) return rows;
  const start = rows.length - horizon;
  let changed = false;
  const next = rows.map((row, i) => {
    if (i >= start) return row;
    const light = lightenToolCallRow(row);
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
  },
): readonly ConversationRow[] {
  const softCap = opts?.softCap ?? resolveProjectionWindowSoftCap();
  const prefer = opts?.prefer ?? "tail";
  const capped = capProjectionWindow(rows, softCap, prefer);
  return lightenProjectionRowsForMemory(capped, opts?.heavyHorizon ?? PROJECTION_HEAVY_HORIZON);
}

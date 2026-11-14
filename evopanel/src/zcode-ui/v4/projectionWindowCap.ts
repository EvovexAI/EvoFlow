/**
 * Renderer projection soft-cap：超大会话（复刻 1k–2k+ 行）若把完整历史常驻
 * `rows.window`，切会话/重绘会被拖死。Wire 首帧本就只给尾窗（~60），但
 * loadAllOlder / 长流式 delta 仍会把窗口撑爆——这里统一裁回软顶。
 *
 * - prefer `tail`：保最新（直播追加 / 导航探测）
 * - prefer `head`：保刚补拉的更早行（用户上滚 loadOlder）
 * 裁切尽量落在 turnHeader / userInput，避免半截 turn 挂在窗口头。
 */
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

/** 渲染层窗口软顶（行）。高于此值裁切；与 MEGA_PIN_ROW_SOFT_CAP(900) 无关——那是钉租约阈值。 */
export const PROJECTION_WINDOW_SOFT_CAP = 400;

/** 分享全量导出允许更大窗口，避免截断分享目录。 */
export const PROJECTION_WINDOW_SHARE_CAP = 8_000;

const MIN_KEEP = 40;

function isTurnBoundary(row: ConversationRow | undefined): boolean {
  if (!row) return false;
  return row.kind === "turnHeader" || (row.kind === "userInput" && row.origin === "realUser");
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
  if (!Array.isArray(rows) || rows.length <= cap) return rows;

  if (prefer === "head") {
    let end = cap;
    // 若切在 turn 中间，向后扩一点到边界（仍不超过原长）。
    while (end < rows.length && end < cap + 40 && !isTurnBoundary(rows[end])) {
      end += 1;
    }
    // 仍在中间则退回硬切，保证不超过 cap+40。
    if (end > cap + 40) end = cap;
    return rows.slice(0, end);
  }

  let start = rows.length - cap;
  // 向前找 turn 边界，避免窗口首行是工具卡/半截 assistant。
  while (start > 0 && start > rows.length - cap - 40 && !isTurnBoundary(rows[start])) {
    start -= 1;
  }
  if (start < rows.length - cap - 40) start = rows.length - cap;
  // 若仍非边界，向前扫到最近的 boundary（最多再让 80 行）。
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

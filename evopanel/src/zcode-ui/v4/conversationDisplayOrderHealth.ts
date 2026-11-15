/**
 * 投影窗口显示顺序 / 时间序硬校验（直播 + 历史同一套）。
 *
 * 权威序：rowId 会话内单调递增（协议）；同毫秒用 createdAtSeq。
 * createdAt 应非递减。realUser 之间也应按时间变新。
 *
 * 日志：`[v4-life] display_order` / `display_order_anomaly`
 */
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

export type DisplayOrderFinding = {
  code:
    | "latest_user_missing"
    | "latest_user_buried"
    | "stale_prev_turn_tail"
    | "expected_user_missing"
    | "row_id_regression"
    | "created_at_regression"
    | "user_time_regression"
    | "user_after_newer_content";
  detail: string;
};

export type DisplayOrderReport = {
  ok: boolean;
  findings: DisplayOrderFinding[];
  signature: string;
  latestUser: {
    rowId: number;
    text: string;
    turnId: string;
    /** 距窗口底的行数；0 = 就是最后一行 */
    indexFromEnd: number;
    indexFromStart: number;
    createdAt: number | null;
  } | null;
  windowRows: number;
  lastRowKind: string;
  lastRowTurnId: string;
  /** 若 rowId 乱序，给出按时间/rowId 重排后的行（调用方可选用） */
  repairedRows: readonly ConversationRow[] | null;
};

const BURY_WARN_ROWS = 25;
/** 同窗最多报告几条回归，避免刷屏 */
const MAX_REGRESSION_FINDINGS = 6;

function isRealUser(row: ConversationRow | undefined): boolean {
  return !!row && row.kind === "userInput" && row.origin === "realUser";
}

function rowText(row: ConversationRow | undefined): string {
  if (!row || row.kind !== "userInput") return "";
  return String(row.text || "").trim();
}

function rowCreatedAt(row: ConversationRow | undefined): number | null {
  if (!row || typeof (row as { createdAt?: unknown }).createdAt !== "number") return null;
  const n = Number((row as { createdAt: number }).createdAt);
  return Number.isFinite(n) ? n : null;
}

function rowCreatedAtSeq(row: ConversationRow | undefined): number {
  if (!row || typeof (row as { createdAtSeq?: unknown }).createdAtSeq !== "number") return 0;
  const n = Number((row as { createdAtSeq: number }).createdAtSeq);
  return Number.isFinite(n) ? n : 0;
}

/** rowId 优先；缺省再比 createdAt / createdAtSeq。乐观行（更大 rowId）自然靠后。 */
export function compareConversationRowsByTime(a: ConversationRow, b: ConversationRow): number {
  const idA = Number(a.rowId) || 0;
  const idB = Number(b.rowId) || 0;
  if (idA !== idB) return idA - idB;
  const tA = rowCreatedAt(a) ?? 0;
  const tB = rowCreatedAt(b) ?? 0;
  if (tA !== tB) return tA - tB;
  return rowCreatedAtSeq(a) - rowCreatedAtSeq(b);
}

export function repairConversationRowsOrder(
  rows: readonly ConversationRow[],
): { rows: readonly ConversationRow[]; changed: boolean } {
  if (!Array.isArray(rows) || rows.length < 2) return { rows, changed: false };
  let need = false;
  for (let i = 1; i < rows.length; i += 1) {
    if (compareConversationRowsByTime(rows[i - 1]!, rows[i]!) > 0) {
      need = true;
      break;
    }
  }
  if (!need) return { rows, changed: false };
  const next = [...rows].sort(compareConversationRowsByTime);
  return { rows: next, changed: true };
}

/**
 * @param expectedUserText 本次发送的 pending 文案（有则必须在窗口中匹配到）
 * @param turnLive 本会话回合是否在跑（直播时埋得过深也打 warn）
 */
export function inspectConversationDisplayOrder(
  rows: readonly ConversationRow[],
  opts?: {
    expectedUserText?: string | null;
    turnLive?: boolean;
    buryWarnRows?: number;
  },
): DisplayOrderReport {
  const findings: DisplayOrderFinding[] = [];
  const windowRows = Array.isArray(rows) ? rows.length : 0;
  const last = windowRows > 0 ? rows[windowRows - 1] : undefined;
  const lastRowKind = String(last?.kind || "");
  const lastRowTurnId = String(last?.turnId || "");

  // —— 全窗时间/rowId 序（历史 + 直播同一套）——
  let regressionCount = 0;
  for (let i = 1; i < windowRows && regressionCount < MAX_REGRESSION_FINDINGS; i += 1) {
    const prev = rows[i - 1]!;
    const cur = rows[i]!;
    const prevId = Number(prev.rowId) || 0;
    const curId = Number(cur.rowId) || 0;
    if (curId > 0 && prevId > 0 && curId < prevId) {
      findings.push({
        code: "row_id_regression",
        detail: `rowId 回退：#${i - 1} id=${prevId}(${prev.kind}) → #${i} id=${curId}(${cur.kind})`,
      });
      regressionCount += 1;
      continue;
    }
    const prevAt = rowCreatedAt(prev);
    const curAt = rowCreatedAt(cur);
    if (prevAt != null && curAt != null && curAt < prevAt - 1) {
      // 允许 1ms 误差；明显回退才报
      findings.push({
        code: "created_at_regression",
        detail: `createdAt 回退：#${i - 1} ${prev.kind}@${prevAt} → #${i} ${cur.kind}@${curAt} (Δ=${curAt - prevAt}ms)`,
      });
      regressionCount += 1;
    }
  }

  // realUser 序列必须越来越新（按 rowId / createdAt）
  let lastUserIdx = -1;
  let lastUserAt: number | null = null;
  let lastUserId = 0;
  for (let i = 0; i < windowRows; i += 1) {
    if (!isRealUser(rows[i])) continue;
    const at = rowCreatedAt(rows[i]);
    const id = Number(rows[i]!.rowId) || 0;
    if (lastUserIdx >= 0) {
      if (id > 0 && lastUserId > 0 && id < lastUserId) {
        findings.push({
          code: "user_time_regression",
          detail: `用户气泡 rowId 回退：「${rowText(rows[lastUserIdx]).slice(0, 20)}」(id=${lastUserId}) → 「${rowText(rows[i]).slice(0, 20)}」(id=${id})`,
        });
      } else if (at != null && lastUserAt != null && at < lastUserAt - 1) {
        findings.push({
          code: "user_time_regression",
          detail: `用户气泡时间回退：「${rowText(rows[lastUserIdx]).slice(0, 20)}」@${lastUserAt} → 「${rowText(rows[i]).slice(0, 20)}」@${at}`,
        });
      }
    }
    // 该用户之后若紧跟「更旧」的非乐观内容（createdAt 明显更早且 rowId 更小）——错位
    if (at != null) {
      for (let j = i + 1; j < Math.min(windowRows, i + 8); j += 1) {
        const later = rows[j]!;
        const laterAt = rowCreatedAt(later);
        const laterId = Number(later.rowId) || 0;
        if (laterId > 0 && id > 0 && laterId < id && laterAt != null && laterAt < at - 1000) {
          findings.push({
            code: "user_after_newer_content",
            detail: `用户「${rowText(rows[i]).slice(0, 20)}」之后出现更旧行 #${j} ${later.kind} id=${laterId}@${laterAt}`,
          });
          break;
        }
      }
    }
    lastUserIdx = i;
    lastUserAt = at;
    lastUserId = id;
  }

  let latestIdx = -1;
  for (let i = windowRows - 1; i >= 0; i -= 1) {
    if (isRealUser(rows[i])) {
      latestIdx = i;
      break;
    }
  }

  const latestUser =
    latestIdx >= 0
      ? {
          rowId: rows[latestIdx]!.rowId,
          text: rowText(rows[latestIdx]).slice(0, 40),
          turnId: String(rows[latestIdx]!.turnId || ""),
          indexFromEnd: windowRows - 1 - latestIdx,
          indexFromStart: latestIdx,
          createdAt: rowCreatedAt(rows[latestIdx]),
        }
      : null;

  const expected = String(opts?.expectedUserText || "").trim();
  if (expected) {
    let found = false;
    for (let i = windowRows - 1; i >= 0; i -= 1) {
      if (!isRealUser(rows[i])) continue;
      const t = rowText(rows[i]);
      if (!t) continue;
      if (t === expected || t.endsWith(expected) || expected.endsWith(t)) {
        found = true;
        break;
      }
    }
    if (!found) {
      findings.push({
        code: "expected_user_missing",
        detail: `刚发的「${expected.slice(0, 32)}」不在投影窗口（${windowRows} 行）里`,
      });
    }
  }

  if (opts?.turnLive && !latestUser && windowRows > 0) {
    findings.push({
      code: "latest_user_missing",
      detail: `直播中窗口无 realUser（尾行 kind=${lastRowKind} turn=${lastRowTurnId.slice(0, 12)}）`,
    });
  }

  const buryAt = opts?.buryWarnRows ?? BURY_WARN_ROWS;
  if (opts?.turnLive && latestUser && latestUser.indexFromEnd >= buryAt) {
    findings.push({
      code: "latest_user_buried",
      detail: `最新用户「${latestUser.text}」距窗口底 ${latestUser.indexFromEnd} 行（阈值 ${buryAt}）；贴底滚动时看不见气泡`,
    });
  }

  if (opts?.turnLive && latestUser && last && last.kind === "assistantText") {
    const lastTurn = String(last.turnId || "");
    if (lastTurn && latestUser.turnId && lastTurn !== latestUser.turnId) {
      findings.push({
        code: "stale_prev_turn_tail",
        detail: `窗口尾是上轮 assistantText(turn=${lastTurn.slice(0, 12)})，最新用户在 turn=${latestUser.turnId.slice(0, 12)} 且距底 ${latestUser.indexFromEnd} 行`,
      });
    }
  }

  const repaired = repairConversationRowsOrder(rows);
  const repairedRows =
    repaired.changed &&
    findings.some(
      (f) =>
        f.code === "row_id_regression" ||
        f.code === "created_at_regression" ||
        f.code === "user_time_regression" ||
        f.code === "user_after_newer_content",
    )
      ? repaired.rows
      : null;

  const signature = [
    latestUser ? `u${latestUser.rowId}:${latestUser.indexFromEnd}` : "u-",
    repairedRows ? "repaired" : "raw",
    ...findings.map((f) => `${f.code}:${f.detail}`),
  ].join("|");

  return {
    ok: findings.length === 0,
    findings,
    signature,
    latestUser,
    windowRows,
    lastRowKind,
    lastRowTurnId,
    repairedRows,
  };
}

export function summarizeDisplayOrderReport(report: DisplayOrderReport): string {
  const u = report.latestUser;
  const base = u
    ? `最新用户「${u.text}」row=${u.rowId} 距底 ${u.indexFromEnd}/${report.windowRows} 尾=${report.lastRowKind}`
    : `窗口无 realUser 尾=${report.lastRowKind} n=${report.windowRows}`;
  const repair = report.repairedRows ? "；已给出按 rowId/时间 重排列" : "";
  if (report.findings.length === 0) return `显示顺序正常：${base}`;
  return `显示顺序异常：${base}${repair}；${report.findings.map((f) => `[${f.code}] ${f.detail}`).join("；")}`;
}

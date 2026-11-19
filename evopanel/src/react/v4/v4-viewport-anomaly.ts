/**
 * 视口调试「异常表」：把流式/投影/滚动/上拉/绘画等可机器判定的异常收成一行一条。
 * 纯函数，供浮层与单测共用——用户抱怨「面板上明明能看出来却标 OK」时，优先扩这里。
 */

import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnits } from "@zcode/ui/v4/conversationTurnRenderUnits.js";

export type ViewportAnomalySeverity = "error" | "warn" | "info";

export type ViewportAnomalyCode =
  | "STREAM_AHEAD_OF_WINDOW"
  | "STREAM_LIVE_NO_DOM"
  | "LATEST_USER_MISSING"
  | "LATEST_USER_BELOW_WORK"
  | "LOADOLDER_NO_ADVANCE"
  | "HISTORY_TOP_STUCK"
  | "FOLLOW_STREAM_JUMP"
  | "SOFTCAP_TAIL_ONLY"
  | "PAINT_MEDIA_BURIED"
  | "EMPTY_ASSISTANT"
  | "EST72"
  | "STACK"
  | "COMPOSER_DRIFT";

export type ViewportAnomaly = {
  code: ViewportAnomalyCode;
  severity: ViewportAnomalySeverity;
  /** 一行给人看 */
  title: string;
  /** 证据：数字/rowId，方便对照轨迹 */
  detail: string;
};

export type ViewportAnomalyInput = {
  nowMs?: number;
  tid: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  executing: boolean;
  uiTurnSettled: boolean;
  /** 投影窗 */
  history: {
    hasOlder: boolean;
    loadingOlder: boolean;
    wouldTrigger: boolean;
    firstRowId: number | null;
    windowFirstRowId: number | null;
    windowLastRowId: number | null;
    windowCount: number;
    totalCount: number | null;
  };
  /** 可见 turn DOM 探针 */
  turns: ReadonlyArray<{
    orphanHeaderNoUser: boolean;
    emptyAssistantCompleted: boolean;
    hasUserInput: boolean;
  }>;
  layout?: {
    estimateStuck: boolean;
    stackedHostCount: number;
    composerDrifted: boolean;
  } | null;
  /** 投影窗原始行（可选；用于用户序 / 绘画卡位） */
  windowRows?: ReadonlyArray<{
    rowId: number;
    kind: string;
    origin?: string;
    turnId?: string;
    text?: string;
    displayKind?: string;
    hasMedia?: boolean;
  }>;
  streamEntries?: ReadonlyArray<{
    atMs: number;
    channel: string;
    sessionId: string;
    headline: string;
    jsonText: string;
  }>;
  apiEntries?: ReadonlyArray<{
    atMs: number;
    path: string;
    ok: boolean;
    sessionId: string;
    requestText: string;
    responseText: string;
  }>;
  scrollEntries?: ReadonlyArray<{
    atMs: number;
    jump: boolean;
    source: string;
    followingAttr: string | null;
  }>;
};

const STREAM_RECENT_MS = 8_000;
const API_RECENT_MS = 60_000;
const SCROLL_RECENT_MS = 30_000;

function extractStreamMaxRowId(
  entries: NonNullable<ViewportAnomalyInput["streamEntries"]>,
  tid: string,
  sinceMs: number,
): number | null {
  let max: number | null = null;
  for (const e of entries) {
    if (e.atMs < sinceMs) continue;
    if (e.channel !== "v4") continue;
    if (tid && e.sessionId && e.sessionId !== tid) continue;
    const fromHead = /#(\d+)/.exec(e.headline);
    const fromJson = /"rowId"\s*:\s*(\d+)/.exec(e.jsonText);
    for (const m of [fromHead, fromJson]) {
      if (!m) continue;
      const n = Number(m[1]);
      if (!Number.isFinite(n)) continue;
      if (max === null || n > max) max = n;
    }
  }
  return max;
}

function parseRowsRangeNoAdvance(
  entries: NonNullable<ViewportAnomalyInput["apiEntries"]>,
  tid: string,
  windowFirstRowId: number | null,
  sinceMs: number,
): { beforeRowId: number; fetchedFirst: number; count: number } | null {
  if (windowFirstRowId == null) return null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.atMs < sinceMs) break;
    if (!e.ok) continue;
    if (!e.path.includes("rows_range")) continue;
    if (tid && e.sessionId && e.sessionId !== tid) continue;
    let beforeRowId: number | null = null;
    try {
      const req = JSON.parse(e.requestText) as {
        body?: { beforeRowId?: number };
        beforeRowId?: number;
      };
      const raw = req.body?.beforeRowId ?? req.beforeRowId;
      if (typeof raw === "number") beforeRowId = raw;
    } catch {
      const m = /"beforeRowId"\s*:\s*(\d+)/.exec(e.requestText);
      if (m) beforeRowId = Number(m[1]);
    }
    if (beforeRowId == null || beforeRowId !== windowFirstRowId) continue;
    let fetchedFirst: number | null = null;
    let count = 0;
    try {
      const res = JSON.parse(e.responseText) as {
        rows?: Array<{ rowId?: number }>;
      };
      const rows = Array.isArray(res.rows) ? res.rows : [];
      count = rows.length;
      for (const row of rows) {
        const id = typeof row.rowId === "number" ? row.rowId : null;
        if (id == null) continue;
        if (fetchedFirst === null || id < fetchedFirst) fetchedFirst = id;
      }
    } catch {
      const m = /"rowId"\s*:\s*(\d+)/.exec(e.responseText);
      if (m) fetchedFirst = Number(m[1]);
      count = (e.responseText.match(/"rowId"/g) || []).length;
    }
    if (fetchedFirst != null && fetchedFirst < beforeRowId && count > 0) {
      return { beforeRowId, fetchedFirst, count };
    }
  }
  return null;
}

function latestRealUserIndex(
  rows: NonNullable<ViewportAnomalyInput["windowRows"]>,
): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.kind !== "userInput") continue;
    if (row.origin && row.origin !== "realUser") continue;
    if (!(row.text || "").trim()) continue;
    return i;
  }
  return -1;
}

/** 工作流启动轮 / 后台结果轮 / 控制轮：本来就可能没有助手正文，不算 EMPTY_ASSISTANT。 */
export function isEmptyAssistantExemptOrigin(
  headerOrigin: string | null | undefined,
  executionKind?: string | null,
): boolean {
  if (executionKind === "controlOnly") return true;
  const origin = String(headerOrigin || "").trim();
  return (
    origin === "workflowLaunch" ||
    origin === "backgroundResult" ||
    origin === "goalContinuation"
  );
}

/**
 * 已完成轮是否「真缺助手行」。只认 realUser；workflowLaunch 等豁免。
 * 供浮层探针与单测共用，避免重启后工作流测试会话误报。
 */
export function classifyEmptyAssistantCompleted(input: {
  headerOrigin?: string | null;
  headerState?: string | null;
  executionKind?: string | null;
  rows: ReadonlyArray<{ kind: string; origin?: string; text?: string }>;
}): boolean {
  if (isEmptyAssistantExemptOrigin(input.headerOrigin, input.executionKind)) {
    return false;
  }
  const state = String(input.headerState || "");
  if (!(state.startsWith("completed") || state === "failed")) return false;
  const hasRealUser = input.rows.some((row) => {
    if (row.kind !== "userInput") return false;
    if (row.origin && row.origin !== "realUser") return false;
    return Boolean((row.text || "").trim());
  });
  if (!hasRealUser) return false;
  const hasAssistantLike = input.rows.some((row) => {
    const k = String(row.kind || "");
    return (
      k === "assistantText" ||
      k === "reasoning" ||
      k === "toolCall" ||
      k === "subagent"
    );
  });
  return !hasAssistantLike;
}

/**
 * 用户可见序：走与时间线相同的 user-first materialize。
 * 只报「渲染后仍把已工作放在用户气泡上面」——raw rowId 工具先于用户不算（normalize 已修）。
 */
function latestUserBelowWorkInDisplay(
  rows: NonNullable<ViewportAnomalyInput["windowRows"]>,
): boolean {
  if (!rows.length) return false;
  const asRows = rows as unknown as ConversationRow[];
  let units: ReturnType<typeof buildConversationTurnRenderUnits>;
  try {
    units = buildConversationTurnRenderUnits(asRows, { sessionBusy: false });
  } catch {
    return false;
  }
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i]!;
    const hasReal = unit.visibleUserInputs.some(
      (u) =>
        (!u.origin || u.origin === "realUser") && Boolean(String(u.text || "").trim()),
    );
    if (!hasReal) continue;
    for (const seg of unit.workSegments ?? []) {
      const lead = seg.flowItems.find(
        (item) =>
          item.kind === "userInput" ||
          item.kind === "assistantHistory" ||
          item.kind === "assistantWork" ||
          item.kind === "assistantText" ||
          item.kind === "cuaGroup",
      );
      if (lead && lead.kind !== "userInput") return true;
    }
    return false;
  }
  return false;
}

function paintMediaBuried(
  rows: NonNullable<ViewportAnomalyInput["windowRows"]>,
): boolean {
  // 带 media 的 cua/platform 若后面还有大量非尾槽工作行，视为埋进「已工作」。
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.kind !== "toolCall" || !row.hasMedia) continue;
    if (row.displayKind !== "cua" && row.displayKind !== "platform_ui") continue;
    const turnId = String(row.turnId || "");
    let laterWork = 0;
    for (let j = i + 1; j < rows.length; j += 1) {
      const later = rows[j]!;
      if (turnId && String(later.turnId || "") !== turnId) break;
      if (
        later.kind === "toolCall" ||
        later.kind === "reasoning" ||
        later.kind === "assistantText"
      ) {
        // 尾槽后允许少量操作栏类；超过 2 条非 media 工作视为埋没
        if (!(later.hasMedia && later.kind === "toolCall")) laterWork += 1;
      }
    }
    if (laterWork >= 3) return true;
  }
  return false;
}

/**
 * 汇总当前可判定异常。按 severity 排序：error → warn → info。
 */
export function collectViewportAnomalies(
  input: ViewportAnomalyInput,
): ViewportAnomaly[] {
  const now = input.nowMs ?? Date.now();
  const out: ViewportAnomaly[] = [];
  const h = input.history;

  if (input.layout?.estimateStuck) {
    out.push({
      code: "EST72",
      severity: "warn",
      title: "行高估矮（≈72）",
      detail: "virtualizer 间距锁估高，易叠字/假贴底",
    });
  }
  if ((input.layout?.stackedHostCount ?? 0) > 0) {
    out.push({
      code: "STACK",
      severity: "error",
      title: "多宿主叠层",
      detail: `stackedHostCount=${input.layout?.stackedHostCount}`,
    });
  }
  if (input.layout?.composerDrifted) {
    out.push({
      code: "COMPOSER_DRIFT",
      severity: "warn",
      title: "输入框漂离时间线",
      detail: "composerDrift=1",
    });
  }

  if (input.turns.some((t) => t.orphanHeaderNoUser)) {
    out.push({
      code: "LATEST_USER_MISSING",
      severity: "error",
      title: "轮头声明有用户，窗内无用户气泡",
      detail: "orphanHeaderNoUser：最新问可能被软顶/尾窗挤出",
    });
  }
  if (input.turns.some((t) => t.emptyAssistantCompleted)) {
    out.push({
      code: "EMPTY_ASSISTANT",
      severity: "error",
      title: "已完成轮无助手行",
      detail: "!EMPTY_ASSISTANT：迟到 TEXT 或挂空 turnId",
    });
  }

  const rows = input.windowRows;
  if (rows && rows.length > 0) {
    if (latestUserBelowWorkInDisplay(rows)) {
      out.push({
        code: "LATEST_USER_BELOW_WORK",
        severity: "error",
        title: "最新用户气泡落在「已工作」下面",
        detail: "渲染后 flow 仍非 user-first（normalize 未生效）",
      });
    }
    if (paintMediaBuried(rows)) {
      out.push({
        code: "PAINT_MEDIA_BURIED",
        severity: "warn",
        title: "绘画/CUA 媒体埋在工作流中",
        detail: "带 media 的 cua/platform 后仍有多条工作行，应提到轮尾槽",
      });
    }
    const userIdx = latestRealUserIndex(rows);
    if (
      input.executing &&
      !input.uiTurnSettled &&
      userIdx < 0 &&
      rows.some((r) => r.kind === "turnHeader")
    ) {
      out.push({
        code: "LATEST_USER_MISSING",
        severity: "error",
        title: "直播中窗内看不到 realUser",
        detail: `window=${h.windowFirstRowId ?? "∅"}…${h.windowLastRowId ?? "∅"}`,
      });
    }
  }

  const streamMax = extractStreamMaxRowId(
    input.streamEntries ?? [],
    input.tid,
    now - STREAM_RECENT_MS,
  );
  if (
    streamMax != null &&
    h.windowLastRowId != null &&
    streamMax > h.windowLastRowId
  ) {
    out.push({
      code: "STREAM_AHEAD_OF_WINDOW",
      severity: "error",
      title: "流式已推进，投影窗末行落后",
      detail: `streamRow=${streamMax} > winLast=${h.windowLastRowId}（页面会像「没在动」）`,
    });
  }
  if (
    input.executing &&
    !input.uiTurnSettled &&
    (input.streamEntries ?? []).some(
      (e) =>
        e.atMs >= now - STREAM_RECENT_MS &&
        e.channel === "v4" &&
        (!e.sessionId || e.sessionId === input.tid),
    ) &&
    input.turns.length === 0
  ) {
    out.push({
      code: "STREAM_LIVE_NO_DOM",
      severity: "error",
      title: "流式在推，视口无 turn DOM",
      detail: "frames/deltas 有，data-v4-turn-unit 挂载数为 0",
    });
  }

  const noAdvance = parseRowsRangeNoAdvance(
    input.apiEntries ?? [],
    input.tid,
    h.windowFirstRowId,
    now - API_RECENT_MS,
  );
  if (noAdvance) {
    out.push({
      code: "LOADOLDER_NO_ADVANCE",
      severity: "error",
      title: "rows_range 已返回更早行，窗首未前进",
      detail: `before=${noAdvance.beforeRowId} fetchedFirst=${noAdvance.fetchedFirst} n=${noAdvance.count} winFirst仍=${h.windowFirstRowId}`,
    });
  }

  if (
    input.scrollTop <= 8 &&
    h.hasOlder &&
    !h.loadingOlder &&
    h.wouldTrigger
  ) {
    out.push({
      code: "HISTORY_TOP_STUCK",
      severity: "error",
      title: "几何到顶仍有更早，应自动拉却停着",
      detail: `scrollTop=${input.scrollTop} hasOlder=1 loading=0 auto=1 winFirst=${h.windowFirstRowId ?? "∅"}`,
    });
  }

  if (
    h.hasOlder &&
    h.windowFirstRowId != null &&
    h.windowLastRowId != null &&
    h.windowCount > 0 &&
    (h.totalCount ?? 0) > h.windowCount + 50 &&
    input.executing
  ) {
    out.push({
      code: "SOFTCAP_TAIL_ONLY",
      severity: "info",
      title: "软顶钉在尾窗，直播只在窗尾涨",
      detail: `已显示 ${h.windowCount}/${h.totalCount ?? "∅"} · 窗首=${h.windowFirstRowId}（上滚才能看更早）`,
    });
  }

  const recentJumps = (input.scrollEntries ?? []).filter(
    (e) =>
      e.atMs >= now - SCROLL_RECENT_MS &&
      e.jump &&
      e.source === "scrollToBottom" &&
      e.followingAttr !== "false",
  );
  if (input.executing && recentJumps.length >= 2) {
    out.push({
      code: "FOLLOW_STREAM_JUMP",
      severity: "warn",
      title: "跟底流式中 scrollToBottom 猛跳",
      detail: `近 ${Math.round(SCROLL_RECENT_MS / 1000)}s 内 !JUMP×${recentJumps.length}（测高中间帧抢吸底）`,
    });
  }

  const rank = { error: 0, warn: 1, info: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code));
  return out;
}

export function formatAnomalyBadge(anomalies: readonly ViewportAnomaly[]): string {
  if (anomalies.length === 0) return "";
  const errors = anomalies.filter((a) => a.severity === "error");
  const warns = anomalies.filter((a) => a.severity === "warn");
  const codes = (errors.length > 0 ? errors : warns.length > 0 ? warns : anomalies)
    .slice(0, 4)
    .map((a) => `!${a.code}`);
  const more =
    anomalies.length > codes.length ? ` +${anomalies.length - codes.length}` : "";
  return `${codes.join(" ")}${more}`;
}

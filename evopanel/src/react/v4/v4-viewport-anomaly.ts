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
  | "WIRE_WITHOUT_V4_TIP"
  /** V4 投递路径根因（优先于 WIRE_WITHOUT_V4_TIP 症状） */
  | "V4_PATH_FRAMES_DOWN"
  | "V4_PATH_NO_SUB"
  | "V4_PATH_SUB_STAGED"
  | "V4_PATH_HUB_AHEAD_NOTIFIED0"
  | "V4_PATH_HUB_AHEAD_NO_FRAMES"
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
  | "DOM_OVERLAP"
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
    turnId?: string;
    orphanHeaderNoUser: boolean;
    emptyAssistantCompleted: boolean;
    hasUserInput: boolean;
    /** 本卡底边压住下一卡（肉眼叠字） */
    overlapsNext?: boolean;
    spaceToNext?: number | null;
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
    state?: string;
    status?: string;
    displayKind?: string;
    hasMedia?: boolean;
  }>;
  /**
   * 投递路径健康度（可选）。有则用于压制 WIRE_WITHOUT_V4_TIP 误报：
   * 乐观泡先于 V4 tip 是正常竞态；fe/hub tip 已对齐或近期有 V4 帧时不报。
   */
  feTip?: number | null;
  hubTip?: number | null;
  lastV4AtMs?: number | null;
  streamEntries?: ReadonlyArray<{
    atMs: number;
    channel: string;
    sessionId: string;
    kindLabel?: string;
    summary?: string;
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
    /** 与跳变同帧的 scrollTop 变化（正=朝底）；用于与 dHeight 比较判定「必然贴底」 */
    dTop?: number | null;
    /** 与跳变同帧的 scrollHeight 变化：贴底在内容真长高时必然大跳，不算「猛跳」。 */
    dHeight?: number | null;
  }>;
};

const STREAM_RECENT_MS = 8_000;
const API_RECENT_MS = 60_000;
const SCROLL_RECENT_MS = 30_000;

/** 近窗流式 headline/json 里出现的最大 rowId（供异常表 / 虚拟化表共用）。 */
export function extractStreamMaxRowId(
  entries: NonNullable<ViewportAnomalyInput["streamEntries"]>,
  tid: string,
  sinceMs: number,
): number | null {
  let max: number | null = null;
  for (const e of entries) {
    if (e.atMs < sinceMs) continue;
    if (e.channel !== "v4") continue;
    if (tid && e.sessionId && e.sessionId !== tid) continue;
  // 【self-evolution-bot · 2026-11-26 · 第133轮 · 模型:deepseek-v4-1-flash-261017】extractStreamMaxRowId 跳过终态事件（cancelled/failed/complete），
  // 原因：一条已收口的 `platform · cancelled` 快照被当成"流式仍在推"，凭空造出 STREAM_AHEAD。
    // 终态事件不是「流式仍在推」的证据：现场一条 `platform · cancelled` 的
    // 工具事件被当成直播流，凭空触发 STREAM_AHEAD/NO_INFLIGHT。
    if (streamEntryIsTerminal(e)) continue;
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

  // 【self-evolution-bot · 2026-11-26 · 第133轮 · 模型:deepseek-v4-1-flash-261017】新增 streamEntryIsTerminal()，判「这条流式快照是否已收口」。
  // 原因：抓取 rowId 时只认 headline 不认状态，收口后仍会被算成"在推"。
/**
 * 该流式条目是否已收口（cancelled / 失败 / 终态）。
 *
 * 为什么需要：`extractStreamMaxRowId` 只认 rowId 不认状态，一条
 * 「工具 seq=3→3 · platform · cancelled」的快照事件也会被算成「流式在推」，
 * 于是已完成轮被报 STREAM_AHEAD_OF_WINDOW / NO_INFLIGHT_IN_WINDOW——
 * 诊断表自己制造了 2/5 条异常，把真正的缺陷藏进噪声里。
 */
export function streamEntryIsTerminal(
  e: NonNullable<ViewportAnomalyInput["streamEntries"]>[number],
): boolean {
  const blob = `${e.kindLabel || ""} ${e.summary || ""} ${e.headline || ""} ${e.jsonText || ""}`;
  if (/\bcancelled\b|\bcanceled\b|\baborted\b/i.test(blob)) return true;
  if (/\b(status|state)\s*[:=]\s*"?(failed|error|cancelled|complete|completed|success)"?/i.test(blob)) {
    return true;
  }
  return false;
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
    if (fetchedFirst == null || !(fetchedFirst < beforeRowId) || count <= 0) {
      continue;
    }
    // 同窗内若已有「更晚」的上拉用了更小的 before，说明窗首已前进过，本条是过期证据。
    let advancedLater = false;
    for (let j = i + 1; j < entries.length; j += 1) {
      const later = entries[j]!;
      if (!later.ok || !later.path.includes("rows_range")) continue;
      if (tid && later.sessionId && later.sessionId !== tid) continue;
      let laterBefore: number | null = null;
      try {
        const req = JSON.parse(later.requestText) as {
          body?: { beforeRowId?: number };
          beforeRowId?: number;
        };
        const raw = req.body?.beforeRowId ?? req.beforeRowId;
        if (typeof raw === "number") laterBefore = raw;
      } catch {
        const m2 = /"beforeRowId"\s*:\s*(\d+)/.exec(later.requestText);
        if (m2) laterBefore = Number(m2[1]);
      }
      if (laterBefore != null && laterBefore < beforeRowId) {
        advancedLater = true;
        break;
      }
    }
    if (advancedLater) continue;
    return { beforeRowId, fetchedFirst, count };
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
  const overlapTurns = input.turns.filter((t) => t.overlapsNext === true);
  if (overlapTurns.length > 0) {
    const worst = Math.min(
      ...overlapTurns.map((t) =>
        typeof t.spaceToNext === "number" ? t.spaceToNext : 0,
      ),
    );
    out.push({
      code: "DOM_OVERLAP",
      severity: "error",
      title: "视口卡片叠字",
      detail: `叠层×${overlapTurns.length} · 最严重 space→下=${worst}（负=压住下一卡；估高/virtualizer）`,
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

  // AG-UI 在跑（工作中）但 V4 投影 tip 不涨：乐观泡在、投影无此轮、streamMax 空。
  // 现场 19:11：mirror 已 feed，FE v4行钉死 2041，用户只见「工作中」。
  // 发信后乐观泡先于 V4 tip 是正常竞态（数百 ms）；fe/hub 已对齐或近期有 V4 帧时不报。
  if (input.executing && !input.uiTurnSettled) {
    const hasOptimistic = input.turns.some((t) =>
      String(t.turnId || "").startsWith("optimistic"),
    );
    const windowHasLive =
      !!rows &&
      rows.some((r) => {
        const state = String(r.state || "");
        const status = String(r.status || "");
        if (r.kind === "turnHeader" && (state === "running" || state.startsWith("running"))) {
          return true;
        }
        if (
          (r.kind === "assistantText" || r.kind === "reasoning") &&
          state === "streaming"
        ) {
          return true;
        }
        return status === "running" || status === "executing";
      });
    if (hasOptimistic && streamMax == null && !windowHasLive) {
      const TIP_OK_SLACK = 5;
      const WIRE_STALL_MS = 3_000;
      const feTip =
        typeof input.feTip === "number" && Number.isFinite(input.feTip)
          ? input.feTip
          : null;
      const hubTip =
        typeof input.hubTip === "number" && Number.isFinite(input.hubTip)
          ? input.hubTip
          : null;
      const tipDelta =
        feTip != null && hubTip != null ? hubTip - feTip : null;
      const tipsAligned =
        tipDelta != null && Math.abs(tipDelta) < TIP_OK_SLACK;
      const lastV4AgeMs =
        typeof input.lastV4AtMs === "number" &&
        Number.isFinite(input.lastV4AtMs)
          ? Math.max(0, now - input.lastV4AtMs)
          : null;
      // lastV4AtMs 未接线（单测旧口径）→ 仍按症状报；接上后必须卡住 ≥3s 才报。
      const stalled =
        input.lastV4AtMs === undefined
          ? true
          : lastV4AgeMs == null || lastV4AgeMs >= WIRE_STALL_MS;
      if (!tipsAligned && stalled) {
        out.push({
          code: "WIRE_WITHOUT_V4_TIP",
          severity: "error",
          title: "AG-UI 在跑，V4 投影未跟上",
          detail:
            "乐观泡/工作中有，但 streamMax=∅ 且窗内无 streaming——多半 frames 丢了；catchup 应 client-behind-resync",
        });
      }
    }
  }

  // 流式还在推正文/工具，但投影窗里没有 running/streaming —— 直播轮被软顶挤出
  // （现场：画面最新钉在 333，流式却在回 666）。
  if (rows && rows.length > 0 && input.executing && !input.uiTurnSettled) {
    const recentLiveStream = (input.streamEntries ?? []).some((e) => {
      if (e.atMs < now - STREAM_RECENT_MS) return false;
      if (e.sessionId && e.sessionId !== input.tid) return false;
      // 已收口（cancelled/failed/complete）的快照不是「仍在推」，否则每个
      // 正常回合收尾后都会残留一条假的 STREAM_AHEAD。
      if (streamEntryIsTerminal(e)) return false;
      const blob = `${e.kindLabel || ""} ${e.summary || ""} ${e.headline || ""}`;
      return /正文|工具|streaming|Δ|platform|bash/i.test(blob);
    });
    const windowHasLive = rows.some((r) => {
      const state = String(r.state || "");
      const status = String(r.status || "");
      if (r.kind === "turnHeader" && (state === "running" || state.startsWith("running"))) {
        return true;
      }
      if (
        (r.kind === "assistantText" || r.kind === "reasoning") &&
        state === "streaming"
      ) {
        return true;
      }
      if (
        r.kind === "toolCall" &&
        (status === "running" ||
          status === "inputStreaming" ||
          status === "pending" ||
          status === "executing" ||
          status === "pendingApproval" ||
          status === "awaitingInput")
      ) {
        return true;
      }
      return false;
    });
    if (recentLiveStream && !windowHasLive) {
      out.push({
        code: "STREAM_AHEAD_OF_WINDOW",
        severity: "error",
        title: "流式在推，投影窗无直播行",
        detail:
          "SSE/工具仍在更新，但 window 无 running/streaming（直播轮可能被软顶挤出）",
      });
    }
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

  // 【self-evolution-bot · 2026-11-26 · 第133轮 · 模型:deepseek-v4-1-flash-261017】FOLLOW_STREAM_JUMP 加"高度真长高就不算猛跳"豁免（dHeight≥80 且 ≥|dTop|/2）。
  // 原因：现场 4 条 !JUMP 的 dH 与 Δ 同号等幅，是跟底的必然位移，不是抢吸底。
  // 贴底大跳只有在「高度没变」时才算异常：内容真长高 24500px 后跟底必然跟着跳，
  // 把它当「测高中间帧抢吸底」会让每一次正常长内容的回合同时报一条假警告
  // （现场：dH 与 Δ 同号等幅 ±24427/±24501，纯属必然位移）。
  const recentJumps = (input.scrollEntries ?? []).filter(
    (e) =>
      e.atMs >= now - SCROLL_RECENT_MS &&
      e.jump &&
      e.source === "scrollToBottom" &&
      e.followingAttr !== "false" &&
      !(
        typeof e.dHeight === "number" &&
        Math.abs(e.dHeight) >= 80 &&
        Math.abs(e.dHeight) >= Math.abs((e as { dTop?: number }).dTop ?? 0) * 0.5
      ),
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
  // 标题栏给人看：用中文 title，不要 !STREAM_AHEAD_OF_WINDOW 这种内部码
  const pool = errors.length > 0 ? errors : warns.length > 0 ? warns : anomalies;
  const head = String(pool[0]?.title || pool[0]?.code || "").trim();
  if (!head) return "";
  const rest = anomalies.length - 1;
  return rest > 0 ? `${head} · 另${rest}条` : head;
}

/** 浮层用：error/warn 锁定，避免 700ms 轮询 + 时间窗证据滑出后标题栏一闪一闪。 */
export type StickyViewportAnomaly = ViewportAnomaly & {
  firstSeenAt: number;
  lastSeenAt: number;
  /** 本轮 collect 是否仍命中 */
  live: boolean;
};

/** 从 LOADOLDER 证据串解析 before=；窗首已小于 before 视为上拉已前进、可解除锁定。 */
export function loadOlderStuckBeforeFromDetail(detail: string): number | null {
  const m = /before=(\d+)/.exec(String(detail || ""));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function isLoadOlderNoAdvanceResolved(input: {
  detail: string;
  windowFirstRowId: number | null | undefined;
}): boolean {
  const stuckBefore = loadOlderStuckBeforeFromDetail(input.detail);
  const winFirst = input.windowFirstRowId;
  if (stuckBefore == null || winFirst == null) return false;
  return winFirst < stuckBefore;
}

/**
 * 把本帧 live 异常并入锁定表。
 * - tid 变了 → 清空重来
 * - error/warn：锁定到手动清或换会话；live=false 时仍展示（标「曾现」）
 * - LOADOLDER：若窗首已小于证据里的 before=，视为已前进，直接丢掉（避免粘滞误报）
 * - DOM_OVERLAP：本帧已无叠层则丢掉（估高 thrash 的「曾」在肉眼正常时只会吓人）
 * - WIRE_WITHOUT_V4_TIP：乐观泡竞态自愈后丢掉（「曾」只会吓人；真卡住会再 live）
 * - info：不锁定，只跟本帧
 */
export function mergeStickyViewportAnomalies(input: {
  tid: string;
  prevTid: string | null;
  prev: readonly StickyViewportAnomaly[];
  live: readonly ViewportAnomaly[];
  nowMs?: number;
  /** 当前投影窗首；用于解除已自愈的 LOADOLDER 粘滞 */
  windowFirstRowId?: number | null;
}): { tid: string; items: StickyViewportAnomaly[] } {
  const now = input.nowMs ?? Date.now();
  const liveCodes = new Set(input.live.map((a) => a.code));
  const base =
    input.prevTid && input.prevTid === input.tid ? [...input.prev] : [];
  const byCode = new Map(base.map((a) => [a.code, a] as const));

  for (const a of input.live) {
    if (a.severity === "info") {
      // info 不进锁定表；展示层会把 live info 另拼
      continue;
    }
    if (
      a.code === "LOADOLDER_NO_ADVANCE" &&
      isLoadOlderNoAdvanceResolved({
        detail: a.detail,
        windowFirstRowId: input.windowFirstRowId,
      })
    ) {
      byCode.delete(a.code);
      continue;
    }
    const prev = byCode.get(a.code);
    byCode.set(a.code, {
      ...a,
      firstSeenAt: prev?.firstSeenAt ?? now,
      lastSeenAt: now,
      live: true,
    });
  }

  const items: StickyViewportAnomaly[] = [];
  for (const sticky of byCode.values()) {
    if (sticky.severity === "info") continue;
    if (
      sticky.code === "LOADOLDER_NO_ADVANCE" &&
      isLoadOlderNoAdvanceResolved({
        detail: sticky.detail,
        windowFirstRowId: input.windowFirstRowId,
      })
    ) {
      continue;
    }
    // 叠层 / wire-tip 竞态只跟本帧：自愈后不必再挂「曾」吓人
    if (
      (sticky.code === "DOM_OVERLAP" ||
        sticky.code === "WIRE_WITHOUT_V4_TIP") &&
      !liveCodes.has(sticky.code)
    ) {
      continue;
    }
    items.push({
      ...sticky,
      live: liveCodes.has(sticky.code),
      // 仍 live 时用最新 title/detail；已熄灭保留最后一次证据
      ...(liveCodes.has(sticky.code)
        ? (input.live.find((x) => x.code === sticky.code) ?? {})
        : {}),
      firstSeenAt: sticky.firstSeenAt,
      lastSeenAt: liveCodes.has(sticky.code) ? now : sticky.lastSeenAt,
    });
  }

  // 本帧 info 附在末尾（不锁定）
  for (const a of input.live) {
    if (a.severity !== "info") continue;
    items.push({
      ...a,
      firstSeenAt: now,
      lastSeenAt: now,
      live: true,
    });
  }

  const rank = { error: 0, warn: 1, info: 2 };
  items.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      a.code.localeCompare(b.code) ||
      b.lastSeenAt - a.lastSeenAt,
  );
  return { tid: input.tid, items };
}

/**
 * 视口调试浮层用：页面相关 HTTP 接口入参/出参环形缓冲。
 * 在 fetchJson / evoflowFetch 轻量落盘（裁剪大字段），供浮层对照「接口 vs 渲染」。
 * 同时按会话写入 stream-compare/{sid}/overlay/viewport-api.log。
 */

import { persistViewportTap } from "./v4-viewport-tap-persist.js";

export type ViewportApiTapFamily =
  | "v4"
  | "messages"
  | "catchup"
  | "runs"
  | "other";

export type ViewportApiTapEntry = {
  id: number;
  atMs: number;
  method: string;
  /** 规范化 path（无 query） */
  path: string;
  /** 短标签：subscribe / 查历史 / catchup … */
  label: string;
  family: ViewportApiTapFamily;
  status: number;
  ok: boolean;
  durationMs: number;
  /** 请求摘要一行 */
  headline: string;
  requestText: string;
  responseText: string;
  errorText: string;
  /** query 字符串（无 ?） */
  query: string;
  /** body.sessionId / topic conversation/{id}，供按当前页签过滤 */
  sessionId: string;
  /**
   * 醒目标签。查历史上拉 =「查历史」；
   * 方便在接口表里一眼认出 loadOlder / rows_range。
   */
  badge: string;
  /**
   * 查历史分页人话：游标 before、limit、本页 rowId 起止、行数、hasMore。
   * 非查历史为空。
   */
  pageText: string;
  /**
   * 查历史本页消息预览（用户/正文/工具摘要，多行）。
   * 非查历史为空。
   */
  historyPreviewText: string;
};

function sessionIdFromApiBody(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const o = body as Record<string, unknown>;
  const sid = String(o.sessionId || o.threadId || "").trim();
  if (sid) return sid;
  const topic = String(o.topic || "").trim();
  const m = /^conversation\/([^/?#]+)/i.exec(topic);
  return m?.[1]?.trim() || "";
}

const MAX_RING = 200;
const MAX_REQ_CHARS = 48_000;
const MAX_RES_CHARS = 48_000;

let nextId = 1;
const ring: ViewportApiTapEntry[] = [];
const listeners = new Set<() => void>();

function clipText(raw: unknown, max: number): string {
  const s = String(raw ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[+${s.length - max} chars]`;
}

function safeJson(value: unknown, max: number): string {
  if (value == null) return "";
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return "";
    try {
      return safeJson(JSON.parse(t), max);
    } catch {
      return clipText(value, max);
    }
  }
  let text = "";
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return clipText(text, max);
}

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* overlay only */
    }
  }
}

/** 去掉 origin，只留 path?query */
export function normalizeApiUrl(url: unknown): { path: string; query: string; raw: string } {
  const raw = String(url || "").trim();
  if (!raw) return { path: "", query: "", raw: "" };
  let pathWithQuery = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      pathWithQuery = `${u.pathname}${u.search}`;
    }
  } catch {
    /* keep raw */
  }
  const qIdx = pathWithQuery.indexOf("?");
  if (qIdx < 0) return { path: pathWithQuery, query: "", raw };
  return {
    path: pathWithQuery.slice(0, qIdx),
    query: pathWithQuery.slice(qIdx + 1),
    raw,
  };
}

/**
 * 只收录与当前对话页相关的接口（轨迹消息 / V4 投影 / catchup / runs 控制）。
 * SSE 长流（frames / runs/stream）走「流式」页签，这里跳过。
 *
 * 查历史上拉：以 store.loadOlder→transport.rowsRange 为准打点（conversation.rowsRange）。
 * EvoFlow 腿是 HTTP `/api/v4/conversation/rows_range`；ZCode 腿是 RPC rowsRange。
 */
export function matchViewportPageApi(path: string): {
  family: ViewportApiTapFamily;
  label: string;
} | null {
  const p = String(path || "").split("?")[0] || "";

  // store 打点的「历史到达」：首屏 snapshot / 上拉 rowsRange
  if (
    p === "conversation.historySnapshot" ||
    p.endsWith("/conversation.historySnapshot")
  ) {
    return { family: "v4", label: "查历史·首屏" };
  }
  if (
    p === "conversation.rowsRange" ||
    p.endsWith("/conversation.rowsRange") ||
    p === "v4/store/rowsRange"
  ) {
    return { family: "v4", label: "查历史·上拉" };
  }
  // Agent RPC 腿
  if (
    p === "v4/conversation/rowsRange" ||
    p.endsWith("/v4/conversation/rowsRange") ||
    /(^|\/)conversationRowsRangeV4$/.test(p)
  ) {
    return { family: "v4", label: "查历史·上拉" };
  }

  if (!p.startsWith("/api/")) return null;

  // SSE：别进 HTTP 表
  if (p.includes("/conversation/frames")) return null;
  if (/\/runs\/stream$/.test(p) || p.includes("/runs/stream?")) return null;

  if (p.startsWith("/api/v4/conversation/catchup")) {
    // soft 对账也会带历史窗；family 仍 catchup，查历史筛靠 label 前缀
    return { family: "catchup", label: "查历史·对账" };
  }
  if (p.startsWith("/api/v4/conversation/subscribe")) {
    // V4 打开会话：历史首屏不走 /messages，而是 subscribe→SSE snapshot
    return { family: "v4", label: "查历史·订阅" };
  }
  if (p.startsWith("/api/v4/conversation/resync")) {
    return { family: "v4", label: "查历史·resync" };
  }
  if (p.startsWith("/api/v4/conversation/unsubscribe")) {
    return { family: "v4", label: "unsubscribe" };
  }
  if (p.startsWith("/api/v4/conversation/rows_range")) {
    return { family: "v4", label: "查历史·上拉" };
  }
  if (p.startsWith("/api/v4/conversation/command")) {
    return { family: "v4", label: "command" };
  }
  if (p.startsWith("/api/v4/conversation/file_changes")) {
    return { family: "v4", label: "file_changes" };
  }
  if (p.startsWith("/api/v4/conversation/workflowRuns")) {
    return { family: "v4", label: "workflowRuns" };
  }
  if (p.startsWith("/api/v4/conversation/")) {
    return { family: "v4", label: p.replace("/api/v4/conversation/", "") || "v4" };
  }

  if (
    /\/api\/chat\/sessions\/[^/]+\/messages/.test(p) ||
    /\/api\/chat\/sessions\/by-thread\/[^/]+\/messages/.test(p)
  ) {
    // 旧轨迹历史；V4 权威时多半被跳过，但仍算「查历史」族
    return { family: "messages", label: "查历史·轨迹" };
  }
  if (/\/api\/chat\/sessions\/[^/]+\/(run-status|run-idle|heartbeat)/.test(p)) {
    return { family: "runs", label: p.split("/").pop() || "run" };
  }

  if (p.startsWith("/api/langgraph/runs/cancel")) {
    return { family: "runs", label: "runs/cancel" };
  }
  if (/\/api\/langgraph\/threads\/[^/]+\/(state|history)/.test(p)) {
    return { family: "runs", label: p.includes("/history") ? "lg/history" : "lg/state" };
  }

  return null;
}

function parseBody(raw: unknown): unknown {
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function requestPreview(body: unknown): string {
  if (body == null) return "";
  if (typeof body !== "object" || Array.isArray(body)) {
    return clipText(typeof body === "string" ? body : safeJson(body, 200), 120);
  }
  const o = body as Record<string, unknown>;
  const bits: string[] = [];
  for (const key of [
    "topic",
    "sessionKey",
    "session_key",
    "threadId",
    "thread_id",
    "connectionId",
    "fromSeq",
    "toSeq",
    "beforeRowId",
    "limit",
    "intent",
  ]) {
    if (o[key] != null && o[key] !== "") {
      bits.push(`${key}=${clipText(o[key], 36)}`);
    }
  }
  if (bits.length) return bits.join(" ");
  return clipText(safeJson(body, 160), 120);
}

function responsePreview(data: unknown, status: number): string {
  if (data == null) return `HTTP ${status}`;
  if (typeof data !== "object" || Array.isArray(data)) {
    return clipText(typeof data === "string" ? data : safeJson(data, 160), 100);
  }
  const o = data as Record<string, unknown>;
  const bits: string[] = [`HTTP ${status}`];
  if (o.ack && typeof o.ack === "object") {
    const ack = o.ack as Record<string, unknown>;
    if (ack.mode != null) bits.push(`ack.mode=${ack.mode}`);
  }
  if (Array.isArray(o.messages)) bits.push(`messages=${o.messages.length}`);
  if (Array.isArray(o.items)) bits.push(`items=${o.items.length}`);
  // rows_range 直出 rows[]；snapshot 才是 rows.window
  if (Array.isArray(o.rows)) {
    bits.push(`本页=${o.rows.length}行`);
    if (typeof o.hasMore === "boolean") bits.push(`hasMore=${o.hasMore ? 1 : 0}`);
  } else if (o.rows && typeof o.rows === "object") {
    const rows = o.rows as Record<string, unknown>;
    if (Array.isArray(rows.window)) bits.push(`rows.window=${rows.window.length}`);
  }
  if (typeof o.ok === "boolean") bits.push(`ok=${o.ok ? 1 : 0}`);
  if (typeof o.detail === "string") bits.push(clipText(o.detail, 60));
  if (bits.length === 1) {
    const keys = Object.keys(o).slice(0, 6).join(",");
    if (keys) bits.push(`keys=${keys}`);
  }
  return bits.join(" · ");
}

function clipRowText(raw: unknown, max = 48): string {
  const s = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * 查历史（rows_range）分页人话 + 本页消息预览。
 * 游标语义：取 rowId < beforeRowId 的尾部 limit 行（升序一页）。
 */
export function summarizeRowsRangeHistory(
  requestBody: unknown,
  response: unknown,
): { pageText: string; historyPreviewText: string; headlineExtra: string } {
  const req =
    requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)
      ? (requestBody as Record<string, unknown>)
      : {};
  const beforeRaw = req.beforeRowId;
  const before =
    beforeRaw == null || beforeRaw === ""
      ? "∅(从最新往前)"
      : String(beforeRaw);
  const limit = Number(req.limit);
  const limitLabel = Number.isFinite(limit) && limit > 0 ? String(limit) : "?";

  const res =
    response && typeof response === "object" && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : null;
  const rows = Array.isArray(res?.rows) ? (res!.rows as Array<Record<string, unknown>>) : [];
  const hasMore =
    typeof res?.hasMore === "boolean" ? (res!.hasMore ? 1 : 0) : null;

  let firstId = "∅";
  let lastId = "∅";
  if (rows.length > 0) {
    const a = rows[0]?.rowId;
    const b = rows[rows.length - 1]?.rowId;
    if (a != null) firstId = String(a);
    if (b != null) lastId = String(b);
  }

  const pageText = [
    `游标 beforeRowId=${before}`,
    `每页 limit=${limitLabel}`,
    rows.length === 0
      ? "本页空"
      : `本页 rowId ${firstId}…${lastId}（${rows.length}行）`,
    hasMore == null ? null : `hasMore=${hasMore}`,
    res?.atSeq != null ? `atSeq=${res.atSeq}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const lines: string[] = [];
  let users = 0;
  let texts = 0;
  let tools = 0;
  let headers = 0;
  for (const row of rows) {
    const kind = String(row?.kind || "");
    if (kind === "turnHeader") {
      headers += 1;
      const state = String(row.state || "");
      lines.push(
        `  · 轮头 #${row.rowId ?? "∅"} ${String(row.turnId || "").slice(0, 8)} ${state}`,
      );
      continue;
    }
    if (kind === "userInput") {
      users += 1;
      const t = clipRowText(row.text, 60);
      lines.push(`  · 用户 #${row.rowId ?? "∅"} ${t || "（空）"}`);
      continue;
    }
    if (kind === "assistantText") {
      texts += 1;
      const t = clipRowText(row.text, 60);
      lines.push(`  · 正文 #${row.rowId ?? "∅"} ${t || "（空）"}`);
      continue;
    }
    if (kind === "reasoning") {
      const t = clipRowText(row.text, 40);
      lines.push(`  · 思考 #${row.rowId ?? "∅"} ${t || "（空）"}`);
      continue;
    }
    if (kind === "toolCall") {
      tools += 1;
      const name = String(row.toolName || row.name || "tool");
      const status = String(row.status || "");
      lines.push(
        `  · 工具 #${row.rowId ?? "∅"} ${name}${status ? `[${status}]` : ""}`,
      );
      continue;
    }
    if (kind) {
      lines.push(`  · ${kind} #${row.rowId ?? "∅"}`);
    }
  }
  const headCount = `本页构成：用户${users} · 正文${texts} · 工具${tools} · 轮头${headers} · 共${rows.length}行`;
  // 预览最多 40 行，避免撑爆浮层；完整 JSON 仍在出参里
  const previewBody =
    lines.length > 40
      ? `${lines.slice(0, 40).join("\n")}\n  …另有 ${lines.length - 40} 行见出参 JSON`
      : lines.join("\n");
  const historyPreviewText =
    rows.length === 0
      ? "（本页无行）"
      : `${headCount}\n${previewBody || "  （无可摘要 kind）"}`;

  const headlineExtra = [
    `before=${before}`,
    `limit=${limitLabel}`,
    rows.length === 0 ? "本页空" : `${firstId}…${lastId}×${rows.length}`,
    hasMore == null ? null : `hasMore=${hasMore}`,
  ]
    .filter(Boolean)
    .join(" ");

  return { pageText, historyPreviewText, headlineExtra };
}

/** subscribe / resync / catchup / 轨迹 messages：说明历史从哪来，不是分页 rows。 */
function summarizeHistoryControlCall(
  label: string,
  requestBody: unknown,
  response: unknown,
): { pageText: string; historyPreviewText: string; headlineExtra: string } {
  const req =
    requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)
      ? (requestBody as Record<string, unknown>)
      : {};
  const res =
    response && typeof response === "object" && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : null;

  if (label === "查历史·订阅" || label === "查历史·resync") {
    const mode = String(
      (res?.ack as { mode?: string } | undefined)?.mode ??
        req.mode ??
        req.intent ??
        "",
    );
    const pageText =
      "V4 打开会话：历史首屏不走 /messages，而是本请求订投影后由 SSE snapshot 下发窗口行（见同会话「查历史·首屏」）。";
    const historyPreviewText = [
      `控制面 ${label}`,
      mode ? `mode/intent=${mode}` : null,
      req.topic ? `topic=${String(req.topic)}` : null,
      req.sessionId ? `sessionId=${String(req.sessionId)}` : null,
      "行内容在随后 STORE conversation.historySnapshot，不在本 HTTP 出参里。",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      pageText,
      historyPreviewText,
      headlineExtra: mode ? `→SSE snapshot · ${mode}` : "→SSE snapshot",
    };
  }

  if (label === "查历史·对账") {
    return {
      pageText: "catchup 对账窗；可能带回一段投影行，详见出参 JSON。",
      historyPreviewText: "soft catchup / 对账，不是上拉分页。",
      headlineExtra: "catchup",
    };
  }

  if (label === "查历史·轨迹") {
    const count = Array.isArray(res)
      ? res.length
      : Array.isArray((res as { messages?: unknown[] } | null)?.messages)
        ? ((res as { messages: unknown[] }).messages.length)
        : null;
    return {
      pageText:
        "旧轨迹 GET …/messages。V4 权威会话常跳过此路径；若出现说明走了非 V4 首屏。",
      historyPreviewText:
        count == null ? "见出参 JSON" : `messages≈${count} 条（轨迹格式，非 V4 rows）`,
      headlineExtra: count == null ? "轨迹 messages" : `轨迹×${count}`,
    };
  }

  return {
    pageText: label,
    historyPreviewText: "",
    headlineExtra: label,
  };
}

export function pushViewportApiTap(opts: {
  method?: string;
  url: string;
  requestBody?: unknown;
  status: number;
  ok: boolean;
  durationMs: number;
  response?: unknown;
  error?: unknown;
}): void {
  const { path, query } = normalizeApiUrl(opts.url);
  const matched = matchViewportPageApi(path);
  if (!matched) return;

  const method = String(opts.method || "GET").toUpperCase();
  const req = parseBody(opts.requestBody);
  const res = opts.response;
  const errText =
    opts.error == null
      ? ""
      : clipText(
          typeof opts.error === "string"
            ? opts.error
            : (opts.error as { message?: string })?.message || safeJson(opts.error, 800),
          1200,
        );

  // 查历史族：首屏 subscribe/snapshot、上拉 rowsRange、旧 /messages、对账 catchup…
  const isHistory = matched.label.startsWith("查历史");
  const isHistoryPage =
    matched.label === "查历史·上拉" || matched.label === "查历史·首屏";
  const history = isHistoryPage
    ? summarizeRowsRangeHistory(req, res)
    : isHistory
      ? summarizeHistoryControlCall(matched.label, req, res)
      : { pageText: "", historyPreviewText: "", headlineExtra: "" };
  const badge = isHistory ? "查历史" : "";

  const headline = [
    method,
    matched.label,
    isHistory ? history.headlineExtra : responsePreview(res, opts.status),
    !isHistory && requestPreview(req) ? `← ${requestPreview(req)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const sessionId = sessionIdFromApiBody(req);
  const entry: ViewportApiTapEntry = {
    id: nextId++,
    atMs: Date.now(),
    method,
    path,
    label: matched.label,
    family: matched.family,
    status: Number(opts.status) || 0,
    ok: Boolean(opts.ok),
    durationMs: Math.max(0, Math.round(Number(opts.durationMs) || 0)),
    headline,
    requestText: safeJson(
      {
        method,
        path,
        query: query || undefined,
        body: req,
      },
      MAX_REQ_CHARS,
    ),
    responseText: errText
      ? safeJson({ error: errText, body: res ?? null }, MAX_RES_CHARS)
      : safeJson(res, MAX_RES_CHARS),
    errorText: errText,
    query,
    sessionId,
    badge,
    pageText: history.pageText,
    historyPreviewText: history.historyPreviewText,
  };
  ring.push(entry);
  while (ring.length > MAX_RING) ring.shift();
  if (sessionId) {
    persistViewportTap(sessionId, "api", {
      id: entry.id,
      atMs: entry.atMs,
      method: entry.method,
      path: entry.path,
      label: entry.label,
      family: entry.family,
      status: entry.status,
      ok: entry.ok,
      durationMs: entry.durationMs,
      headline: entry.headline,
      requestText: entry.requestText,
      responseText: entry.responseText,
      errorText: entry.errorText || undefined,
      query: entry.query || undefined,
      sessionId: entry.sessionId,
      badge: entry.badge || undefined,
      pageText: entry.pageText || undefined,
      historyPreviewText: entry.historyPreviewText || undefined,
    });
  }
  notify();
}

/** 会话过滤：全等或互为前缀（浮层 tid 有时只传入短前缀）。 */
export function sessionIdMatchesTap(
  entrySessionId: string,
  filterSessionId: string,
  requestText?: string,
): boolean {
  const sid = String(filterSessionId || "").trim();
  if (!sid) return true;
  const es = String(entrySessionId || "").trim();
  if (es) {
    if (es === sid) return true;
    if (es.startsWith(sid) || sid.startsWith(es)) return true;
  }
  return String(requestText || "").includes(sid);
}

/**
 * 投影 store 上拉历史总入口打点（loadOlder / autoBackfill / 目录探测）。
 * EvoFlow：SessionDataLayer→EvoFlowV4Transport→HTTP rows_range；
 * 都经 store.transport.rowsRange，在这里打点才不会漏。
 */
export function pushViewportRowsRangeTap(opts: {
  sessionId: string;
  beforeRowId?: number | null;
  limit: number;
  ok: boolean;
  durationMs: number;
  response?: unknown;
  error?: unknown;
  /** loadOlder | autoBackfill | turnDirectory */
  source?: string;
}): void {
  const source = String(opts.source || "rowsRange").trim() || "rowsRange";
  pushViewportApiTap({
    method: "STORE",
    url: "conversation.rowsRange",
    requestBody: {
      source,
      sessionId: opts.sessionId,
      beforeRowId: opts.beforeRowId ?? null,
      limit: opts.limit,
    },
    status: opts.ok ? 200 : 0,
    ok: opts.ok,
    durationMs: opts.durationMs,
    response: opts.response,
    error: opts.error,
  });
}

/**
 * V4 历史首屏：subscribe/resync 后 SSE snapshot 进 store 时打点。
 * 这才是打开会话时「查到的历史」——不是单独的 /messages HTTP。
 */
export function pushViewportHistorySnapshotTap(opts: {
  sessionId: string;
  source?: string;
  rows: unknown[];
  totalCount?: number | null;
  seq?: number | null;
  delivery?: string | null;
}): void {
  const rows = Array.isArray(opts.rows) ? opts.rows : [];
  const source = String(opts.source || "subscribe.snapshot").trim();
  pushViewportApiTap({
    method: "STORE",
    url: "conversation.historySnapshot",
    requestBody: {
      source,
      sessionId: opts.sessionId,
      delivery: opts.delivery ?? null,
      seq: opts.seq ?? null,
      totalCount: opts.totalCount ?? null,
      windowCount: rows.length,
      // 复用上拉摘要器：首屏无 before 游标，limit=本窗行数
      beforeRowId: null,
      limit: rows.length,
    },
    status: 200,
    ok: true,
    durationMs: 0,
    response: {
      rows,
      hasMore:
        typeof opts.totalCount === "number"
          ? opts.totalCount > rows.length
          : null,
      atSeq: opts.seq ?? null,
    },
  });
}

export function listViewportApiTapEntries(opts?: {
  family?: ViewportApiTapFamily | "all" | "history" | null;
  /** 当前页签 tid；有值时默认只看本会话（prefetch/旁路会话另计） */
  sessionId?: string | null;
  includeForeign?: boolean;
  limit?: number;
}): ViewportApiTapEntry[] {
  const limit = Math.max(1, Math.min(MAX_RING, opts?.limit ?? MAX_RING));
  const family = opts?.family && opts.family !== "all" ? opts.family : null;
  const sid = String(opts?.sessionId || "").trim();
  let source = ring;
  if (family === "history") {
    source = ring.filter((e) => {
      if (e.badge.startsWith("查历史") || e.label.startsWith("查历史")) return true;
      const p = e.path;
      return (
        p.includes("rows_range") ||
        p.includes("rowsRange") ||
        p.includes("conversation.rowsRange") ||
        p.includes("conversation.historySnapshot") ||
        p.includes("/subscribe") ||
        p.includes("/resync") ||
        p.includes("/catchup") ||
        /\/messages(\?|$)/.test(p)
      );
    });
  } else if (family) {
    source = ring.filter((e) => e.family === family);
  }
  if (sid && !opts?.includeForeign) {
    source = source.filter((e) =>
      sessionIdMatchesTap(e.sessionId, sid, e.requestText),
    );
  }
  return source.slice(-limit);
}

export function subscribeViewportApiTap(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearViewportApiTap(): void {
  ring.length = 0;
  notify();
}

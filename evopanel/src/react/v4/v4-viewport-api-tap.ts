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
  /** 短标签：subscribe / messages / catchup … */
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
 */
export function matchViewportPageApi(path: string): {
  family: ViewportApiTapFamily;
  label: string;
} | null {
  const p = String(path || "").split("?")[0] || "";
  if (!p.startsWith("/api/")) return null;

  // SSE：别进 HTTP 表
  if (p.includes("/conversation/frames")) return null;
  if (/\/runs\/stream$/.test(p) || p.includes("/runs/stream?")) return null;

  if (p.startsWith("/api/v4/conversation/catchup")) {
    return { family: "catchup", label: "catchup" };
  }
  if (p.startsWith("/api/v4/conversation/subscribe")) {
    return { family: "v4", label: "subscribe" };
  }
  if (p.startsWith("/api/v4/conversation/resync")) {
    return { family: "v4", label: "resync" };
  }
  if (p.startsWith("/api/v4/conversation/unsubscribe")) {
    return { family: "v4", label: "unsubscribe" };
  }
  if (p.startsWith("/api/v4/conversation/rows_range")) {
    return { family: "v4", label: "rows_range" };
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
    return { family: "messages", label: "messages" };
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
  if (o.rows && typeof o.rows === "object") {
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

  const headline = [
    method,
    matched.label,
    responsePreview(res, opts.status),
    requestPreview(req) ? `← ${requestPreview(req)}` : "",
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
    });
  }
  notify();
}

export function listViewportApiTapEntries(opts?: {
  family?: ViewportApiTapFamily | "all" | null;
  /** 当前页签 tid；有值时默认只看本会话（prefetch/旁路会话另计） */
  sessionId?: string | null;
  includeForeign?: boolean;
  limit?: number;
}): ViewportApiTapEntry[] {
  const limit = Math.max(1, Math.min(MAX_RING, opts?.limit ?? MAX_RING));
  const family = opts?.family && opts.family !== "all" ? opts.family : null;
  const sid = String(opts?.sessionId || "").trim();
  let source = family ? ring.filter((e) => e.family === family) : ring;
  if (sid && !opts?.includeForeign) {
    source = source.filter((e) => {
      if (e.sessionId) return e.sessionId === sid;
      // 旧环未打 sessionId：从 requestText 兜底，避免把别的会话 rows_range 混进来
      return e.requestText.includes(sid);
    });
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

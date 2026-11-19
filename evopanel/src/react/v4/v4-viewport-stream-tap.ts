/**
 * 视口调试浮层用：AG-UI / V4 流式原始帧环形缓冲。
 * 在 wire 入口轻量落盘（裁剪大字段），供浮层滚动查看「流式长什么样」。
 *
 * 一行 headline 必须能看清：序号 + 思考/正文/工具 + 内容摘要。
 * V4 的 row.delta 只有 path/append（没有 text 字段）；靠旁路记住 rowId→kind。
 * 同时按会话写入 stream-compare/{sid}/overlay/viewport-stream.log。
 */

import { persistViewportTap } from "./v4-viewport-tap-persist.js";

export type ViewportStreamTapChannel = "agui" | "v4" | "openai" | "evf" | "raw";

export type ViewportStreamTapEntry = {
  id: number;
  atMs: number;
  channel: ViewportStreamTapChannel;
  sessionKey: string;
  /** V4 topic 里的 conversation/{sessionId}；用于按当前页签 tid 过滤 */
  sessionId: string;
  runId: string;
  type: string;
  headline: string;
  jsonText: string;
};

/** conversation/{uuid} → uuid；其它 topic 返回空。 */
export function sessionIdFromV4Topic(topic: unknown): string {
  const t = String(topic || "").trim();
  const m = /^conversation\/([^/?#]+)/i.exec(t);
  return m?.[1]?.trim() || "";
}

const MAX_RING = 200;
const MAX_JSON_CHARS = 48_000;
const MAX_DELTA_CHARS = 400;
const MAX_HEAD_SNIPPET = 240;
const MAX_HEAD_DELTAS = 8;

let nextId = 1;
const ring: ViewportStreamTapEntry[] = [];
const listeners = new Set<() => void>();

/** rowId → kind（及可选 toolName），供后续 row.delta 标成「思考/正文/工具」。 */
const rowMetaById = new Map<number, { kind: string; toolName?: string }>();
const MAX_ROW_META = 400;

function clipText(raw: unknown, max: number): string {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}[+${s.length - max}]`;
}

function safeJson(value: unknown, max = MAX_JSON_CHARS): string {
  let text = "";
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[+${text.length - max} chars]`;
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

function rememberRowMeta(
  rowId: unknown,
  kind: unknown,
  toolName?: unknown,
): void {
  const id = typeof rowId === "number" ? rowId : Number(rowId);
  if (!Number.isFinite(id) || id <= 0) return;
  const k = String(kind || "").trim();
  if (!k) return;
  const tool = String(toolName || "").trim();
  rowMetaById.set(id, tool ? { kind: k, toolName: tool } : { kind: k });
  while (rowMetaById.size > MAX_ROW_META) {
    const first = rowMetaById.keys().next().value;
    if (first === undefined) break;
    rowMetaById.delete(first);
  }
}

function labelForRowKind(kind: string, toolName?: string): string {
  switch (kind) {
    case "reasoning":
      return "思考";
    case "assistantText":
      return "正文";
    case "userInput":
      return "用户";
    case "toolCall":
      return toolName ? `工具:${toolName}` : "工具";
    case "turnHeader":
      return "轮头";
    case "subagent":
      return "子代理";
    case "activity":
      return "活动";
    default:
      return kind || "?";
  }
}

function labelForDeltaPath(
  path: string,
  meta: { kind: string; toolName?: string } | undefined,
): string {
  if (meta) {
    if (path === "inputText") {
      return meta.toolName ? `工具入:${meta.toolName}` : "工具入";
    }
    if (path === "output.text") {
      return meta.toolName ? `工具出:${meta.toolName}` : "工具出";
    }
    if (path === "summaryText") return "摘要";
    if (path === "text") return labelForRowKind(meta.kind, meta.toolName);
  }
  if (path === "inputText") return "工具入";
  if (path === "output.text") return "工具出";
  if (path === "summaryText") return "摘要";
  // 尚无 row 元数据时不要猜「思考」——避免浮层写思考但页面其实是正文/未知行。
  if (path === "text") return "text(待辨)";
  return path || "流";
}

function rowBodySnippet(row: Record<string, unknown>): string {
  if (typeof row.text === "string" && row.text.trim()) {
    return clipText(row.text, MAX_HEAD_SNIPPET);
  }
  if (typeof row.inputText === "string" && row.inputText.trim()) {
    return clipText(row.inputText, MAX_HEAD_SNIPPET);
  }
  const output = row.output;
  if (output && typeof output === "object") {
    const text = (output as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      return clipText(text, MAX_HEAD_SNIPPET);
    }
  }
  if (typeof row.status === "string" && row.status) return row.status;
  if (typeof row.state === "string" && row.state) return row.state;
  return "";
}

/** 单条 V4 delta → 一行可读摘要（供 headline / JSON sample）。 */
export function summarizeV4Delta(delta: unknown): {
  line: string;
  sample: Record<string, unknown>;
} {
  if (!delta || typeof delta !== "object") {
    const raw = clipText(delta, 80);
    return { line: raw, sample: { raw } };
  }
  const o = delta as Record<string, unknown>;
  const op = String(o.op || o.kind || o.type || "?").trim();

  if (op === "row.delta") {
    const rowId = typeof o.rowId === "number" ? o.rowId : Number(o.rowId);
    const path = String(o.path || "text");
    const append = typeof o.append === "string" ? o.append : "";
    const meta =
      Number.isFinite(rowId) && rowId > 0 ? rowMetaById.get(rowId) : undefined;
    const label = labelForDeltaPath(path, meta);
    const snip = clipText(append, MAX_HEAD_SNIPPET);
    const line = `#${Number.isFinite(rowId) ? rowId : "?"} ${label} Δ${append.length}${
      snip ? ` ${snip}` : ""
    }`;
    return {
      line,
      sample: {
        op,
        rowId: Number.isFinite(rowId) ? rowId : null,
        path,
        kind: meta?.kind ?? null,
        label,
        appendLen: append.length,
        append: snip || undefined,
      },
    };
  }

  if (op === "row.appended" || op === "row.upserted") {
    const row =
      o.row && typeof o.row === "object"
        ? (o.row as Record<string, unknown>)
        : null;
    const rowId = row && typeof row.rowId === "number" ? row.rowId : null;
    const kind = row ? String(row.kind || "") : "";
    const toolName = row ? String(row.toolName || row.name || "") : "";
    if (rowId != null) rememberRowMeta(rowId, kind, toolName);
    const label = labelForRowKind(kind, toolName || undefined);
    const snip = row ? rowBodySnippet(row) : "";
    const mark = op === "row.appended" ? "+" : "~";
    const status =
      row && typeof row.status === "string" ? row.status : "";
    const line = `${mark}#${rowId ?? "?"} ${label}${
      status && kind === "toolCall" ? `[${status}]` : ""
    }${snip ? ` ${snip}` : ""}`;
    return {
      line,
      sample: {
        op,
        rowId,
        kind: kind || null,
        toolName: toolName || null,
        label,
        status: status || null,
        text: snip || undefined,
      },
    };
  }

  if (op === "row.removed") {
    const from = o.fromRowId;
    return {
      line: `removed ≥#${from ?? "?"}`,
      sample: { op, fromRowId: from ?? null },
    };
  }

  if (op === "state.updated") {
    return { line: "state.updated", sample: { op } };
  }

  if (op.startsWith("workflowRun.")) {
    return {
      line: `${op}${o.runId ? ` ${String(o.runId).slice(0, 10)}` : ""}`,
      sample: { op, runId: o.runId ?? null },
    };
  }

  return {
    line: clipText(op, 80),
    sample: {
      op,
      rowId: o.rowId ?? null,
      turnId:
        typeof o.turnId === "string" ? String(o.turnId).slice(0, 12) : null,
    },
  };
}

function pushEntry(
  entry: Omit<ViewportStreamTapEntry, "id" | "atMs" | "sessionId"> & {
    sessionId?: string;
  },
): void {
  const full: ViewportStreamTapEntry = {
    ...entry,
    sessionId: String(entry.sessionId || "").trim(),
    id: nextId++,
    atMs: Date.now(),
  };
  ring.push(full);
  while (ring.length > MAX_RING) ring.shift();
  const persistKey = full.sessionId || full.sessionKey;
  if (persistKey) {
    persistViewportTap(persistKey, "stream", {
      id: full.id,
      atMs: full.atMs,
      channel: full.channel,
      sessionKey: full.sessionKey || undefined,
      sessionId: full.sessionId || undefined,
      runId: full.runId || undefined,
      type: full.type,
      headline: full.headline,
      jsonText: full.jsonText,
    });
  }
  notify();
}

function aguiTypeLabel(type: string): string {
  const t = type.toUpperCase();
  if (t.includes("REASONING")) return "思考";
  if (t === "TEXT_MESSAGE_CONTENT" || t === "TEXT_MESSAGE_CHUNK") return "正文";
  if (t.startsWith("TEXT_MESSAGE")) return "正文";
  if (t.startsWith("TOOL_CALL")) return "工具";
  if (t === "RUN_STARTED") return "开跑";
  if (t === "RUN_FINISHED") return "收尾";
  if (t === "RUN_ERROR") return "错误";
  return "";
}

/** AG-UI / OpenAI / EVF 原始 data 对象 → 裁剪后入环 */
export function pushViewportStreamAguiTap(opts: {
  channel?: ViewportStreamTapChannel;
  sessionKey?: string;
  runId?: string;
  data: Record<string, unknown> | null | undefined;
}): void {
  const data = opts.data && typeof opts.data === "object" ? opts.data : null;
  if (!data) return;
  const type = String(data.type || "").trim() || "?";
  const runId =
    String(opts.runId || data.runId || "")
      .trim()
      .slice(0, 36) || "";
  const sessionKey = String(opts.sessionKey || "").trim();
  const channel = opts.channel || "agui";
  const typeLabel = aguiTypeLabel(type);

  const compact: Record<string, unknown> = { type };
  if (typeLabel) compact.label = typeLabel;
  if (runId) compact.runId = runId;
  if (typeof data.threadId === "string" && data.threadId) {
    compact.threadId = String(data.threadId).slice(0, 36);
  }
  if (typeof data.messageId === "string" && data.messageId) {
    compact.messageId = String(data.messageId).slice(0, 40);
  }
  if (typeof data.toolCallId === "string" && data.toolCallId) {
    compact.toolCallId = String(data.toolCallId).slice(0, 40);
  }
  if (typeof data.toolCallName === "string" && data.toolCallName) {
    compact.toolCallName = data.toolCallName;
  }
  if (typeof data.name === "string" && data.name) compact.name = data.name;
  if (typeof data.delta === "string") {
    compact.deltaLen = data.delta.length;
    compact.delta = clipText(data.delta, MAX_DELTA_CHARS);
  }
  if (typeof data.content === "string") {
    compact.contentLen = data.content.length;
    compact.content = clipText(data.content, MAX_DELTA_CHARS);
  }
  if (data.result !== undefined) {
    compact.result = clipText(
      typeof data.result === "string" ? data.result : safeJson(data.result, 400),
      240,
    );
  }
  if (typeof data.status === "string") compact.status = data.status;
  if (data.value !== undefined && typeof data.value !== "object") {
    compact.value = data.value;
  }

  const bits: string[] = [channel];
  if (typeLabel) bits.push(typeLabel);
  bits.push(type);
  if (typeof data.toolCallName === "string" && data.toolCallName) {
    bits.push(data.toolCallName);
  }
  if (typeof data.delta === "string" && data.delta) {
    bits.push(`Δ${data.delta.length} ${clipText(data.delta, MAX_HEAD_SNIPPET)}`);
  } else if (typeof data.content === "string" && data.content) {
    bits.push(clipText(data.content, MAX_HEAD_SNIPPET));
  }

  const threadId =
    typeof data.threadId === "string" ? String(data.threadId).trim() : "";
  pushEntry({
    channel,
    sessionKey,
    sessionId: threadId,
    runId,
    type,
    headline: bits.join(" · "),
    jsonText: safeJson(compact),
  });
}

/** V4 frames SSE 候选帧 → 摘要入环（不塞整窗 snapshot rows） */
export function pushViewportStreamV4Tap(opts: {
  topic?: string;
  deliveryKind?: string;
  wireBytes?: number;
  frame?: {
    fromSeq?: number;
    toSeq?: number;
    subscriptionId?: string;
    payload?: {
      kind?: string;
      deltas?: unknown[];
      snapshot?: { rows?: { window?: unknown[] } | unknown[] };
    };
  };
}): void {
  const frame = opts.frame;
  const payload = frame?.payload;
  const kind = String(payload?.kind || opts.deliveryKind || "frame").trim();
  let windowRows = 0;
  const rows = payload?.snapshot?.rows;
  if (Array.isArray(rows)) windowRows = rows.length;
  else if (rows && typeof rows === "object" && Array.isArray(rows.window)) {
    windowRows = rows.window.length;
    for (const row of rows.window) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      rememberRowMeta(r.rowId, r.kind, r.toolName || r.name);
    }
  }
  const deltas = Array.isArray(payload?.deltas) ? payload!.deltas! : [];
  const deltaCount = deltas.length;
  const topic = String(opts.topic || "").trim();
  const fromSeq = frame?.fromSeq ?? null;
  const toSeq = frame?.toSeq ?? null;

  const deltaSummaries = deltas.map((d) => summarizeV4Delta(d));
  const headLines = deltaSummaries
    .slice(0, MAX_HEAD_DELTAS)
    .map((s) => s.line)
    .filter(Boolean);

  const compact: Record<string, unknown> = {
    channel: "v4",
    kind,
    deliveryKind: opts.deliveryKind || null,
    topic: topic || null,
    fromSeq,
    toSeq,
    subscriptionId: frame?.subscriptionId
      ? String(frame.subscriptionId).slice(0, 28)
      : null,
    windowRows,
    deltaCount,
    wireBytes: opts.wireBytes ?? null,
  };
  if (deltaSummaries.length > 0) {
    compact.deltaSample = deltaSummaries
      .slice(0, 4)
      .map((s) => s.sample);
  }

  const sessionId = sessionIdFromV4Topic(topic);
  const seqBit =
    fromSeq != null || toSeq != null
      ? `seq=${fromSeq ?? "?"}→${toSeq ?? "?"}`
      : "";
  const detailBit =
    headLines.length > 0
      ? headLines.join(" | ")
      : windowRows
        ? `rows=${windowRows}`
        : kind;
  const more =
    deltaCount > MAX_HEAD_DELTAS
      ? ` [+${deltaCount - MAX_HEAD_DELTAS}]`
      : "";

  pushEntry({
    channel: "v4",
    sessionKey: "",
    sessionId,
    runId: "",
    type: kind,
    headline: [
      "v4",
      kind,
      seqBit,
      detailBit + more,
      sessionId ? sessionId.slice(0, 8) : "",
    ]
      .filter(Boolean)
      .join(" · "),
    jsonText: safeJson(compact),
  });
}

export function listViewportStreamTapEntries(opts?: {
  sessionKey?: string | null;
  /** 当前页签 conversation tid；优先按它过滤，避免别的会话 SSE 混进浮层 */
  sessionId?: string | null;
  limit?: number;
  /** true 时不过滤（排查全局噪声） */
  includeForeign?: boolean;
}): ViewportStreamTapEntry[] {
  const limit = Math.max(1, Math.min(MAX_RING, opts?.limit ?? MAX_RING));
  const sk = String(opts?.sessionKey || "").trim();
  const sid = String(opts?.sessionId || "").trim();
  if (opts?.includeForeign || (!sk && !sid)) {
    return ring.slice(-limit);
  }
  const source = ring.filter((e) => {
    if (sid) {
      if (e.sessionId && e.sessionId === sid) return true;
      // 旧环条目未带 sessionId：从 json 里的 topic 兜底
      if (!e.sessionId && e.channel === "v4" && e.jsonText.includes(sid)) {
        return true;
      }
      return false;
    }
    if (!e.sessionKey) return false;
    return e.sessionKey === sk;
  });
  return source.slice(-limit);
}

export function subscribeViewportStreamTap(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearViewportStreamTap(): void {
  ring.length = 0;
  rowMetaById.clear();
  notify();
}

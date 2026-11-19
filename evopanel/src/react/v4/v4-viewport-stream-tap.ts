/**
 * 视口调试浮层用：AG-UI / V4 流式原始帧环形缓冲。
 * 在 wire 入口轻量落盘（裁剪大字段），供浮层滚动查看「流式长什么样」。
 *
 * 浮层默认只看：序号 + 时间 + 类型(用户/正文/思考/工具) + 摘要；
 * 点开才展开 JSON。V4 有 deltas 时按条落环，避免挤成一坨。
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
  /** 类型短标：用户 / 正文 / 思考 / 工具 / 开跑… */
  kindLabel: string;
  /** 给人看的摘要：用户文案 / 正文前几句 / 工具名 / 思考开头 */
  summary: string;
  /** 兼容旧诊断复制：kindLabel + summary */
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
/** 摘要约前 2 句 / ~120 字，够扫一眼 */
const MAX_HEAD_SNIPPET = 120;
const MAX_HEAD_DELTAS = 12;

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

/** 取前几句（中英文句号），再按字数封顶。 */
function firstSentences(raw: unknown, maxChars = MAX_HEAD_SNIPPET): string {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  let cut = s.length;
  let breaks = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "。" || ch === "！" || ch === "？" || ch === "." || ch === "!" || ch === "?") {
      breaks += 1;
      if (breaks >= 2) {
        cut = i + 1;
        break;
      }
    }
  }
  const head = s.slice(0, Math.min(cut, maxChars)).trim();
  if (head.length >= s.length) return head;
  if (head.length >= maxChars) return `${head}[+${s.length - head.length}]`;
  return head.length < s.length ? `${head}[+${s.length - head.length}]` : head;
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
  const kind = String(row.kind || "");
  const toolName = String(row.toolName || row.name || "").trim();
  if (kind === "toolCall") {
    const status = typeof row.status === "string" ? row.status : "";
    const bits = [toolName || "（未命名工具）"];
    if (status) bits.push(status);
    if (typeof row.inputText === "string" && row.inputText.trim()) {
      bits.push(firstSentences(row.inputText, 80));
    }
    return bits.join(" · ");
  }
  if (typeof row.text === "string" && row.text.trim()) {
    return firstSentences(row.text);
  }
  if (typeof row.inputText === "string" && row.inputText.trim()) {
    return firstSentences(row.inputText);
  }
  const output = row.output;
  if (output && typeof output === "object") {
    const text = (output as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      return firstSentences(text);
    }
  }
  if (typeof row.status === "string" && row.status) return row.status;
  if (typeof row.state === "string" && row.state) return row.state;
  return "";
}

function kindLabelFromMeta(
  kind: string,
  toolName?: string,
): string {
  // 工具名放到 summary，标签只写「工具」方便扫
  if (kind === "toolCall") return "工具";
  return labelForRowKind(kind, toolName);
}

/** 单条 V4 delta → 类型 + 摘要（供浮层分行 / JSON sample）。 */
export function summarizeV4Delta(delta: unknown): {
  line: string;
  kindLabel: string;
  summary: string;
  sample: Record<string, unknown>;
} {
  if (!delta || typeof delta !== "object") {
    const raw = clipText(delta, 80);
    return { line: raw, kindLabel: "其它", summary: raw, sample: { raw } };
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
    const kindLabel =
      meta?.kind === "toolCall"
        ? "工具"
        : label.startsWith("工具")
          ? "工具"
          : label.startsWith("思考")
            ? "思考"
            : label.startsWith("正文")
              ? "正文"
              : label.startsWith("用户")
                ? "用户"
                : label;
    const snip = firstSentences(append);
    const summaryBits = [
      Number.isFinite(rowId) ? `row#${rowId}` : null,
      meta?.toolName || null,
      append ? `Δ${append.length}` : null,
      snip || null,
    ].filter(Boolean);
    const summary = summaryBits.join(" · ");
    const line = `#${Number.isFinite(rowId) ? rowId : "?"} ${label} Δ${append.length}${
      snip ? ` ${snip}` : ""
    }`;
    return {
      line,
      kindLabel,
      summary,
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
    const kindLabel = kindLabelFromMeta(kind, toolName || undefined);
    const snip = row ? rowBodySnippet(row) : "";
    const mark = op === "row.appended" ? "+" : "~";
    const status =
      row && typeof row.status === "string" ? row.status : "";
    const legacyLabel = labelForRowKind(kind, toolName || undefined);
    const line = `${mark}#${rowId ?? "?"} ${legacyLabel}${
      status && kind === "toolCall" ? `[${status}]` : ""
    }${snip ? ` ${snip}` : ""}`;
    const summary =
      kind === "toolCall"
        ? snip
        : [rowId != null ? `row#${rowId}` : null, snip || null]
            .filter(Boolean)
            .join(" · ");
    return {
      line,
      kindLabel,
      summary: summary || legacyLabel,
      sample: {
        op,
        rowId,
        kind: kind || null,
        toolName: toolName || null,
        label: legacyLabel,
        status: status || null,
        text: snip || undefined,
      },
    };
  }

  if (op === "row.removed") {
    const from = o.fromRowId;
    const summary = `removed ≥#${from ?? "?"}`;
    return {
      line: summary,
      kindLabel: "移除",
      summary,
      sample: { op, fromRowId: from ?? null },
    };
  }

  if (op === "state.updated") {
    return {
      line: "state.updated",
      kindLabel: "状态",
      summary: "state.updated",
      sample: { op },
    };
  }

  if (op.startsWith("workflowRun.")) {
    const summary = `${op}${o.runId ? ` ${String(o.runId).slice(0, 10)}` : ""}`;
    return {
      line: summary,
      kindLabel: "工作流",
      summary,
      sample: { op, runId: o.runId ?? null },
    };
  }

  const line = clipText(op, 80);
  return {
    line,
    kindLabel: "其它",
    summary: line,
    sample: {
      op,
      rowId: o.rowId ?? null,
      turnId:
        typeof o.turnId === "string" ? String(o.turnId).slice(0, 12) : null,
    },
  };
}

function pushEntry(
  entry: Omit<ViewportStreamTapEntry, "id" | "atMs" | "sessionId" | "headline"> & {
    sessionId?: string;
    headline?: string;
  },
): void {
  const kindLabel = String(entry.kindLabel || "").trim() || "其它";
  const summary = String(entry.summary || "").trim();
  const headline =
    String(entry.headline || "").trim() ||
    [kindLabel, summary].filter(Boolean).join(" · ");
  const full: ViewportStreamTapEntry = {
    ...entry,
    kindLabel,
    summary,
    headline,
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
      kindLabel: full.kindLabel,
      summary: full.summary,
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

  const kindLabel = typeLabel || type || "其它";
  const toolName =
    (typeof data.toolCallName === "string" && data.toolCallName) ||
    (typeof data.name === "string" && data.name) ||
    "";
  let summary = "";
  if (kindLabel === "工具" || toolName) {
    const bits = [toolName || null];
    if (typeof data.delta === "string" && data.delta) {
      bits.push(`Δ${data.delta.length}`, firstSentences(data.delta, 80));
    } else if (typeof data.content === "string" && data.content) {
      bits.push(firstSentences(data.content, 80));
    }
    summary = bits.filter(Boolean).join(" · ");
  } else if (typeof data.delta === "string" && data.delta) {
    summary = `Δ${data.delta.length} · ${firstSentences(data.delta)}`;
  } else if (typeof data.content === "string" && data.content) {
    summary = firstSentences(data.content);
  } else if (typeof data.status === "string" && data.status) {
    summary = data.status;
  } else {
    summary = type;
  }

  const threadId =
    typeof data.threadId === "string" ? String(data.threadId).trim() : "";
  pushEntry({
    channel,
    sessionKey,
    sessionId: threadId,
    runId,
    type,
    kindLabel,
    summary,
    headline: [kindLabel, summary].filter(Boolean).join(" · "),
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
  const sessionId = sessionIdFromV4Topic(topic);
  const seqBit =
    fromSeq != null || toSeq != null
      ? `seq=${fromSeq ?? "?"}→${toSeq ?? "?"}`
      : "";

  const frameMeta: Record<string, unknown> = {
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

  // 有 deltas：一条 delta 落一条环，序号/时间/类型/摘要分开看，不挤成一坨
  const shown = deltaSummaries.slice(0, MAX_HEAD_DELTAS);
  if (shown.length > 0) {
    for (const ds of shown) {
      pushEntry({
        channel: "v4",
        sessionKey: "",
        sessionId,
        runId: "",
        type: kind,
        kindLabel: ds.kindLabel,
        summary: [seqBit || null, ds.summary].filter(Boolean).join(" · "),
        headline: ds.line,
        jsonText: safeJson({
          ...frameMeta,
          delta: ds.sample,
          deltaSample: deltaSummaries.slice(0, 4).map((s) => s.sample),
        }),
      });
    }
    if (deltaCount > MAX_HEAD_DELTAS) {
      pushEntry({
        channel: "v4",
        sessionKey: "",
        sessionId,
        runId: "",
        type: kind,
        kindLabel: "其它",
        summary: `本帧还有 ${deltaCount - MAX_HEAD_DELTAS} 条 delta 未展开`,
        headline: `v4 · ${kind} · [+${deltaCount - MAX_HEAD_DELTAS}]`,
        jsonText: safeJson(frameMeta),
      });
    }
    return;
  }

  const summary = windowRows
    ? `rows=${windowRows}${seqBit ? ` · ${seqBit}` : ""}`
    : seqBit || kind;
  pushEntry({
    channel: "v4",
    sessionKey: "",
    sessionId,
    runId: "",
    type: kind,
    kindLabel: kind === "snapshot" ? "快照" : "帧",
    summary,
    headline: ["v4", kind, seqBit, summary].filter(Boolean).join(" · "),
    jsonText: safeJson(frameMeta),
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

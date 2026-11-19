/**
 * 视口调试浮层：把 stream / api / scroll / timing 抽头落到会话目录，
 * 避免内存环被挤掉后「数据抖动消失」。
 *
 * 桌面端：`~/.evoflow/logs/stream-compare/{sessionId}/overlay/viewport-*.log`
 * 浏览器：localStorage 环（同会话最近 N 条），浮层启动时可回灌。
 */

export type ViewportTapPersistKind =
  | "stream"
  | "api"
  | "scroll"
  | "timing";

const LS_PREFIX = "EVOFLOW_V4_VIEWPORT_TAP:";
const LS_MAX_PER_KIND = 120;
const MAX_LINE_CHARS = 48_000;

type PersistLine = {
  atMs: number;
  kind: ViewportTapPersistKind;
  payload: unknown;
};

function sanitizeSessionId(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 96);
}

function lsKey(sessionId: string, kind: ViewportTapPersistKind): string {
  return `${LS_PREFIX}${sessionId}:${kind}`;
}

function hasTauriInvoke(): boolean {
  try {
    return Boolean(
      (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
    );
  } catch {
    return false;
  }
}

function channelFor(kind: ViewportTapPersistKind): string {
  switch (kind) {
    case "stream":
      return "viewport-stream";
    case "api":
      return "viewport-api";
    case "scroll":
      return "viewport-scroll";
    case "timing":
      return "viewport-timing";
  }
}

function appendLocalStorage(
  sessionId: string,
  kind: ViewportTapPersistKind,
  line: PersistLine,
): void {
  try {
    const key = lsKey(sessionId, kind);
    const prevRaw = localStorage.getItem(key);
    const prev: PersistLine[] = prevRaw ? (JSON.parse(prevRaw) as PersistLine[]) : [];
    const next = Array.isArray(prev) ? prev.slice(-(LS_MAX_PER_KIND - 1)) : [];
    next.push(line);
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
}

function appendTauri(
  sessionId: string,
  kind: ViewportTapPersistKind,
  message: string,
): void {
  if (!hasTauriInvoke()) return;
  try {
    void import("@tauri-apps/api/core").then((m) =>
      m.invoke("append_stream_compare_log", {
        channel: channelFor(kind),
        sessionKey: sessionId,
        runId: "overlay",
        message: message.slice(0, MAX_LINE_CHARS),
      }),
    );
  } catch {
    /* best-effort */
  }
}

/** 同步写内存侧 LS + 异步写桌面会话目录。sessionId 空则跳过。 */
export function persistViewportTap(
  sessionId: string | null | undefined,
  kind: ViewportTapPersistKind,
  payload: unknown,
): void {
  const sid = sanitizeSessionId(String(sessionId || ""));
  if (!sid) return;
  const atMs = Date.now();
  const line: PersistLine = { atMs, kind, payload };
  appendLocalStorage(sid, kind, line);
  let text = "";
  try {
    text = JSON.stringify(payload);
  } catch {
    text = String(payload);
  }
  if (!text) return;
  appendTauri(sid, kind, text);
}

/** 从 localStorage 回灌（桌面文件不回读，避免启动 IO）。 */
export function loadPersistedViewportTaps<T = unknown>(
  sessionId: string | null | undefined,
  kind: ViewportTapPersistKind,
  limit = LS_MAX_PER_KIND,
): T[] {
  const sid = sanitizeSessionId(String(sessionId || ""));
  if (!sid) return [];
  try {
    const raw = localStorage.getItem(lsKey(sid, kind));
    if (!raw) return [];
    const arr = JSON.parse(raw) as PersistLine[];
    if (!Array.isArray(arr)) return [];
    return arr
      .slice(-Math.max(1, limit))
      .map((row) => row?.payload as T)
      .filter((p) => p != null);
  } catch {
    return [];
  }
}

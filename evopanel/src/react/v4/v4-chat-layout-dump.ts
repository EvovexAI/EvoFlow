/**
 * KeepAlive 多 host / 虚拟列表叠字诊断：把 DOM 排版快照打到 frontend 日志。
 *
 * 落点：
 * 1. `~/.evoflow/logs/frontend-YYYY-MM-DD.log` 过滤 `[v4-layout]`
 * 2. DevTools：`window.__evoflowDumpChatLayout()` / `window.__evoflowChatLayout`
 * 3. 主窗 CDP（与 embed 共用 `~/.evoflow/browser-cdp-http-port`）：
 *    ```
 *    $p = Get-Content $env:USERPROFILE\.evoflow\browser-cdp-http-port
 *    Invoke-RestMethod "http://127.0.0.1:$p/main-cdp/layout"
 *    ```
 *    返回里每个 host 带 sessionKey / title / 是否当前选中，能对上「哪一个对话」坏了。
 */
import { logV4Life } from "../lib/v4-lifecycle-log.js";

export type V4ChatHostIdentity = {
  threadId: string;
  sessionKey?: string;
  title?: string;
};

export type V4ChatLayoutDump = {
  at: string;
  /** 当前侧栏选中的 sessionKey（window.__evoflowSelectedSessionKey） */
  selectedSessionKey: string | null;
  /** 当前 focused host 的 threadId */
  activeThreadId: string | null;
  /** 当前 focused host 标题（侧栏或 index） */
  activeTitle: string | null;
  hostCount: number;
  split: string | null;
  hosts: Array<{
    tid: string;
    sessionKey: string | null;
    title: string | null;
    /** 是否等于当前选中会话 */
    isSelected: boolean;
    visibleAttr: string | null;
    focusedAttr: string | null;
    display: string;
    visibility: string;
    rect: { top: number; left: number; width: number; height: number };
    turnCount: number;
    uniqueTops: number;
    stacked: boolean;
    /** 相邻 turn top 差中位数；≈72 多为估高卡住 */
    medianGap: number | null;
    estimateStuck: boolean;
    sampleTops: number[];
  }>;
  stackedHostCount: number;
  problemHosts: Array<{
    tid: string;
    title: string | null;
    sessionKey: string | null;
    reasons: string[];
  }>;
  composer: {
    stable: boolean;
    top: number;
    height: number;
    /** 相对可见 host 顶部，过大说明飘在会话区上半 */
    offsetFromHostTop: number | null;
    drifted: boolean;
  } | null;
};

function roundRect(el: Element) {
  const r = el.getBoundingClientRect();
  return {
    top: Math.round(r.top),
    left: Math.round(r.left),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

function clipTitle(raw: string, max = 24): string {
  const t = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function cssEscapeAttr(raw: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(raw);
  }
  return raw.replace(/["\\]/g, "\\$&");
}

/** 侧栏 DOM：data-shell-session → 标题文本 */
function titleFromSidebar(sessionKey: string): string | null {
  if (!sessionKey || typeof document === "undefined") return null;
  const row = document.querySelector(
    `[data-shell-session="${cssEscapeAttr(sessionKey)}"]`,
  );
  if (!row) return null;
  const titleEl =
    row.querySelector(".react-chat-history-item-title") ||
    row.querySelector("[data-shell-session-title]");
  const text = clipTitle(titleEl?.textContent || row.getAttribute("title") || "");
  return text || null;
}

function resolveHostIdentity(
  tid: string,
  sessionKeyAttr: string | null,
): { sessionKey: string | null; title: string | null } {
  const w = window as Window & {
    __evoflowChatHostIndex?: Record<string, V4ChatHostIdentity>;
  };
  const fromIndex = w.__evoflowChatHostIndex?.[tid];
  const sessionKey =
    String(sessionKeyAttr || fromIndex?.sessionKey || "").trim() || null;
  let title = clipTitle(fromIndex?.title || "") || null;
  if (!title && sessionKey) title = titleFromSidebar(sessionKey);
  return { sessionKey, title };
}

/** 采集当前 chat host 栈 + 各 host 身份（哪一个对话）+ turn Y 分布。 */
export function collectV4ChatLayoutDump(): V4ChatLayoutDump | null {
  if (typeof document === "undefined") return null;
  const stack = document.querySelector("[data-v4-chat-host-stack]");
  if (!stack) return null;
  const selectedSessionKey =
    String(
      (window as Window & { __evoflowSelectedSessionKey?: string })
        .__evoflowSelectedSessionKey || "",
    ).trim() || null;
  const hosts = Array.from(stack.querySelectorAll("[data-v4-chat-host]"));
  const hostRows = hosts.map((host) => {
    const tid = String(host.getAttribute("data-v4-chat-host") || "");
    const { sessionKey, title } = resolveHostIdentity(
      tid,
      host.getAttribute("data-v4-chat-host-session-key"),
    );
    const style = window.getComputedStyle(host);
    const turns = Array.from(host.querySelectorAll("[data-v4-turn-unit]"));
    const tops = turns
      .map((t) => Math.round(t.getBoundingClientRect().top))
      .filter((y) => Number.isFinite(y))
      .sort((a, b) => a - b);
    const uniqueTops = new Set(tops).size;
    const stacked =
      tops.length >= 3 && uniqueTops <= Math.max(1, Math.floor(tops.length / 3));
    const gaps: number[] = [];
    for (let i = 1; i < tops.length; i++) gaps.push(tops[i]! - tops[i - 1]!);
    gaps.sort((a, b) => a - b);
    const medianGap =
      gaps.length === 0 ? null : gaps[Math.floor(gaps.length / 2)]!;
    // DEFAULT_ROW_HEIGHT_ESTIMATE_PX=72；中位间距落在 60–84 视为估高未重测。
    const estimateStuck =
      medianGap != null && medianGap >= 60 && medianGap <= 84 && tops.length >= 3;
    const isSelected = !!(
      selectedSessionKey &&
      sessionKey &&
      selectedSessionKey === sessionKey
    );
    return {
      tid,
      sessionKey,
      title,
      isSelected,
      visibleAttr: host.getAttribute("data-v4-chat-host-visible"),
      focusedAttr: host.getAttribute("data-v4-chat-host-focused"),
      display: style.display,
      visibility: style.visibility,
      rect: roundRect(host),
      turnCount: turns.length,
      uniqueTops,
      stacked,
      medianGap,
      estimateStuck,
      sampleTops: tops.slice(0, 12),
    };
  });
  const visibleHost = hostRows.find((h) => h.visibleAttr === "1");
  const focusedHost = hostRows.find((h) => h.focusedAttr === "1") || visibleHost;
  const composerEl =
    document.querySelector(
      '[data-v4-evoflow-composer-host-stable="true"]',
    ) || document.querySelector("[data-v4-evoflow-composer-host]");
  let composer: V4ChatLayoutDump["composer"] = null;
  if (composerEl) {
    const cr = composerEl.getBoundingClientRect();
    const offsetFromHostTop =
      visibleHost != null ? Math.round(cr.top - visibleHost.rect.top) : null;
    const drifted =
      offsetFromHostTop != null &&
      visibleHost != null &&
      visibleHost.rect.height > 200 &&
      offsetFromHostTop < visibleHost.rect.height * 0.35;
    composer = {
      stable: composerEl.getAttribute("data-v4-evoflow-composer-host-stable") === "true",
      top: Math.round(cr.top),
      height: Math.round(cr.height),
      offsetFromHostTop,
      drifted,
    };
  }
  const problemHosts = hostRows
    .filter(
      (h) =>
        h.stacked ||
        h.estimateStuck ||
        (h.visibleAttr === "1" && composer?.drifted),
    )
    .map((h) => {
      const reasons: string[] = [];
      if (h.stacked) reasons.push("STACK");
      if (h.estimateStuck) reasons.push("EST72");
      if (h.visibleAttr === "1" && composer?.drifted) reasons.push("COMPOSER_DRIFT");
      return {
        tid: h.tid,
        title: h.title,
        sessionKey: h.sessionKey,
        reasons,
      };
    });
  return {
    at: new Date().toISOString(),
    selectedSessionKey,
    activeThreadId: focusedHost?.tid || null,
    activeTitle: focusedHost?.title || null,
    hostCount: hosts.length,
    split: stack.getAttribute("data-v4-split"),
    hosts: hostRows,
    stackedHostCount: hostRows.filter((h) => h.stacked).length,
    problemHosts,
    composer,
  };
}

export function dumpV4ChatLayout(reason: string): V4ChatLayoutDump | null {
  const dump = collectV4ChatLayoutDump();
  if (!dump) return null;
  try {
    const w = window as Window & { __evoflowChatLayout?: V4ChatLayoutDump };
    w.__evoflowChatLayout = dump;
  } catch {
    /* ignore */
  }
  const visibleHosts = dump.hosts.filter((h) => h.visibleAttr === "1");
  const estimateStuck = dump.hosts.some(
    (h) => h.visibleAttr === "1" && h.estimateStuck,
  );
  const drifted = !!dump.composer?.drifted;
  const activeLabel = dump.activeTitle
    ? `「${dump.activeTitle}」`
    : dump.activeThreadId
      ? dump.activeThreadId.slice(0, 8)
      : "∅";
  const problemZh =
    dump.problemHosts.length > 0
      ? ` problems=[${dump.problemHosts
          .map(
            (p) =>
              `${p.title ? `「${p.title}」` : p.tid.slice(0, 8)}:${p.reasons.join("+")}`,
          )
          .join("; ")}]`
      : "";
  const zh = `[v4-layout] ${reason} 当前=${activeLabel} sk=${dump.selectedSessionKey || "∅"} hosts=${dump.hostCount} split=${dump.split} visible=${visibleHosts.length} stacked=${dump.stackedHostCount}${estimateStuck ? " !EST72" : ""}${drifted ? " !COMPOSER_DRIFT" : ""}${problemZh} composer=${dump.composer ? `stable=${dump.composer.stable ? 1 : 0} top=${dump.composer.top} off=${dump.composer.offsetFromHostTop}` : "∅"} :: ${dump.hosts
    .map((h) => {
      const name = h.title ? `「${h.title}」` : h.tid.slice(0, 8);
      return `${name}${h.isSelected ? "*" : ""} v=${h.visibleAttr}/f=${h.focusedAttr} disp=${h.display} vis=${h.visibility} turns=${h.turnCount} tops=${h.uniqueTops} gap=${h.medianGap ?? "∅"}${h.stacked ? "!STACK" : ""}${h.estimateStuck ? "!EST72" : ""}`;
    })
    .join(" | ")}`;
  logV4Life({
    event: "layout_dump",
    level:
      dump.stackedHostCount > 0 ||
      estimateStuck ||
      drifted ||
      dump.problemHosts.length > 0
        ? "warn"
        : "info",
    zh,
    sessionKey: dump.selectedSessionKey,
    threadId: dump.activeThreadId,
    detail: dump as unknown as Record<string, unknown>,
    skipDedupe: true,
  });
  return dump;
}

/** 供 controller 同步：threadId → sessionKey/title，dump 时能对上「哪一个对话」。 */
export function publishV4ChatHostIndex(
  entries: readonly V4ChatHostIdentity[],
): void {
  if (typeof window === "undefined") return;
  const map: Record<string, V4ChatHostIdentity> = {};
  for (const e of entries) {
    const tid = String(e.threadId || "").trim();
    if (!tid) continue;
    map[tid] = {
      threadId: tid,
      sessionKey: String(e.sessionKey || "").trim() || undefined,
      title: clipTitle(e.title || "") || undefined,
    };
  }
  (window as Window & { __evoflowChatHostIndex?: Record<string, V4ChatHostIdentity> }).__evoflowChatHostIndex =
    map;
}

export function installV4ChatLayoutDumpGlobal(): void {
  if (typeof window === "undefined") return;
  const w = window as Window & {
    __evoflowDumpChatLayout?: (reason?: string) => V4ChatLayoutDump | null;
  };
  w.__evoflowDumpChatLayout = (reason) => dumpV4ChatLayout(reason || "manual");
}

/**
 * 子代理输出面板（右栏）——对话体对齐主聊 V4（V4SessionPaneBridge → V4ZCodeTimeline）。
 *
 * 1. 后端为 chat 子代理分配独立 `{lead}__sub__{toolCallId}` executor thread
 *    （与协作子任务同形）；transcript 返回该 child thread_id 后挂 V4 桥。
 * 2. 桥接前 / 无 child thread 时：用 liveOutput + transcript messages 作过渡兜底
 *    （勿把父线程当 sessionId 桥接，否则会串主对话）。
 * 3. 轮询 transcript 仅作 catch-up（live 已走主 SSE）；页签隐藏时跳过。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchSubagentTaskTranscript } from "../../../lib/fetch-subagent-transcript.js";
import { V4SessionPaneBridge } from "../../v4/V4SessionPaneBridge.js";

// Was 2s — under a live run this hammered Gateway (~1–2s each) and made Task
// Center / sessions wait 8–11s (slow log 2026-10-31). Live output already comes
// via main stream; transcript poll is catch-up only.
const POLL_INTERVAL_MS = 5000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "error", "cancelled", "timed_out", "success"]);

export interface SubagentLiveTaskLike {
  phase?: string;
  liveOutput?: string;
  progressHint?: string;
  error?: string;
  tools?: unknown[];
}

/** 从 transcript message 的 content 字段提取可展示文本（string | 多段 parts）。 */
function messageText(msg: Record<string, unknown>): string {
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      const text = typeof p.text === "string" ? p.text : "";
      if (text) parts.push(text);
    }
    return parts.join("\n");
  }
  return "";
}

function messageRole(msg: Record<string, unknown>): "assistant" | "user" | "tool" {
  const type = String(msg?.type || msg?.role || "").toLowerCase();
  if (type.includes("tool") || type === "tool") return "tool";
  if (type === "human" || type === "user") return "user";
  return "assistant";
}

const ROLE_LABEL: Record<"assistant" | "user" | "tool", string> = {
  assistant: "子代理",
  user: "任务",
  tool: "工具",
};

export function V4SubagentTranscriptPane(props: {
  taskId: string;
  title?: string;
  sessionKey?: string;
  /** 解析出 thread 前的文案兜底（不画成假对话行） */
  fallbackText?: string;
  fallbackStatus?: string;
  /** 主会话线程 id：transcript 返回的 thread_id 与之相同时不是子线程，禁用桥接 */
  parentThreadId?: string;
  /** threadPanelState.subagentTasks 中解析出的实时任务态（运行中的流式正文） */
  liveTask?: SubagentLiveTaskLike;
  onClose?: () => void;
}): React.JSX.Element {
  const { taskId, title, sessionKey, fallbackText, fallbackStatus, parentThreadId, liveTask, onClose } = props;

  const [status, setStatus] = useState<string>(fallbackStatus || "");
  const [childThreadId, setChildThreadId] = useState("");
  const [messages, setMessages] = useState<Array<Record<string, unknown>>>([]);
  const [resultText, setResultText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  const fetchOnce = useCallback(async () => {
    try {
      const data = await fetchSubagentTaskTranscript(taskId);
      const nextStatus = String(data?.status || fallbackStatus || "");
      setStatus(nextStatus);
      const tid = String(data?.thread_id || "").trim();
      // Child executor thread（{lead}__sub__*）才桥接 V4；等于父线程则仍是旧路径，勿桥接。
      const isChildThread = !!tid && (!parentThreadId || tid !== parentThreadId);
      setChildThreadId(isChildThread ? tid : "");
      const nextMessages = Array.isArray(data?.messages) ? (data.messages as Array<Record<string, unknown>>) : [];
      setMessages(nextMessages);
      const body = String(data?.result || "").trim();
      setResultText(body);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [taskId, fallbackStatus, parentThreadId]);

  const livePhase = String(liveTask?.phase || "").toLowerCase();
  const terminal =
    TERMINAL_STATUSES.has(status.toLowerCase()) || TERMINAL_STATUSES.has(livePhase);

  useEffect(() => {
    let disposed = false;
    void fetchOnce();
    pollRef.current = setInterval(() => {
      if (disposed) return;
      if (typeof document !== "undefined" && document.hidden) return;
      if (terminal && loaded && (childThreadId || messages.length > 0 || resultText)) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        return;
      }
      void fetchOnce();
    }, POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [fetchOnce, terminal, loaded, childThreadId, messages.length, resultText]);

  const running = !terminal;

  // 自动跟读：历史/实时流增长时，若用户停在底部附近则贴底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, liveTask?.liveOutput, resultText]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const liveOutput = String(liveTask?.liveOutput || "").trim();
  const renderedMessages = useMemo(
    () =>
      messages
        .map((m, i) => ({ key: `${i}`, role: messageRole(m), text: messageText(m) }))
        .filter((m) => m.text.trim()),
    [messages],
  );

  const headerStatus = running ? "执行中" : status || "已完成";

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
          {title || "子代理"}
        </span>
        <span
          className={
            "rounded px-1.5 py-0.5 text-[11px] " +
            (running
              ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
              : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400")
          }
        >
          {headerStatus}
        </span>
        {running && !childThreadId ? (
          <span className="text-[11px] text-foreground-subtlest">实时流</span>
        ) : null}
        <div className="flex-1" />
        {onClose ? (
          <button
            type="button"
            className="rounded p-1 text-foreground-subtlest hover:bg-hover"
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {childThreadId ? (
          <V4SessionPaneBridge
            sessionId={childThreadId}
            connecting={!loaded}
            sessionKey={sessionKey || undefined}
          />
        ) : (
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="h-full min-h-0 overflow-y-auto px-4 py-3"
          >
            {!loaded && !liveOutput ? (
              <div className="flex h-full items-center justify-center text-ui-sm text-foreground-subtlest">
                正在拉取子代理输出…
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {renderedMessages.map((m) => (
                  <div key={m.key} className="flex flex-col gap-1">
                    <span
                      className={
                        "text-[11px] font-medium uppercase tracking-wide " +
                        (m.role === "assistant"
                          ? "text-blue-600 dark:text-blue-400"
                          : m.role === "user"
                            ? "text-foreground-subtle"
                            : "text-foreground-subtlest")
                      }
                    >
                      {ROLE_LABEL[m.role]}
                    </span>
                    <pre className="max-w-full whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 px-3 py-2 text-ui-sm text-foreground">
                      {m.text}
                    </pre>
                  </div>
                ))}
                {liveOutput ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-blue-600 dark:text-blue-400">
                      {running ? "实时输出" : "输出"}
                    </span>
                    <pre className="max-w-full whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 px-3 py-2 text-ui-sm text-foreground">
                      {liveOutput}
                      {running ? <span className="ml-0.5 inline-block animate-pulse">▋</span> : null}
                    </pre>
                  </div>
                ) : null}
                {!liveOutput && !renderedMessages.length && resultText ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-blue-600 dark:text-blue-400">
                      结果
                    </span>
                    <pre className="max-w-full whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 px-3 py-2 text-ui-sm text-foreground">
                      {resultText}
                    </pre>
                  </div>
                ) : null}
                {!liveOutput && !renderedMessages.length && !resultText ? (
                  <div className="flex flex-col items-center gap-2 py-8 text-ui-sm text-foreground-subtlest">
                    <span>
                      {running ? "执行中，等待子代理输出…" : "暂无子代理输出"}
                    </span>
                    {fallbackText ? (
                      <pre className="max-h-48 w-full max-w-lg overflow-y-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-3 text-left text-foreground">
                        {fallbackText}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 子代理输出：对话体只走主聊同一套 V4（V4SessionPaneBridge）。
 * 旧 SubtaskModalMessageRow / memory-poll 行渲染已退役。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSubagentTaskTranscript } from "../../../lib/fetch-subagent-transcript.js";
import { V4SessionPaneBridge } from "../../v4/V4SessionPaneBridge.js";

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "error", "cancelled", "timed_out"]);

export function V4SubagentTranscriptPane(props: {
  taskId: string;
  title?: string;
  sessionKey?: string;
  /** 解析出 thread 前的文案兜底（不画成假对话行） */
  fallbackText?: string;
  fallbackStatus?: string;
  onClose?: () => void;
}): React.JSX.Element {
  const { taskId, title, sessionKey, fallbackText, fallbackStatus, onClose } = props;

  const [status, setStatus] = useState<string>(fallbackStatus || "");
  const [threadId, setThreadId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [asideNote, setAsideNote] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOnce = useCallback(async () => {
    try {
      const data = await fetchSubagentTaskTranscript(taskId);
      const nextStatus = String(data?.status || fallbackStatus || "");
      setStatus(nextStatus);
      const tid = String(data?.thread_id || "").trim();
      if (tid) {
        setThreadId(tid);
        setAsideNote("");
      } else {
        const body = String(fallbackText || data?.result || "").trim();
        if (body && !(Array.isArray(data?.messages) && data.messages.length > 0)) {
          setAsideNote(body);
        }
      }
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [taskId, fallbackStatus, fallbackText]);

  useEffect(() => {
    let disposed = false;
    void fetchOnce();
    pollRef.current = setInterval(() => {
      if (disposed) return;
      const terminal = TERMINAL_STATUSES.has(status.toLowerCase());
      if (terminal && loaded && threadId) {
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
  }, [fetchOnce, status, loaded, threadId]);

  const running = !TERMINAL_STATUSES.has(status.toLowerCase());

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
          {running ? "执行中" : status || "已完成"}
        </span>
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
        {threadId ? (
          <V4SessionPaneBridge
            sessionId={threadId}
            connecting={!loaded}
            sessionKey={sessionKey || undefined}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-ui-sm text-foreground-subtlest">
            <span>
              {!loaded
                ? "正在解析子代理会话…"
                : running
                  ? "执行中，等待会话 thread…"
                  : "暂无子代理会话 thread"}
            </span>
            {asideNote ? (
              <pre className="max-h-48 w-full max-w-lg overflow-y-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-3 text-left text-foreground">
                {asideNote}
              </pre>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

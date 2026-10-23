// V4SubagentTranscriptPane — 右侧面板的子代理流式输出查看器（对齐 ZCode"点开子代理看全量"）。
// 数据：轮询 GET /api/tasks/subagent/{task_id}/transcript（SubagentExecutor 内存快照），
// 空 transcript 时用流式 liveOutput 兜底；行渲染复用 SubtaskModalMessageRow。
import { useCallback, useEffect, useRef, useState } from "react";
import { SubtaskModalMessageRow } from "../../components/SubtaskModalMessageRow.js";
import { messagesToSubtaskModalRows } from "../../../lib/subtask-modal-rows.js";
import { fetchSubagentTaskTranscript } from "../../../lib/fetch-subagent-transcript.js";

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "error", "cancelled", "timed_out"]);

export function V4SubagentTranscriptPane(props: {
  taskId: string;
  title?: string;
  /** Lead chat session —— 嵌套工具详情懒加载 /tool-results 用。 */
  sessionKey?: string;
  /** transcript 拉不到时（跨进程/已清理）用流式 liveOutput 兜底。 */
  fallbackText?: string;
  fallbackStatus?: string;
  onClose?: () => void;
}): React.JSX.Element {
  const { taskId, title, sessionKey, fallbackText, fallbackStatus, onClose } = props;

  const [rows, setRows] = useState<unknown[]>([]);
  const [status, setStatus] = useState<string>(fallbackStatus || "");
  const [loaded, setLoaded] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastRowCountRef = useRef(0);

  const fetchOnce = useCallback(async () => {
    try {
      const data = await fetchSubagentTaskTranscript(taskId);
      const list = Array.isArray(data?.messages) ? data.messages : [];
      const status = String(data?.status || fallbackStatus || "");
      setStatus(status);
      if (list.length > 0) {
        setRows(messagesToSubtaskModalRows(list));
        setLoaded(true);
        return;
      }
      // 空 transcript：流式 liveOutput 兜底（跨进程/已清理时唯一数据源）
      const body = String(fallbackText || "").trim();
      if (body) {
        setRows(
          messagesToSubtaskModalRows([
            { type: "ai", role: "assistant", content: body },
          ]),
        );
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
      if (terminal && loaded) {
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
  }, [fetchOnce, status, loaded]);

  // 新行到达自动贴底（流式跟读）
  useEffect(() => {
    if (rows.length === lastRowCountRef.current) return;
    lastRowCountRef.current = rows.length;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows]);

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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {rows.length > 0 ? (
          <div className="flex flex-col gap-3">
            {rows.map((row, index) => (
              <SubtaskModalMessageRow
                key={index}
                row={row as Parameters<typeof SubtaskModalMessageRow>[0]["row"]}
                sessionKey={sessionKey}
                isStreaming={running && index === rows.length - 1}
              />
            ))}
          </div>
        ) : loaded ? (
          <div className="flex h-full items-center justify-center text-ui-sm text-foreground-subtlest">
            （暂无输出内容）
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-ui-sm text-foreground-subtlest">
            正在加载子代理输出…
          </div>
        )}
      </div>
    </div>
  );
}

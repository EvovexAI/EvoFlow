// ============================================================
// 命令输出的尾巴
// ============================================================
// 收起的 Terminal 卡下面露出 stdout 最后三行，不用点开就知道命令说了什么。正文在卡**滚进视口**时
// 才取（IntersectionObserver，提前 200 px），取回即进同一份缓存——之后展开不再读。没有
// IntersectionObserver 的环境（jsdom）视作立刻可见。

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowRunWorkspaceNode } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useWorkflowRunNodeResult } from "@/hooks/useWorkflowRunNodeResult.js";
import { peekLinesOf } from "@/app-shell/workflowWorkspaceLogbook.js";

export const WorkspacePeek = memo(function WorkspacePeek({
  node,
  runId,
  sessionId,
}: {
  node: WorkflowRunWorkspaceNode;
  runId: string;
  sessionId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (visible || ref.current === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);

  const { result } = useWorkflowRunNodeResult({
    sessionId,
    runId,
    siteId: node.siteId,
    ordinal: node.ordinal,
    enabled: visible && node.status === "completed",
  });
  const lines = useMemo(
    () => (result?.result === undefined ? [] : peekLinesOf(result.result)),
    [result],
  );

  // 空态是一个零高的哨兵：IntersectionObserver 要有东西可观察。
  return (
    <div
      className={cn(
        lines.length === 0
          ? "h-0 overflow-hidden"
          : "wf-ws-peek mt-1 overflow-hidden whitespace-pre rounded-[7px] bg-panel px-2.5 py-[7px] font-mono text-ui-sm leading-[17px] text-foreground-subtle",
      )}
      data-testid="workflow-workspace-peek"
      data-ws-body
      ref={ref}
    >
      {lines.map((line, index) => (
        <span className={cn("block", line.error && "text-destructive")} key={index}>
          {line.text}
        </span>
      ))}
    </div>
  );
});

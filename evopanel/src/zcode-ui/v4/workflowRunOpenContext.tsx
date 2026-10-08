// 侧栏运行行「点击 → 选中会话 + 打开 run pane」的入口。与 composer 徽标同一跳转，由 WorkspaceShellLayout 一处裁决；
// 用 context 而不是逐层 props：运行行长在五种任务行里（默认 / 时间线 / 置顶 / 归档 / 分组）。
// 没有 provider（手机远控首页、单测）时运行行只是文字，不是按钮。
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { SessionWorkflowRunSummary } from "@zcode/shared/zcode-protocol-v4";

export interface WorkflowRunOpenTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  run: SessionWorkflowRunSummary;
}

type WorkflowRunOpenHandler = (target: WorkflowRunOpenTarget) => void;

const WorkflowRunOpenContext = createContext<WorkflowRunOpenHandler | null>(null);

export function WorkflowRunOpenProvider({
  onOpenRun,
  children,
}: {
  onOpenRun: WorkflowRunOpenHandler;
  children: ReactNode;
}) {
  const handlerRef = useRef(onOpenRun);
  handlerRef.current = onOpenRun;
  const stable = useMemo<WorkflowRunOpenHandler>(() => (target) => handlerRef.current(target), []);
  return (
    <WorkflowRunOpenContext.Provider value={stable}>{children}</WorkflowRunOpenContext.Provider>
  );
}

export function useWorkflowRunOpen(): WorkflowRunOpenHandler | null {
  return useContext(WorkflowRunOpenContext);
}

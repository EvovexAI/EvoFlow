/**
 * EvoFlow 等宿主可注入自家 Agent 头像，替换默认瓦片脸（WorkflowAgentFace）。
 * 缺席时 LaneGlyph 仍画瓦片脸——ZCode 原生路径不变。
 */
import { createContext, useContext, type ReactNode } from "react";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";

export type WorkflowAgentFaceOverrideProps = {
  avatarIndex: number | undefined;
  className?: string;
  name: string;
  status: StepRunStatus | undefined;
  /** 车道 id；EvoFlow 投影里常是 assignedAgent code */
  laneId?: string;
};

export type WorkflowAgentFaceOverride = (
  props: WorkflowAgentFaceOverrideProps,
) => ReactNode;

export const WorkflowAgentFaceOverrideContext =
  createContext<WorkflowAgentFaceOverride | null>(null);

export function useWorkflowAgentFaceOverride(): WorkflowAgentFaceOverride | null {
  return useContext(WorkflowAgentFaceOverrideContext);
}

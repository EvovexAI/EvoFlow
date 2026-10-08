import { useMemo } from "react";
import type { ZCodeAgentWorkspaceTarget } from "@zcode/services";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import type { SavedWorkflowProjectTarget } from "@/settings/saved-workflows/savedWorkflowContract.js";
import type { SavedWorkflowLaunchTarget } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

interface SavedWorkflowProjectTargets {
  /** RPC target（含 remoteSessionId），供 store / 服务方法调用。 */
  target: ZCodeAgentWorkspaceTarget;
  /** 发往对话 / 打开实例的项目坐标：只有 workspacePath + identity（不带 remoteSessionId）。 */
  projectTarget: SavedWorkflowProjectTarget;
  /** 直接启动的连接坐标：额外带 remoteSessionId，决定 conversation 连接 endpoint 与导航目标。 */
  launchTarget: SavedWorkflowLaunchTarget;
}

/**
 * 一个项目组要用到的三套坐标（所有动作都带**本项目**的
 * target）。三者只在是否携带 remoteSessionId 上不同；引用在依赖不变时保持稳定，供 memo / effect 依赖。
 */
export function useSavedWorkflowProjectTargets(
  project: Pick<AutomationWorkspaceOption, "workspacePath" | "workspaceIdentity">,
  remoteSessionId: string | null,
): SavedWorkflowProjectTargets {
  const target = useMemo<ZCodeAgentWorkspaceTarget>(
    () => ({
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity?.trim()
        ? { workspaceIdentity: project.workspaceIdentity }
        : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [project.workspacePath, project.workspaceIdentity, remoteSessionId],
  );
  const projectTarget = useMemo<SavedWorkflowProjectTarget>(
    () => ({
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
    }),
    [project.workspacePath, project.workspaceIdentity],
  );
  const launchTarget = useMemo<SavedWorkflowLaunchTarget>(
    () => ({
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [project.workspacePath, project.workspaceIdentity, remoteSessionId],
  );
  return { target, projectTarget, launchTarget };
}

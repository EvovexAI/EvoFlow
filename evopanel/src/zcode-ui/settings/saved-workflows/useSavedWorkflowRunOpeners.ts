import { useCallback } from "react";
import type { ZCodeSavedWorkflowRun } from "@zcode/shared";
import type {
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

/** 一行运行记录归属的项目（项目档恒定，全局档按 `run.cwd` 反查）。 */
interface SavedWorkflowRunOpenTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 中枢运行历史行上两个「打开」的门与实参构造。
 *
 * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是脚本的顶层返回值。
 *
 * 抽成一个 hook 而不是在两个组里各写一遍：项目档与全局档唯一的差别是**目标项目怎么算**
 * （前者恒定，后者按 `run.cwd` 反查已打开项目），而两个门的判据必须一致——它们各写一遍时，
 * 「产物不需要 toolCallId」这条会很自然地在其中一处被写成「和查看实例一样」。
 *
 * ```
 *                       parentSessionId?   toolCallId?   项目可打开?
 * 「查看实例」              必需              必需            必需
 * 产物 chip                必需              —              必需
 * ```
 *
 * `toolCallId` 只服务于 run 详情页里那张静态因果图（它挂在那条 CreateWorkflow 工具行的
 * display 上）。产物 tab 不画图，所以老行缺 `toolCallId` 时产物仍然打得开。
 */
export function useSavedWorkflowRunOpeners(options: {
  /** 该行归属的项目；返回 null 即两个入口都关闭（全局档里 cwd 对应的项目没打开）。 */
  resolveTarget: (run: ZCodeSavedWorkflowRun) => SavedWorkflowRunOpenTarget | null;
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
}): {
  handleOpenRun: (run: ZCodeSavedWorkflowRun, workflowName: string) => void;
  handleOpenArtifact: (run: ZCodeSavedWorkflowRun, artifactId: string) => void;
} {
  const { onOpenWorkflowArtifact, onOpenWorkflowRun, resolveTarget } = options;

  const handleOpenRun = useCallback(
    (run: ZCodeSavedWorkflowRun, workflowName: string) => {
      if (!run.parentSessionId || !run.toolCallId) return;
      const target = resolveTarget(run);
      if (!target) return;
      onOpenWorkflowRun?.({
        sessionId: run.parentSessionId,
        runId: run.runId,
        toolCallId: run.toolCallId,
        workflowName,
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [onOpenWorkflowRun, resolveTarget],
  );

  const handleOpenArtifact = useCallback(
    (run: ZCodeSavedWorkflowRun, artifactId: string) => {
      if (!run.parentSessionId) return;
      const target = resolveTarget(run);
      if (!target) return;
      // 行上的 chip 载荷（`ZCodeSavedWorkflowRun.artifacts`）带最新版的 `contentType`：
      // 终点据它把 html 产物直接开成浏览器 tab。老行整个 `artifacts` 缺席，少一个键是退化不是错误。
      const artifact = run.artifacts?.find((candidate) => candidate.id === artifactId);
      onOpenWorkflowArtifact?.({
        sessionId: run.parentSessionId,
        runId: run.runId,
        artifactId,
        ...(artifact?.title === undefined ? {} : { title: artifact.title }),
        ...(artifact?.contentType === undefined ? {} : { contentType: artifact.contentType }),
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [onOpenWorkflowArtifact, resolveTarget],
  );

  return { handleOpenArtifact, handleOpenRun };
}

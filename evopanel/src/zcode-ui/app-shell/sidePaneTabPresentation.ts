import { getSidePaneTabTitle } from "@/app-shell/SidePaneTabTrigger.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

export interface SidePaneTabPresentationLabels {
  browserTitle: string;
  reviewTitle: string;
  codeViewerTitle: string;
  treemappingTitle: string;
  whiteboardTitle: string;
  modelTrajectoryTitle: string;
  developerToolsTitle: string;
  terminalTitle: string;
  subagentTypeLabel: string;
  subagentDirectoryTitle: string;
  selectionChatTitle: string;
  planTitle: string;
  workflowRunTitle: string;
  workflowDirectoryTitle: string;
  workflowActorTitle: string;
  workflowScriptTitle: string;
  workflowArtifactTitle: string;
}

export function getSidePaneTabSearchHint(tab: WorkspaceSidePaneTab): string {
  if (tab.type === "plan-detail") {
    return `${tab.parentSessionId} ${tab.toolCallId} plan ExitPlanMode`;
  }
  if (tab.type === "workflow-run") {
    return `${tab.workflowName ?? ""} ${tab.runId} ${tab.toolCallId} ${tab.parentSessionId} workflow run CreateWorkflow AmendWorkflow`;
  }
  if (tab.type === "workflow-directory") {
    return `${tab.parentSessionId} workflow runs directory history ended`;
  }
  if (tab.type === "workflow-actor-session") {
    // 会话 id 也进搜索面：排查时手里往往只有它（日志与 journal 都记它）。
    return `${tab.actorName ?? ""} ${tab.siteId}@${tab.ordinal} ${tab.actorSessionId ?? ""} ${tab.runId} ${tab.parentSessionId} workflow subagent actor transcript`;
  }
  if (tab.type === "workflow-workspace") {
    return `${tab.workflowName ?? ""} ${tab.runId} ${tab.toolCallId} ${tab.parentSessionId} workflow script steps workspace transcript files git run`;
  }
  if (tab.type === "workflow-artifact") {
    // 产物 id 是脚本里写死的字面量，用户与排查者手里往往就是它。
    return `${tab.title ?? ""} ${tab.artifactId} ${tab.runId} ${tab.parentSessionId} workflow artifact deliverable`;
  }
  if (tab.type === "selection-side-chat") {
    return `${tab.parentSessionId} ${tab.childSessionId} ${tab.ordinal} selection side chat`;
  }
  if (tab.type === "subagent-session") {
    return `${tab.title ?? ""} ${tab.subagentType} ${tab.parentSessionId} ${tab.childSessionId}`;
  }
  if (tab.type === "subagent-directory") {
    return `${tab.rootSessionId} ${tab.parentSessionId} subagent directory`;
  }
  if (tab.type === "browser") return tab.initialUrl ?? "";
  if (tab.type === "browser-use") {
    return `${tab.title ?? ""} ${tab.sessionId} browser use`;
  }
  if (tab.type === "git") return "git diff";
  if (tab.type === "treemapping") return "file activity diff map treemapping";
  if (tab.type === "whiteboard") return `${tab.title} whiteboard canvas draw sketch`;
  if (tab.type === "model-trajectory") {
    return `${tab.title ?? ""} ${tab.taskId} model trajectory call io`;
  }
  if (tab.type === "developer-tools") {
    return "developer tools token debug network status request response headers";
  }
  if (tab.type === "terminal" || tab.type === "bash-output")
    return `${tab.title} terminal shell command`;
  return tab.source.path ?? tab.source.title;
}

export function getLocalizedSidePaneTabTitle(
  tab: WorkspaceSidePaneTab,
  labels: SidePaneTabPresentationLabels,
): string {
  return getSidePaneTabTitle(tab, (descriptor) => {
    const titleByMessageId: Record<string, string> = {
      "browser.title": labels.browserTitle,
      "sidePane.review": labels.reviewTitle,
      "codeViewer.title": labels.codeViewerTitle,
      "treemapping.title": labels.treemappingTitle,
      "whiteboard.title": labels.whiteboardTitle,
      "modelTrajectory.title": labels.modelTrajectoryTitle,
      "developerTools.title": labels.developerToolsTitle,
      "terminal.title": labels.terminalTitle,
      "sidePane.subagent": labels.subagentTypeLabel,
      "sidePane.subagentDirectory": labels.subagentDirectoryTitle,
      "sidePane.selectionChat": labels.selectionChatTitle,
      "planTool.panel.planTab": labels.planTitle,
      "sidePane.workflowRun": labels.workflowRunTitle,
      "sidePane.workflowActor": labels.workflowActorTitle,
      "sidePane.workflowScript": labels.workflowScriptTitle,
      "sidePane.workflowArtifact": labels.workflowArtifactTitle,
    };
    return titleByMessageId[descriptor.id] ?? descriptor.id;
  });
}

export function getSidePaneTabTypeLabel(
  tab: WorkspaceSidePaneTab,
  labels: SidePaneTabPresentationLabels,
): string {
  if (tab.type === "plan-detail") return labels.planTitle;
  if (tab.type === "workflow-run") return labels.workflowRunTitle;
  if (tab.type === "workflow-directory") return labels.workflowDirectoryTitle;
  if (tab.type === "workflow-actor-session") return labels.workflowActorTitle;
  if (tab.type === "workflow-workspace") return labels.workflowScriptTitle;
  if (tab.type === "workflow-artifact") return labels.workflowArtifactTitle;
  if (tab.type === "selection-side-chat") return labels.selectionChatTitle;
  if (tab.type === "subagent-session") {
    return tab.subagentType.trim() || labels.subagentTypeLabel;
  }
  if (tab.type === "subagent-directory") return labels.subagentDirectoryTitle;
  if (tab.type === "browser" || tab.type === "browser-use") return labels.browserTitle;
  if (tab.type === "git") return labels.reviewTitle;
  if (tab.type === "treemapping") return labels.treemappingTitle;
  if (tab.type === "whiteboard") return labels.whiteboardTitle;
  if (tab.type === "model-trajectory") return labels.modelTrajectoryTitle;
  if (tab.type === "developer-tools") return labels.developerToolsTitle;
  if (tab.type === "terminal" || tab.type === "bash-output") return labels.terminalTitle;
  return labels.codeViewerTitle;
}

// 已保存工作流中枢的跨组件类型契约。
// 单独成文件，避免页（Section）与项目组（Group）互相 import 造成的环。

/** 工作流所属项目的坐标：发往对话（运行 / 修订 / 创建）与打开实例都用它，绝不取活动项目。 */
export type SavedWorkflowProjectTarget = {
  workspacePath: string;
  workspaceIdentity?: string;
};

/** 运行历史「查看实例」：切到发起它的会话并打开实例详情页；页列出所有项目，故必带所属 workspace。 */
export interface SavedWorkflowsOpenRunParams {
  sessionId: string;
  runId: string;
  toolCallId: string;
  workflowName: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 中枢的产物 chip → `workflow-artifact` tab。
 *
 * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出。
 *
 * 比 {@link SavedWorkflowsOpenRunParams} **少一个 `toolCallId`**：产物 tab 不画因果图，
 * 也就不必回到那条 CreateWorkflow 工具行。门因此只是 `parentSessionId` 在场。
 */
export interface SavedWorkflowsOpenArtifactParams {
  sessionId: string;
  runId: string;
  artifactId: string;
  title?: string;
  /**
   * 最新版的 contentType（运行历史行的 chip 载荷带得到）。终点的 `handleOpenWorkflowArtifact`
   * 据它决定 html 产物直接开浏览器 tab 还是开产物 tab；缺席（老行不带产物清单）即开产物 tab。
   */
  contentType?: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 组把自己的加载态回报给页；页据此算总数（count）、空态与首屏 spinner。 */
export interface SavedWorkflowGroupState {
  loaded: boolean;
  empty: boolean;
  /** 本组的合法工作流条数（未加载前为 0）；页对已加载组求和得到标题旁的总数。 */
  count: number;
}

/** 组的两种模式：列表 / 单个工作流详情。项目组与全局组共用。 */
export type SavedWorkflowGroupMode = { kind: "list" } | { kind: "detail"; name: string };

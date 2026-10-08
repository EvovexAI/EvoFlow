import type { ZCodeSavedWorkflowMeta, ZCodeSavedWorkflowScope } from "@zcode/shared";
import type { ZCodeAgentWorkspaceTarget } from "./zcodeAgentPluginParams.js";

// 已保存工作流的 GUI 中枢：五个 workspace 级、无会话的方法。
// 与 Skill catalog 同一条路径（workspace agent client），不走独立插件管理进程——文件在
// workspace 里，远程 workspace 时就在远端 agent 进程里扫远端目录。
//
// 全局工作流：`scope: "global"` 时文件落在 agent 机器的
// `~/.zcode/workflows/`。调用方可以省略 workspace——此时 services 层自选**载体运行时**
// （活跃的本地 runtime → 管理面 workspace），协议处理器对全局档不读 workspace 的路径。
// 项目组内的动作仍带自己的 workspace（既是运行目标又是载体），因此下面用一个 union：
// 要么带 workspace（scope 可选，缺省 project），要么只给 `scope: "global"`（workspace 可省）。
export type ZCodeAgentSavedWorkflowTarget =
  | (ZCodeAgentWorkspaceTarget & { scope?: ZCodeSavedWorkflowScope })
  | ({ scope: "global" } & Partial<ZCodeAgentWorkspaceTarget>);

export type ZCodeAgentListSavedWorkflowsParams = ZCodeAgentSavedWorkflowTarget;

export type ZCodeAgentGetSavedWorkflowParams = ZCodeAgentSavedWorkflowTarget & {
  name: string;
};

export type ZCodeAgentUpdateSavedWorkflowMetaParams = ZCodeAgentSavedWorkflowTarget & {
  name: string;
  meta: ZCodeSavedWorkflowMeta;
};

export type ZCodeAgentDeleteSavedWorkflowParams = ZCodeAgentSavedWorkflowTarget & {
  name: string;
};

export type ZCodeAgentListSavedWorkflowRunsParams = ZCodeAgentSavedWorkflowTarget & {
  /** 只要这个工作流名下的 run；缺省即（该 scope 下）全部。 */
  name?: string;
  /** [1, 50]；服务端钳制。 */
  limit: number;
};

// workflows/move：把全局档搬回项目档，
// **只此一向**。`workspace`
// 必填，既是载体也是「移到项目…」选中的目标项目；同机同用户，不覆盖已存在的目标。
export type ZCodeAgentMoveSavedWorkflowParams = ZCodeAgentWorkspaceTarget & {
  name: string;
};

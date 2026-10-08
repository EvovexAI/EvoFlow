import type {
  ZCodeProvider,
  AgentSummary,
  AgentsListResult,
  AgentCreateParams,
  AgentUpdateParams,
  AgentDeleteParams,
  BuiltInSubagentModelOverrideParams,
  PluginSubagentModelOverrideParams,
  SubagentsListMode,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISubagentsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    mode?: SubagentsListMode;
  }): Promise<AgentsListResult>;

  setEnabled(params: { agentId: string; enabled: boolean }): Promise<void>;

  setBuiltInModelOverride(params: BuiltInSubagentModelOverrideParams): Promise<void>;

  /** 只写用户 state 的完整覆盖，不改插件 Markdown。 */
  setPluginAgentModelOverride(params: PluginSubagentModelOverrideParams): Promise<void>;

  /** 当前筛选来源对应的用户级 agent 根目录（与内置扫描顺序一致，取 buildUserRoots 的首项）。 */
  getPrimaryUserAgentsDirectory(params: { provider: ZCodeProvider }): Promise<{ path: string }>;

  /** 创建新的 agent 文件 */
  createAgent(params: AgentCreateParams): Promise<{ agent: AgentSummary }>;

  /** 更新现有 agent 文件 */
  updateAgent(params: AgentUpdateParams): Promise<{ agent: AgentSummary }>;

  /** 删除 agent 文件 */
  deleteAgent(params: AgentDeleteParams): Promise<void>;
}

export const ISubagentsService = createServiceDescriptor<ISubagentsService>(
  ServiceChannels.Subagents,
);

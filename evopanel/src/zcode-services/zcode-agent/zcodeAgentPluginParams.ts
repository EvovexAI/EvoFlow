import type {
  ZCodeAgentMcpServer,
  ZCodeAutomationScheduleRule,
  ZCodeMcpListMode,
  ModelSelection,
} from "@zcode/shared";

export interface ZCodeAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远程 workspace 的运行时会话身份；只用于隔离/路由，不能替代 workspacePath。 */
  remoteSessionId?: string;
}

export interface ZCodeAgentPluginViewParams extends ZCodeAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

export interface ZCodeAgentListMcpServerStatusesParams extends ZCodeAgentWorkspaceTarget {
  mcpServers?: ZCodeAgentMcpServer[];
  mode?: ZCodeMcpListMode;
}

export interface ZCodeAgentAddPluginMarketplaceParams extends ZCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

export interface ZCodeAgentRemovePluginMarketplaceParams extends ZCodeAgentWorkspaceTarget {
  marketplace: string;
}

export interface ZCodeAgentUpdatePluginMarketplaceParams extends ZCodeAgentWorkspaceTarget {
  marketplace?: string;
  operationId?: string;
}

export interface ZCodeAgentInstallPluginParams extends ZCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface ZCodeAgentCancelPluginOperationParams {
  operationId: string;
}

export interface ZCodeAgentUninstallPluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface ZCodeAgentUpdatePluginParams extends ZCodeAgentWorkspaceTarget {
  pluginId?: string;
  marketplace?: string;
}

export interface ZCodeAgentRestoreBuiltinPluginParams extends ZCodeAgentWorkspaceTarget {
  pluginId: string;
}

export interface ZCodeAgentConfigurePluginParams extends ZCodeAgentWorkspaceTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ZCodeAgentResetPluginConfigParams extends ZCodeAgentWorkspaceTarget {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ZCodeAgentValidatePluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface ZCodeAgentDescribePluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace: string;
  pluginName: string;
}

export interface ZCodeAgentSetPluginEnabledParams extends ZCodeAgentWorkspaceTarget {
  enabled: boolean;
  operationId?: string;
  pluginId: string;
  scope?: "user" | "workspace";
}

// Plugin 对话引用 catalog：
// 带 sessionId → session-owned 冻结 catalog（必须路由到持有该 session 的 workspace client）；
// 不带 → workspace 当前 catalog（新建草稿 Picker）。
export interface ZCodeAgentPluginReferenceCatalogParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
}

// Composer Skill catalog：与 Plugin 引用相同，以 sessionId 区分 workspace 当前目录和
// resident Session runtime 快照；不参与 Settings 管理目录。
export interface ZCodeAgentSkillReferenceCatalogParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
}
export interface ZCodeAgentResolveSuggestedPluginReferenceParams extends ZCodeAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- 定时任务(automation)管理参数 ----

export interface ZCodeAgentCreateAutomationParams extends ZCodeAgentWorkspaceTarget {
  title: string;
  cronExpr: string;
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
}

export interface ZCodeAgentUpdateAutomationParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface ZCodeAgentAutomationIdParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
}

export interface ZCodeAgentSetAutomationEnabledParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
  enabled: boolean;
}

export interface ZCodeAgentDeleteAutomationRunParams extends ZCodeAgentWorkspaceTarget {
  runId: string;
}

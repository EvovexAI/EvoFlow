import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  ZCodeConfigOption,
  ZCodeProvider,
  BotConfig,
  BotContextState,
  BotInboundMessage,
  BotOutboundMessage,
  BotProvider,
  BotProviderCallbackResult,
  BotServiceStatus,
  BotWorkspaceRef,
  BotsConfigFile,
  ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import type { ZCodeAgentAppRuntimePreferences } from "../zcode-agent/zcodeAgent.js";

export interface BotCreateBindCodeParams {
  botId?: string;
  allowedWorkspaces?: string[];
  ttlMs?: number;
}

export interface BotSaveBotParams {
  bot: BotConfig;
  credentialValue?: string;
  webhookSecretValue?: string;
}

export interface BotTestResult {
  ok: boolean;
  message: string;
  name?: string;
  provider?: BotProvider;
}

export interface BotBindCodeResult {
  code: string;
  expiresAt: number;
}

export interface BotListWorkspaceRefsParams {
  currentWorkspace?: BotWorkspaceRef;
}

export interface BotUserConfigOptionsParams {
  workspacePath: string;
  workspaceIdentity?: string;
  provider: ZCodeProvider;
}

export interface BotAutomationRunWatchParams {
  target: ZCodeAutomationBotDeliveryTarget;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface BotWeixinRegistrationBeginResult {
  qrCode: string;
  qrUrl: string;
  interval: number;
  expiresAt: number;
}

export interface BotWeixinRegistrationPollParams {
  qrCode: string;
}

export type BotWeixinRegistrationPollResult =
  | {
      status: "pending" | "scanned";
      interval: number;
    }
  | {
      status: "success";
      botToken: string;
      botId?: string;
    }
  | {
      status: "expired" | "error";
      message?: string;
    };

export interface BotFeishuRegistrationBeginParams {
  domain?: "feishu" | "lark";
}

export interface BotFeishuRegistrationBeginResult {
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  interval: number;
  expiresAt: number;
  domain: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
}

export interface BotFeishuRegistrationPollParams {
  deviceCode: string;
  domain?: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
}

export type BotFeishuRegistrationPollResult =
  | {
      status: "pending";
      interval: number;
      domain: "feishu" | "lark";
      pollDomain?: "feishu" | "lark";
    }
  | {
      status: "success";
      appId: string;
      appSecret: string;
      domain: "feishu" | "lark";
      appName?: string;
      openId?: string;
    }
  | {
      status: "access_denied" | "expired" | "error";
      message?: string;
      domain: "feishu" | "lark";
    };

export interface IBotsService {
  /**
   * 将 App 全局交互偏好同步给 Bot 已持有的远端 runtime；不得为此建立新的远端连接。
   */
  syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
  getStatus(): Promise<BotServiceStatus>;
  getConfig(): Promise<BotsConfigFile>;
  listWorkspaceRefs(params?: BotListWorkspaceRefsParams): Promise<BotWorkspaceRef[]>;
  getUserConfigOptions(params: BotUserConfigOptionsParams): Promise<ZCodeConfigOption[]>;
  beginFeishuRegistration(
    params?: BotFeishuRegistrationBeginParams,
  ): Promise<BotFeishuRegistrationBeginResult>;
  pollFeishuRegistration(
    params: BotFeishuRegistrationPollParams,
  ): Promise<BotFeishuRegistrationPollResult>;
  beginWeixinRegistration(): Promise<BotWeixinRegistrationBeginResult>;
  pollWeixinRegistration(
    params: BotWeixinRegistrationPollParams,
  ): Promise<BotWeixinRegistrationPollResult>;
  saveConfig(config: BotsConfigFile): Promise<BotsConfigFile>;
  listBots(): Promise<BotConfig[]>;
  saveBot(params: BotSaveBotParams): Promise<BotConfig>;
  removeBotSecret(botId: string): Promise<BotConfig>;
  deleteBot(botId: string): Promise<void>;
  testBot(botId: string): Promise<BotTestResult>;
  createBindCode(params: BotCreateBindCodeParams): Promise<BotBindCodeResult>;
  getBotStates(): Promise<BotContextState[]>;
  resetBotState(contextKey: string): Promise<void>;
  /** 在 automation prompt 派发前订阅终态，并把结果回推到创建它的 Bot 会话。 */
  watchAutomationRun(params: BotAutomationRunWatchParams): Promise<void>;
  handleInboundMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]>;
  handleProviderCallback(provider: BotProvider, payload: unknown): Promise<BotOutboundMessage[]>;
  handleProviderCallbackResponse(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
}

export const IBotsService = createServiceDescriptor<IBotsService>(ServiceChannels.Bots);

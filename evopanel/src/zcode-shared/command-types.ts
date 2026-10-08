// Command 相关类型定义
import type { SettingsDirectoryLocation } from "./settings-source.js";

export type CommandSource = "user" | "plugin";
export type CommandAgentSource = "zcodeAgent";

export interface CommandInfo {
  name: string;
  prompt: string;
  content: string;
  filePath: string;
  description?: string;
  argumentHint?: string;
}

export interface UserCommand extends CommandInfo {
  id: string;
  source: "user";
  agentSource: CommandAgentSource;
  location: SettingsDirectoryLocation;
  enabled: boolean;
  scope: "global" | "project";
  projectPath?: string;
}

export interface PluginCommand extends Omit<CommandInfo, "filePath"> {
  id: string;
  source: "plugin";
  enabled: boolean;
  pluginName: string;
  pluginMarketplace: string;
  pluginEnabled: boolean;
  scope: "global";
  filePath: string;
}

export type ZCodeCommand = UserCommand | PluginCommand;

export function isUserCommand(command: ZCodeCommand): command is UserCommand {
  return command.source === "user";
}

export function isPluginCommand(command: ZCodeCommand): command is PluginCommand {
  return command.source === "plugin";
}

export interface CommandConfig {
  name: string;
  prompt: string;
  description?: string;
  argumentHint?: string;
  filePath?: string;
}

export type CommandStorageLevel = "user" | "project";

export interface CommandsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export interface CommandsListResult {
  commands: ZCodeCommand[];
  userCommands: UserCommand[];
  pluginCommands: PluginCommand[];
  capability: CommandsCapability;
}

export interface CommandCreateParams {
  config: CommandConfig;
  agentSource?: CommandAgentSource;
  storageLevel?: CommandStorageLevel;
  workspacePath?: string;
}

export interface CommandUpdateParams {
  commandId: string;
  config: CommandConfig;
  agentSource?: CommandAgentSource;
  oldFilePath?: string;
  storageLevel?: CommandStorageLevel;
  workspacePath?: string;
}

export interface CommandDeleteParams {
  commandId: string;
  filePath: string;
  agentSource?: CommandAgentSource;
}

export interface CommandSetEnabledParams {
  commandId: string;
  filePath: string;
  enabled: boolean;
  agentSource?: CommandAgentSource;
}

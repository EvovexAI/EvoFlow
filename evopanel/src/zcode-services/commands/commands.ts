import type {
  CommandsListResult,
  CommandCreateParams,
  CommandUpdateParams,
  CommandDeleteParams,
  CommandSetEnabledParams,
  CommandAgentSource,
  UserCommand,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ICommandsService {
  list(params: {
    agentSource?: CommandAgentSource;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<CommandsListResult>;
  writeCommandFile(params: CommandCreateParams): Promise<{ command: UserCommand }>;
  updateCommandFile(params: CommandUpdateParams): Promise<{ command: UserCommand }>;
  deleteCommandFile(params: CommandDeleteParams): Promise<void>;
  setCommandEnabled(params: CommandSetEnabledParams): Promise<void>;
  getPrimaryUserCommandsDirectory(params?: {
    agentSource?: CommandAgentSource;
  }): Promise<{ path: string }>;
}

export const ICommandsService = createServiceDescriptor<ICommandsService>(ServiceChannels.Commands);

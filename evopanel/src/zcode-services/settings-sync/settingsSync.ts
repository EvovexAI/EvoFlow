import type {
  SettingsSyncDiscoveryResult,
  SettingsSyncClaudeAgentsFileCopyResult,
  SettingsSyncClaudeAgentsFileMigrationStatus,
  SettingsSyncFirstRunPromptState,
  SettingsSyncImportResult,
  SettingsSyncProgressEvent,
  SettingsSyncSelection,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISettingsSyncService {
  getClaudeAgentsFileMigrationStatus(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<SettingsSyncClaudeAgentsFileMigrationStatus>;
  copyClaudeAgentsFileToZcodeAgentsFile(request?: {
    workspacePath?: string;
    workspaceIdentity?: string;
    overwrite?: boolean;
  }): Promise<SettingsSyncClaudeAgentsFileCopyResult>;
  detect(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
    categories?: SettingsSyncSelection["category"][];
    intent?: "firstRun" | "manualImport";
  }): Promise<SettingsSyncDiscoveryResult>;
  importSelected(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
    selections: SettingsSyncSelection[];
    onProgress?: (event: SettingsSyncProgressEvent) => void;
  }): Promise<SettingsSyncImportResult>;
  getFirstRunPromptState(): Promise<SettingsSyncFirstRunPromptState>;
  markFirstRunPromptHandled(): Promise<void>;
}

export const ISettingsSyncService = createServiceDescriptor<ISettingsSyncService>(
  ServiceChannels.SettingsSync,
);

import type {
  SettingsSyncAgent,
  SettingsSyncCategory,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
} from "@zcode/shared";

export type SettingsSyncUiStep = "selection" | "importing" | "complete";

export interface SettingsSyncUiTask {
  id: string;
  agent: SettingsSyncAgent;
  category: SettingsSyncCategory;
  discoveredCount: number;
  status: "pending" | "running" | "success" | "skipped" | "failed";
}

export interface SettingsSyncUiState {
  open: boolean;
  loading: boolean;
  importing: boolean;
  step: SettingsSyncUiStep;
  discovery: SettingsSyncDiscoveryResult | null;
  selectedKeys: string[];
  tasks: SettingsSyncUiTask[];
  result: SettingsSyncImportResult | null;
  error: string | null;
}

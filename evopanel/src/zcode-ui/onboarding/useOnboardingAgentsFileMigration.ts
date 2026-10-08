import { useCallback, useEffect, useState } from "react";
import type {
  SettingsSyncClaudeAgentsFileCopyResult,
  SettingsSyncClaudeAgentsFileMigrationStatus,
} from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface OnboardingAgentsFileMigrationState {
  error: string | null;
  loading: boolean;
  selected: boolean;
  status: SettingsSyncClaudeAgentsFileMigrationStatus | null;
  copy: () => Promise<SettingsSyncClaudeAgentsFileCopyResult>;
  refresh: () => Promise<void>;
  setSelected: (selected: boolean) => void;
}

export function useOnboardingAgentsFileMigration(params: {
  enabled: boolean;
  workspacePath?: string;
  workspaceIdentity?: string;
}): OnboardingAgentsFileMigrationState {
  const { settingsSyncService } = useServices();
  const [status, setStatus] = useState<SettingsSyncClaudeAgentsFileMigrationStatus | null>(null);
  const [selected, setSelectedState] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextStatus = await settingsSyncService.getClaudeAgentsFileMigrationStatus({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      setStatus(nextStatus);
      setSelectedState(nextStatus.supported);
    } catch (loadError) {
      const message = normalizeError(loadError);
      logger.error("[OnboardingAgentsFileMigration] status load failed", {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        error: message,
      });
      setError(message);
      setStatus(null);
      setSelectedState(false);
    } finally {
      setLoading(false);
    }
  }, [params.workspaceIdentity, params.workspacePath, settingsSyncService]);

  useEffect(() => {
    if (!params.enabled) {
      return;
    }

    void refresh();
  }, [params.enabled, refresh]);

  const setSelected = useCallback(
    (nextSelected: boolean) => {
      setSelectedState(nextSelected && status?.supported === true);
    },
    [status?.supported],
  );

  const copy = useCallback(async () => {
    const result = await settingsSyncService.copyClaudeAgentsFileToZcodeAgentsFile({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      overwrite: true,
    });
    await refresh();
    return result;
  }, [params.workspaceIdentity, params.workspacePath, refresh, settingsSyncService]);

  return {
    error,
    loading,
    selected,
    status,
    copy,
    refresh,
    setSelected,
  };
}

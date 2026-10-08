import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsSyncSelection } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import type { useClaudeSessionMigration } from "@/hooks/useClaudeSessionMigration.js";
import type { useSettingsSync } from "@/hooks/useSettingsSync.js";
import {
  createInitialFinishExecutionState,
  type FinishExecutionState,
} from "@/onboarding/OnboardingFlowParts.js";
import type { OnboardingView, OnboardingWizardStep } from "@/onboarding/OnboardingDialogParts.js";
import type { OnboardingAgentsFileMigrationState } from "@/onboarding/useOnboardingAgentsFileMigration.js";

export function shouldAutoScanOnboardingSessions(params: {
  view: OnboardingView;
  wizardStep: OnboardingWizardStep;
  supported: boolean;
  isScanning: boolean;
  candidateCount: number;
  scanError: string | null;
  hasAutoScannedInCurrentEntry: boolean;
}): boolean {
  return (
    params.view === "wizard" &&
    params.wizardStep === "session" &&
    params.supported &&
    !params.isScanning &&
    params.candidateCount === 0 &&
    !params.scanError &&
    !params.hasAutoScannedInCurrentEntry
  );
}

function groupWorkspaceCandidates(
  workspacePaths: string[],
  allCandidates: ReturnType<typeof useClaudeSessionMigration>["candidates"],
) {
  return workspacePaths.flatMap((workspacePath) => {
    const matches = allCandidates.filter((candidate) => candidate.workspacePath === workspacePath);
    if (matches.length === 0) {
      return [];
    }

    return [
      {
        workspacePath,
        label: getPathLeaf(workspacePath),
        sessionIds: matches.map((candidate) => candidate.sessionId),
      },
    ];
  });
}

export function useOnboardingMigration(
  view: OnboardingView,
  wizardStep: OnboardingWizardStep,
  selectedWorkspacePaths: string[],
  additionalSettingsSelections: SettingsSyncSelection[],
  sessionMigration: ReturnType<typeof useClaudeSessionMigration>,
  agentsFileMigration: OnboardingAgentsFileMigrationState,
  settingsSync: ReturnType<typeof useSettingsSync>,
  options: { includeSettingsSelections?: boolean } = {},
) {
  const { intl } = useZCodeIntl();
  const [finishExecution, setFinishExecution] = useState<FinishExecutionState>(
    createInitialFinishExecutionState,
  );
  const runningFinishRef = useRef(false);

  const startUnifiedMigration = useCallback(async () => {
    if (runningFinishRef.current) {
      return;
    }

    runningFinishRef.current = true;
    const selectedWorkspaceGroups = groupWorkspaceCandidates(
      selectedWorkspacePaths,
      sessionMigration.candidates,
    );

    setFinishExecution({
      started: true,
      running: true,
      finished: false,
      sessionCompletedCount: 0,
      sessionTotalCount: selectedWorkspaceGroups.length,
      sessionImportedCount: 0,
      sessionSkippedCount: 0,
      sessionFailedCount: 0,
      agentsFileCompletedCount: 0,
      agentsFileTotalCount: agentsFileMigration.selected ? 1 : 0,
      agentsFileImportedCount: 0,
      agentsFileSkippedCount: 0,
      agentsFileFailedCount: 0,
      currentTaskLabel: null,
      error: null,
    });

    try {
      for (let index = 0; index < selectedWorkspaceGroups.length; index += 1) {
        const workspace = selectedWorkspaceGroups[index];
        if (!workspace) {
          continue;
        }

        setFinishExecution((current) => ({
          ...current,
          currentTaskLabel: intl.formatMessage(
            { id: "onboarding.finish.currentWorkspace" },
            { workspace: workspace.label },
          ),
        }));

        const result = await sessionMigration.importSessions(workspace.sessionIds);
        if (!result) {
          throw new Error(sessionMigration.importError ?? "Session migration failed");
        }

        setFinishExecution((current) => ({
          ...current,
          sessionCompletedCount: current.sessionCompletedCount + 1,
          sessionImportedCount: current.sessionImportedCount + result.imported.length,
          sessionSkippedCount: current.sessionSkippedCount + result.skipped.length,
          sessionFailedCount: current.sessionFailedCount + result.failed.length,
        }));
      }

      if (agentsFileMigration.selected) {
        setFinishExecution((current) => ({
          ...current,
          currentTaskLabel: intl.formatMessage({
            id: "onboarding.finish.currentAgentsFile",
          }),
        }));

        try {
          const result = await agentsFileMigration.copy();
          setFinishExecution((current) => ({
            ...current,
            agentsFileCompletedCount: current.agentsFileCompletedCount + 1,
            agentsFileImportedCount:
              current.agentsFileImportedCount + (result.status === "copied" ? 1 : 0),
            agentsFileSkippedCount:
              current.agentsFileSkippedCount + (result.status === "skipped" ? 1 : 0),
          }));
        } catch (copyError) {
          setFinishExecution((current) => ({
            ...current,
            agentsFileCompletedCount: current.agentsFileCompletedCount + 1,
            agentsFileFailedCount: current.agentsFileFailedCount + 1,
          }));
          throw copyError;
        }
      }

      const includeSettingsSelections = options.includeSettingsSelections ?? true;
      const selectedSettingsCount = includeSettingsSelections ? settingsSync.selectedCount : 0;
      if (selectedSettingsCount > 0 || additionalSettingsSelections.length > 0) {
        setFinishExecution((current) => ({
          ...current,
          currentTaskLabel: intl.formatMessage({
            id: "onboarding.finish.currentSettings",
          }),
        }));
        await settingsSync.actions.startImportWithAdditionalSelections(
          additionalSettingsSelections,
          { includeCurrentSelections: includeSettingsSelections },
        );
      }

      setFinishExecution((current) => ({
        ...current,
        running: false,
        finished: true,
        currentTaskLabel: null,
      }));
    } catch (error) {
      setFinishExecution((current) => ({
        ...current,
        running: false,
        finished: true,
        error: error instanceof Error ? error.message : String(error),
        currentTaskLabel: null,
      }));
    } finally {
      runningFinishRef.current = false;
    }
  }, [
    additionalSettingsSelections,
    agentsFileMigration,
    intl,
    selectedWorkspacePaths,
    sessionMigration,
    settingsSync.actions,
    settingsSync.selectedCount,
    options.includeSettingsSelections,
  ]);

  useEffect(() => {
    if (view !== "wizard" || wizardStep !== "migration" || finishExecution.started) {
      return;
    }

    void startUnifiedMigration();
  }, [finishExecution.started, startUnifiedMigration, view, wizardStep]);

  const resetFinishExecution = useCallback(() => {
    setFinishExecution(createInitialFinishExecutionState());
  }, []);

  return { finishExecution, resetFinishExecution };
}

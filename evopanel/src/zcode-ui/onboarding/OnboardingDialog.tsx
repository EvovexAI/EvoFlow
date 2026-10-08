/* eslint-disable max-lines -- onboarding 弹窗集中编排欢迎页、会话迁移、外部导入和最终执行状态，拆开会增加跨步骤状态传递复杂度 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { useClaudeSessionMigration } from "@/hooks/useClaudeSessionMigration.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useSettingsSync } from "@/hooks/useSettingsSync.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import {
  getOnboardingStepMessageKey,
  OnboardingWizardSidebar,
  OnboardingWizardFooter,
  OnboardingWizardHeader,
  type OnboardingView,
  type OnboardingWizardStep,
} from "@/onboarding/OnboardingDialogParts.js";
import {
  OnboardingExternalAgentImportStep,
  OnboardingMigrationStep,
  OnboardingSessionsStep,
  OnboardingWelcomeView,
  OnboardingFinishStep,
  type OnboardingWorkspaceCandidate,
} from "@/onboarding/OnboardingFlowParts.js";
import { OnboardingAgentsFileStep } from "@/onboarding/OnboardingAgentsFileStep.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import {
  shouldAutoScanOnboardingSessions,
  useOnboardingMigration,
} from "@/onboarding/useOnboardingMigration.js";
import { useOnboardingAgentsFileMigration } from "@/onboarding/useOnboardingAgentsFileMigration.js";
import { useServices } from "@/hooks/useServices.js";
import { useExternalAgentImportCategoryState } from "@/settings/ExternalAgentImportDialog.js";

export { shouldAutoScanOnboardingSessions } from "@/onboarding/useOnboardingMigration.js";

const ONBOARDING_STEP_ORDER: OnboardingWizardStep[] = [
  "session",
  "skills-import",
  "mcp-import",
  // 插件导入步骤未启用。
  // "plugins-import",
  "commands-import",
  "agents-file",

  "migration",
];

export function OnboardingDialog(props: {
  workspacePath?: string;
  workspaceIdentity?: string;
  isDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const settingsSync = useSettingsSync({
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
  });
  const sessionMigration = useClaudeSessionMigration({
    workspacePath: props.workspacePath ?? null,
    isDesktop: props.isDesktop,
  });
  const onboardingDialogRequested = useZCodeStore((state) => state.onboardingDialogRequested);
  const clearOnboardingDialogRequest = useZCodeStore((state) => state.clearOnboardingDialogRequest);
  const [view, setView] = useState<OnboardingView>("welcome");
  const [wizardStep, setWizardStep] = useState<OnboardingWizardStep>("session");
  const [selectedWorkspacePaths, setSelectedWorkspacePaths] = useState<string[]>([]);
  const initializedWorkspaceSelectionRef = useRef(false);
  const autoScannedSessionStepRef = useRef(false);

  // 引导阶段没有 Scope 选择，target 恒为当前上下文 workspace，直接注入其 service。
  const { settingsSyncService } = useServices();

  const skillsImportState = useExternalAgentImportCategoryState({
    category: "skills",
    enabled: view === "wizard" && wizardStep === "skills-import",
    settingsSyncService,
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
  });
  const mcpImportState = useExternalAgentImportCategoryState({
    category: "mcpServers",
    enabled: view === "wizard" && wizardStep === "mcp-import",
    settingsSyncService,
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
  });
  /*
   * 插件导入步骤未启用。
   * const pluginsImportState = useExternalAgentImportCategoryState({
   *   category: "plugins",
   *   enabled: view === "wizard" && wizardStep === "plugins-import",
   *   settingsSyncService,
   *   workspacePath: props.workspacePath,
   *   workspaceIdentity: props.workspaceIdentity,
   * });
   */
  const commandsImportState = useExternalAgentImportCategoryState({
    category: "commands",
    enabled: view === "wizard" && wizardStep === "commands-import",
    settingsSyncService,
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
  });
  const agentsFileMigration = useOnboardingAgentsFileMigration({
    enabled: view === "wizard" && wizardStep === "agents-file",
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
  });

  const workspaceCandidates = useMemo<OnboardingWorkspaceCandidate[]>(() => {
    const byWorkspace = new Map<string, OnboardingWorkspaceCandidate>();

    for (const candidate of sessionMigration.candidates) {
      const current = byWorkspace.get(candidate.workspacePath);
      if (current) {
        current.sessionCount += 1;
        continue;
      }

      byWorkspace.set(candidate.workspacePath, {
        workspacePath: candidate.workspacePath,
        label: getPathLeaf(candidate.workspacePath),
        sessionCount: 1,
      });
    }

    return [...byWorkspace.values()].sort((left, right) => right.sessionCount - left.sessionCount);
  }, [sessionMigration.candidates]);

  const externalImportSelections = useMemo(
    () => [
      ...skillsImportState.selections,
      ...mcpImportState.selections,
      ...commandsImportState.selections,
    ],
    [commandsImportState.selections, mcpImportState.selections, skillsImportState.selections],
  );
  const totalExternalImportSelectedCount =
    skillsImportState.selectedCount +
    mcpImportState.selectedCount +
    commandsImportState.selectedCount;
  const { finishExecution, resetFinishExecution } = useOnboardingMigration(
    view,
    wizardStep,
    selectedWorkspacePaths,
    externalImportSelections,
    sessionMigration,
    agentsFileMigration,
    settingsSync,
    // 代理设置步骤未启用，不导入其默认选择。
    { includeSettingsSelections: false },
  );

  useEffect(() => {
    if (!settingsSync.state.open) {
      setView("welcome");
      setWizardStep("session");
      setSelectedWorkspacePaths([]);
      resetFinishExecution();
      initializedWorkspaceSelectionRef.current = false;
      autoScannedSessionStepRef.current = false;
      return;
    }
  }, [settingsSync.state.open, resetFinishExecution]);

  useEffect(() => {
    if (!onboardingDialogRequested) {
      return;
    }

    setView(onboardingDialogRequested === "migration" ? "wizard" : "welcome");
    setWizardStep("session");
    resetFinishExecution();
    settingsSync.actions.reopen();
    clearOnboardingDialogRequest();
  }, [
    clearOnboardingDialogRequest,
    onboardingDialogRequested,
    resetFinishExecution,
    settingsSync.actions,
  ]);

  useEffect(() => {
    if (view !== "wizard" || wizardStep !== "session") {
      autoScannedSessionStepRef.current = false;
    }
  }, [view, wizardStep]);

  useEffect(() => {
    if (
      !shouldAutoScanOnboardingSessions({
        view,
        wizardStep,
        supported: sessionMigration.supportState.supported,
        isScanning: sessionMigration.isScanning,
        candidateCount: sessionMigration.candidates.length,
        scanError: sessionMigration.scanError,
        hasAutoScannedInCurrentEntry: autoScannedSessionStepRef.current,
      })
    ) {
      return;
    }

    autoScannedSessionStepRef.current = true;
    void sessionMigration.scan();
  }, [
    sessionMigration.candidates.length,
    sessionMigration.isScanning,
    sessionMigration.scan,
    sessionMigration.scanError,
    sessionMigration.supportState.supported,
    view,
    wizardStep,
  ]);

  useEffect(() => {
    setSelectedWorkspacePaths((previous) => {
      const nextWorkspacePaths = [
        ...new Set(sessionMigration.candidates.map((candidate) => candidate.workspacePath)),
      ];

      if (nextWorkspacePaths.length === 0) {
        initializedWorkspaceSelectionRef.current = false;
        return [];
      }

      if (!initializedWorkspaceSelectionRef.current) {
        initializedWorkspaceSelectionRef.current = true;
        return nextWorkspacePaths;
      }

      return previous.filter((workspacePath) => nextWorkspacePaths.includes(workspacePath));
    });
  }, [sessionMigration.candidates]);

  const selectedWorkspaceCount = selectedWorkspacePaths.length;
  /** 既无会话也无外部导入项时，禁止进入迁移步骤。 */
  const beginMigrationDisabled =
    selectedWorkspaceCount === 0 &&
    totalExternalImportSelectedCount === 0 &&
    !agentsFileMigration.selected;
  const settingsCompletedTaskCount = useMemo(
    () =>
      settingsSync.state.tasks.filter(
        (task) => task.status !== "pending" && task.status !== "running",
      ).length,
    [settingsSync.state.tasks],
  );
  const totalExecutionTaskCount =
    finishExecution.sessionTotalCount +
    finishExecution.agentsFileTotalCount +
    externalImportSelections.length;
  const completedExecutionTaskCount =
    finishExecution.sessionCompletedCount +
    finishExecution.agentsFileCompletedCount +
    settingsCompletedTaskCount;
  const overallProgress =
    totalExecutionTaskCount > 0
      ? Math.round((completedExecutionTaskCount / totalExecutionTaskCount) * 100)
      : finishExecution.finished
        ? 100
        : 0;

  const stepMessageKey = getOnboardingStepMessageKey(wizardStep);
  const dialogTitle =
    view === "welcome"
      ? intl.formatMessage({ id: "onboarding.dialog.title" })
      : intl.formatMessage({ id: `onboarding.step.${stepMessageKey}` });
  const dialogDescription =
    view === "welcome"
      ? intl.formatMessage({ id: "onboarding.dialog.description" })
      : wizardStep === "agents-file"
        ? ""
        : intl.formatMessage({ id: `onboarding.stepDescription.${stepMessageKey}` });

  const toggleWorkspaceSelection = (workspacePath: string) => {
    setSelectedWorkspacePaths((previous) =>
      previous.includes(workspacePath)
        ? previous.filter((current) => current !== workspacePath)
        : [...previous, workspacePath],
    );
  };

  const clearWorkspaceSelection = () => {
    setSelectedWorkspacePaths([]);
  };

  const selectAllWorkspaces = () => {
    setSelectedWorkspacePaths(workspaceCandidates.map((workspace) => workspace.workspacePath));
  };

  const goToPreviousWizardStep = useCallback(() => {
    const currentIndex = ONBOARDING_STEP_ORDER.indexOf(wizardStep);
    if (currentIndex <= 0) {
      setView("welcome");
      return;
    }
    setWizardStep(ONBOARDING_STEP_ORDER[currentIndex - 1] ?? "session");
  }, [wizardStep]);

  const goToNextWizardStep = useCallback(() => {
    const currentIndex = ONBOARDING_STEP_ORDER.indexOf(wizardStep);
    const nextStep = ONBOARDING_STEP_ORDER[currentIndex + 1];
    if (nextStep && nextStep !== "migration") {
      setWizardStep(nextStep);
    }
  }, [wizardStep]);

  const handleBeginMigration = useCallback(async () => {
    if (agentsFileMigration.selected) {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "onboarding.agentsFile.confirmTitle" }),
        description: intl.formatMessage(
          { id: "onboarding.agentsFile.confirmDescription" },
          {
            source: agentsFileMigration.status?.sourcePath ?? "~/.claude/CLAUDE.md",
            target: agentsFileMigration.status?.targetPath ?? "~/.zcode/AGENTS.md",
          },
        ),
        confirmLabel: intl.formatMessage({ id: "onboarding.agentsFile.confirmAction" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      });

      if (!confirmed) {
        logger.info("[OnboardingDialog] AGENTS.md migration canceled by user", {
          workspacePath: props.workspacePath ?? null,
          workspaceIdentity: props.workspaceIdentity ?? null,
        });
        return;
      }
    }

    setWizardStep("migration");
  }, [
    agentsFileMigration.selected,
    agentsFileMigration.status?.sourcePath,
    agentsFileMigration.status?.targetPath,
    confirmDialog,
    intl,
    props.workspaceIdentity,
    props.workspacePath,
  ]);

  const handleCloseRequest = useCallback(async () => {
    if (!finishExecution.running) {
      settingsSync.actions.close();
      return;
    }

    logger.info("[OnboardingDialog] migration close requested while running", {
      workspacePath: props.workspacePath ?? null,
      workspaceIdentity: props.workspaceIdentity ?? null,
      currentTaskLabel: finishExecution.currentTaskLabel,
      overallProgress,
    });

    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "onboarding.migration.confirmCloseTitle" }),
      description: intl.formatMessage({
        id: "onboarding.migration.confirmCloseDescription",
      }),
      confirmLabel: intl.formatMessage({ id: "onboarding.migration.confirmCloseConfirm" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });

    if (!confirmed) {
      logger.info("[OnboardingDialog] migration close canceled by user", {
        workspacePath: props.workspacePath ?? null,
        workspaceIdentity: props.workspaceIdentity ?? null,
      });
      return;
    }

    settingsSync.actions.close();
  }, [
    confirmDialog,
    finishExecution.currentTaskLabel,
    finishExecution.running,
    intl,
    overallProgress,
    props.workspaceIdentity,
    props.workspacePath,
    settingsSync.actions,
  ]);

  const renderWizardBody = () => {
    switch (wizardStep) {
      case "session":
        return (
          <OnboardingSessionsStep
            migration={sessionMigration}
            workspaceCandidates={workspaceCandidates}
            selectedWorkspacePaths={selectedWorkspacePaths}
            onToggleWorkspace={toggleWorkspaceSelection}
            onSelectAll={selectAllWorkspaces}
            onClearSelection={clearWorkspaceSelection}
          />
        );
      case "skills-import":
        return (
          <OnboardingExternalAgentImportStep
            category="skills"
            state={skillsImportState}
            workspacePath={props.workspacePath}
          />
        );
      case "mcp-import":
        return (
          <OnboardingExternalAgentImportStep
            category="mcpServers"
            state={mcpImportState}
            workspacePath={props.workspacePath}
          />
        );
      /*
       * 插件导入步骤未启用。
       * case "plugins-import":
       *   return (
       *     <OnboardingExternalAgentImportStep
       *       category="plugins"
       *       state={pluginsImportState}
       *       workspacePath={props.workspacePath}
       *     />
       *   );
       */
      case "commands-import":
        return (
          <OnboardingExternalAgentImportStep
            category="commands"
            state={commandsImportState}
            workspacePath={props.workspacePath}
          />
        );
      case "agents-file":
        return <OnboardingAgentsFileStep migration={agentsFileMigration} />;

      case "migration":
        return finishExecution.finished ? (
          <OnboardingFinishStep
            overallProgress={overallProgress}
            finishExecution={finishExecution}
            settingsImportedCount={settingsSync.state.result?.successCount ?? 0}
            settingsSkippedCount={settingsSync.state.result?.skippedCount ?? 0}
            settingsFailedCount={settingsSync.state.result?.failedCount ?? 0}
          />
        ) : (
          <OnboardingMigrationStep
            overallProgress={overallProgress}
            finishExecution={finishExecution}
          />
        );
    }
  };

  return (
    <Dialog
      open={settingsSync.state.open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          // onboarding 迁移执行中即使隐藏了右上角关闭按钮，Radix 仍会响应遮罩点击和 Esc。
          // 之前这里直接 close 会把长时间迁移任务瞬间关掉，用户也拿不到二次确认；统一收口到确认逻辑后才不会误关。
          void handleCloseRequest();
        }
      }}
    >
      <DialogContent
        className="h-[calc(100vh-6rem)] max-w-4xl max-h-168 overflow-hidden rounded-2xl p-0"
        showCloseButton
      >
        <DialogTitle className="sr-only">{dialogTitle}</DialogTitle>
        <DialogDescription className="sr-only">{dialogDescription}</DialogDescription>

        {view === "welcome" ? (
          <OnboardingWelcomeView
            onStart={settingsSync.actions.close}
            onOpenMigration={() => {
              setView("wizard");
              setWizardStep("session");
            }}
          />
        ) : (
          <div className="flex h-full min-h-0 min-w-0">
            <OnboardingWizardSidebar currentStep={wizardStep} />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-hidden p-6">
              <OnboardingWizardHeader title={dialogTitle} description={dialogDescription} />
              <div className="min-h-0 flex-1">{renderWizardBody()}</div>
              <OnboardingWizardFooter
                currentStep={wizardStep}
                selectedWorkspaceCount={selectedWorkspaceCount}
                finishRunning={finishExecution.running}
                finishReady={finishExecution.finished}
                onBackToWelcome={() => setView("welcome")}
                onBackStep={goToPreviousWizardStep}
                onNextStep={goToNextWizardStep}
                onBeginMigration={() => void handleBeginMigration()}
                onFinish={settingsSync.actions.finish}
                beginMigrationDisabled={beginMigrationDisabled}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

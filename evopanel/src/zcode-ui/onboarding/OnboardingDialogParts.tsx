import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type OnboardingView = "welcome" | "wizard";
export type OnboardingWizardStep =
  | "session"
  | "skills-import"
  | "mcp-import"
  // 插件导入步骤未启用。
  // | "plugins-import"
  | "commands-import"
  | "agents-file"
  | "migration";

const WIZARD_STEPS: Array<{
  key: OnboardingWizardStep;
  index: number;
  titleId: string;
}> = [
  { key: "session", index: 1, titleId: "onboarding.step.session" },
  { key: "skills-import", index: 2, titleId: "onboarding.step.skillsImport" },
  { key: "mcp-import", index: 3, titleId: "onboarding.step.mcpImport" },
  // 插件导入步骤未启用。
  // { key: "plugins-import", index: 4, titleId: "onboarding.step.pluginsImport" },
  { key: "commands-import", index: 4, titleId: "onboarding.step.commandsImport" },
  { key: "agents-file", index: 5, titleId: "onboarding.step.agentsFile" },
  { key: "migration", index: 6, titleId: "onboarding.step.migration" },
];

export function getOnboardingStepMessageKey(step: OnboardingWizardStep): string {
  switch (step) {
    case "session":
      return "session";
    case "skills-import":
      return "skillsImport";
    case "mcp-import":
      return "mcpImport";
    case "commands-import":
      return "commandsImport";
    case "agents-file":
      return "agentsFile";

    case "migration":
      return "migration";
  }
}

export function OnboardingWizardSidebar(props: { currentStep: OnboardingWizardStep }) {
  const { intl } = useZCodeIntl();
  const currentIndex = WIZARD_STEPS.findIndex((step) => step.key === props.currentStep);

  return (
    <aside className="hidden w-56 shrink-0 flex-col gap-2 p-1 md:flex">
      <div className="flex h-full flex-col gap-4 rounded-xl border border-border bg-surface p-4">
        <div className="text-ui-base font-medium uppercase tracking-wide text-foreground-subtle">
          {intl.formatMessage({ id: "onboarding.wizard.label" })}
        </div>
        <div className="space-y-2">
          {WIZARD_STEPS.map((step, index) => {
            const isCurrent = step.key === props.currentStep;
            const isCompleted = index < currentIndex;

            return (
              <div
                key={step.key}
                className={cn(
                  "flex items-center gap-3 rounded-xl border-0 px-3 py-3 transition-colors",
                  isCurrent
                    ? "border-border-hover bg-card"
                    : isCompleted
                      ? "border-transparent bg-background-alt"
                      : "border-transparent bg-transparent",
                )}
              >
                <div
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border text-ui-base font-mono font-semibold",
                    isCurrent
                      ? "bg-primary text-primary-foreground"
                      : isCompleted
                        ? "border-success bg-success text-success-foreground"
                        : "border-border bg-background text-foreground-subtle",
                  )}
                >
                  {isCompleted ? <CheckIcon className="size-4" /> : index + 1}
                </div>
                <div className="min-w-0">
                  <div
                    className={cn(
                      "text-ui-base font-medium",
                      isCurrent || isCompleted ? "text-foreground" : "text-foreground-subtle",
                    )}
                  >
                    {intl.formatMessage({ id: step.titleId })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

export function OnboardingWizardHeader(props: { title: string; description: string }) {
  return (
    <div className="space-y-2">
      <div className="text-lg font-medium text-foreground">{props.title}</div>
      {props.description.trim().length > 0 ? (
        <div className="text-ui-base leading-6 text-foreground-subtle">{props.description}</div>
      ) : null}
    </div>
  );
}

export function OnboardingWizardFooter(props: {
  currentStep: OnboardingWizardStep;
  selectedWorkspaceCount: number;
  finishRunning: boolean;
  finishReady: boolean;
  onBackToWelcome: () => void;
  onBackStep: () => void;
  onNextStep: () => void;
  onBeginMigration: () => void;
  onFinish: () => void;
  /** 未选任何会话或外部导入项时禁用「开始迁移」 */
  beginMigrationDisabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const isExternalImportStep = isOnboardingExternalImportStep(props.currentStep);

  const helperText =
    props.currentStep === "session"
      ? intl.formatMessage(
          { id: "onboarding.footer.workspaceSelection" },
          { count: String(props.selectedWorkspaceCount) },
        )
      : intl.formatMessage({ id: "onboarding.footer.helper" });

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate text-ui-base text-foreground-subtle">{helperText}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {props.currentStep === "session" ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={props.onBackToWelcome}
            >
              {intl.formatMessage({ id: "common.back" })}
            </Button>
            <Button
              type="button"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={props.onNextStep}
            >
              {intl.formatMessage({ id: "onboarding.action.continue" })}
            </Button>
          </>
        ) : null}

        {isExternalImportStep ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={props.onBackStep}
            >
              {intl.formatMessage({ id: "common.back" })}
            </Button>
            <Button
              type="button"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={props.onNextStep}
            >
              {intl.formatMessage({ id: "onboarding.action.continue" })}
            </Button>
          </>
        ) : null}
        {props.currentStep === "agents-file" ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={props.onBackStep}
            >
              {intl.formatMessage({ id: "common.back" })}
            </Button>
            <Button
              type="button"
              size="lg"
              className="h-10 min-w-0 px-5"
              disabled={props.beginMigrationDisabled}
              onClick={props.onBeginMigration}
            >
              {intl.formatMessage({ id: "onboarding.action.beginMigration" })}
            </Button>
          </>
        ) : null}

        {props.currentStep === "migration" && props.finishReady ? (
          <Button
            type="button"
            size="lg"
            className="h-10 min-w-0 px-5"
            disabled={props.finishRunning}
            onClick={props.onFinish}
          >
            {intl.formatMessage({ id: "settingsSync.action.finish" })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function isOnboardingExternalImportStep(step: OnboardingWizardStep): boolean {
  return (
    step === "skills-import" ||
    step === "mcp-import" ||
    // 插件导入步骤未启用。
    // step === "plugins-import" ||
    step === "commands-import"
  );
}

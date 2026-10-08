import { CheckIcon, MinusIcon, XIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type RemoteWizardStep = "kind" | "settings" | "connecting" | "directory";

interface WizardStepMeta {
  key: RemoteWizardStep;
  titleId: string;
}

const REMOTE_WIZARD_STEPS: WizardStepMeta[] = [
  {
    key: "kind",
    titleId: "remote.step.kind",
  },
  {
    key: "settings",
    titleId: "remote.step.settings",
  },
  {
    key: "connecting",
    titleId: "remote.step.connecting",
  },
  {
    key: "directory",
    titleId: "remote.step.directory",
  },
];

function getStepIndex(step: RemoteWizardStep): number {
  return REMOTE_WIZARD_STEPS.findIndex((item) => item.key === step);
}

export function RemoteConnectionWizardSidebar({ currentStep }: { currentStep: RemoteWizardStep }) {
  const { intl } = useZCodeIntl();
  const currentIndex = getStepIndex(currentStep);

  return (
    <>
      <nav className="md:hidden">
        <div className="flex min-w-0 gap-2 overflow-x-auto rounded-xl border border-border bg-surface p-2">
          {REMOTE_WIZARD_STEPS.map((step, index) => {
            const isCurrent = currentStep === step.key;
            const isCompleted = index < currentIndex;

            return (
              <div
                key={step.key}
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "flex min-w-28 shrink-0 items-center gap-2 rounded-lg px-2 py-2",
                  isCurrent
                    ? "bg-card text-foreground"
                    : isCompleted
                      ? "bg-background-alt text-foreground"
                      : "text-foreground-subtle",
                )}
              >
                <div
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border text-ui-base font-mono font-semibold",
                    isCurrent
                      ? "bg-primary text-primary-foreground"
                      : isCompleted
                        ? "border-success bg-success text-success-foreground"
                        : "border-border bg-background text-foreground-subtle",
                  )}
                >
                  {isCompleted ? <CheckIcon className="size-3.5" /> : index + 1}
                </div>
                <span className="truncate text-ui-base font-medium">
                  {intl.formatMessage({ id: step.titleId })}
                </span>
              </div>
            );
          })}
        </div>
      </nav>

      <aside className="hidden w-56 shrink-0 flex-col gap-2 p-1 md:flex">
        <div className="rounded-xl border border-border bg-surface flex flex-col gap-4 p-4 h-full">
          <h3 className="text-ui-base font-medium tracking-wide text-foreground-subtle uppercase">
            {intl.formatMessage({ id: "remote.wizard" })}
          </h3>

          <div className="space-y-2">
            {REMOTE_WIZARD_STEPS.map((step, index) => {
              const isCurrent = currentStep === step.key;
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
                    <p
                      className={cn(
                        "text-ui-base font-medium",
                        isCurrent || isCompleted ? "text-foreground" : "text-foreground-subtle",
                      )}
                    >
                      {intl.formatMessage({ id: step.titleId })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </aside>
    </>
  );
}

export function RemoteConnectionWizardHeader({
  title,
  description,
  onMinimize,
  onClose,
}: {
  title: string;
  description: string;
  onMinimize?: () => void;
  onClose?: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <DialogTitle className="text-lg font-medium">{title}</DialogTitle>
        <div className="flex shrink-0 items-center gap-1">
          {onMinimize ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={onMinimize}
            >
              <MinusIcon className="size-4" />
              <span className="sr-only">{intl.formatMessage({ id: "remote.minimize" })}</span>
            </Button>
          ) : null}
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={onClose}
            >
              <XIcon className="size-4" />
              <span className="sr-only">{intl.formatMessage({ id: "common.close" })}</span>
            </Button>
          ) : null}
        </div>
      </div>
      <DialogDescription>{description}</DialogDescription>
    </div>
  );
}

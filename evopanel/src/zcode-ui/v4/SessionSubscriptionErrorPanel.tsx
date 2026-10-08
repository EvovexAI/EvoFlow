import { useCallback } from "react";
import { TID_V4_RETRY_SUBSCRIBE } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildErrorFeedbackDescription } from "@/lib/errorFeedbackDraft.js";

interface SessionSubscriptionErrorPanelProps {
  error: string;
  sessionId: string;
  workspacePath: string;
  onReconnect: () => void;
}

export function SessionSubscriptionErrorPanel({
  error,
  sessionId,
  workspacePath,
  onReconnect,
}: SessionSubscriptionErrorPanelProps) {
  const { intl } = useZCodeIntl();
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const handleOpenFeedback = useCallback(async () => {
    openFeedbackSubmit({
      title: error.slice(0, 80),
      type: "bug",
      module: "Agent任务执行失败",
      severity: "P2-中",
      includeLogs: false,
      description: buildErrorFeedbackDescription({
        message: error,
        contextLines: [
          intl.formatMessage({ id: "feedback.submit.template.section.taskInfo" }),
          intl.formatMessage({ id: "feedback.submit.template.section.taskId" }, { id: sessionId }),
          intl.formatMessage(
            { id: "feedback.submit.template.section.taskWorkspace" },
            { path: workspacePath },
          ),
        ],
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "chat.error.feedbackOpened" }));
  }, [error, intl, openFeedbackSubmit, sessionId, workspacePath]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-ui-base">
      <p className="max-w-full break-words text-center font-mono text-destructive">{error}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" variant="outline" onClick={handleOpenFeedback}>
          {intl.formatMessage({ id: "chat.error.feedback" })}
        </Button>
        <Button type="button" data-testid={TID_V4_RETRY_SUBSCRIBE} onClick={onReconnect}>
          {intl.formatMessage({ id: "workspaceSidebar.reconnect" })}
        </Button>
      </div>
    </div>
  );
}

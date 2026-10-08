import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import {
  type FeedbackTicketModule,
  type FeedbackTicketSeverity,
  type FeedbackTicketType,
} from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { FeedbackErrorTip } from "@/feedback/feedbackBadges.js";
import { readFeedbackContactPreference } from "@/feedback/feedbackContactPreference.js";
import {
  FeedbackScreenshotPicker,
  readScreenshotDraft,
  type ScreenshotAttachmentDraft,
} from "@/feedback/FeedbackScreenshotPicker.js";
import {
  ContactSection,
  DescriptionSection,
  LogUploadToggle,
  Section,
  SubmitFooter,
} from "@/feedback/FeedbackSubmitSections.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import {
  readCurrentAgentModelContext,
  type FeedbackAgentModelContext,
} from "@/feedback/feedbackSubmitModelContext.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import type { FeedbackSubmitDraft } from "@/feedback/feedbackStore.js";
import {
  cancelFeedbackCreateSubmissionJob,
  getFeedbackSubmissionJob,
  type FeedbackSubmissionJob,
  type FeedbackSubmissionProgressState,
} from "@/feedback/feedbackSubmissionJob.js";
import { useFeedbackSubmissionCopy } from "@/feedback/feedbackSubmissionCopy.js";
import {
  DEFAULT_FEEDBACK_MODULE,
  DEFAULT_FEEDBACK_SEVERITY,
  DEFAULT_FEEDBACK_TYPE,
  startSimplifiedFeedbackSubmission,
} from "@/feedback/feedbackSubmitSubmission.js";
import type { IFeedbackService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

export { SubmitProgressView } from "@/feedback/FeedbackSubmitProgressView.js";
export { readCurrentAgentModelContext } from "@/feedback/feedbackSubmitModelContext.js";

const DESCRIPTION_MAX = 4000;
const CONTACT_MAX = 200;
const MAX_SCREENSHOT_ATTACHMENTS = 5;

type SubmitProgressState = FeedbackSubmissionProgressState;

function shouldAutoCloseFeedbackOnTicketCreated({
  includeLogs,
  screenshotCount,
}: {
  includeLogs: boolean;
  screenshotCount: number;
}): boolean {
  return includeLogs || screenshotCount > 0;
}

export function FeedbackSubmitForm({
  feedbackService,
  platform: _platform,
  initialDraft,
  submissionJobId,
  onSubmitted,
  onViewTickets,
  onCancel,
}: {
  feedbackService: IFeedbackService;
  platform: IPlatformService;
  initialDraft?: FeedbackSubmitDraft | null;
  submissionJobId?: string | null;
  onSubmitted: (ticketId: string) => void;
  onViewTickets: () => void;
  onCancel: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const formatMessage = useCallback(
    (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values),
    [intl],
  );
  const appliedDraftRef = useRef<FeedbackSubmitDraft | null>(null);
  const mountedRef = useRef(true);
  const activeSubmissionJobRef = useRef<FeedbackSubmissionJob | null>(null);
  const modelContext = useActiveFeedbackModelContext();
  const [description, setDescription] = useState("");
  const [contact, setContact] = useState(() => readFeedbackContactPreference());
  const [screenshots, setScreenshots] = useState<ScreenshotAttachmentDraft[]>([]);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [ticketType, setTicketType] = useState<FeedbackTicketType>(DEFAULT_FEEDBACK_TYPE);
  const [ticketSeverity, setTicketSeverity] =
    useState<FeedbackTicketSeverity>(DEFAULT_FEEDBACK_SEVERITY);
  const [ticketModule, setTicketModule] = useState<FeedbackTicketModule>(DEFAULT_FEEDBACK_MODULE);
  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState<SubmitProgressState | null>(null);
  const [submissionJob, setSubmissionJob] = useState<FeedbackSubmissionJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submissionCopy = useFeedbackSubmissionCopy(formatMessage);

  const applySubmitDraft = useCallback((draft: FeedbackSubmitDraft) => {
    appliedDraftRef.current = draft;
    setDescription(draft.description ?? draft.title ?? "");
    if (draft.contact !== undefined) {
      setContact(draft.contact);
    }
    setTicketType(draft.type ?? DEFAULT_FEEDBACK_TYPE);
    setTicketSeverity(draft.severity ?? DEFAULT_FEEDBACK_SEVERITY);
    setTicketModule(draft.module ?? DEFAULT_FEEDBACK_MODULE);
    setIncludeLogs(draft.includeLogs ?? false);
    setScreenshots(
      (draft.screenshots ?? []).map((item, index) => ({
        id: `draft-${Date.now()}-${index}`,
        filename: item.filename,
        contentType: item.contentType,
        dataBase64: item.dataBase64,
        size: item.size,
      })),
    );
    setError(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const activeJob = activeSubmissionJobRef.current;
      const activeState = activeJob?.getState();
      if (activeJob && activeState?.status === "running" && !activeState.ticketId) {
        void cancelFeedbackCreateSubmissionJob(activeJob);
      }
    };
  }, []);

  useEffect(() => {
    if (!submissionJob) return;
    const subscription = submissionJob.subscribe((jobState) => {
      setSubmitProgress(jobState.progress);
      setSubmitting(jobState.status === "running" || jobState.status === "paused-log");
      if (jobState.status === "error") {
        setError(jobState.error ?? formatMessage("feedback.submission.failedLabel"));
      }
    });
    return () => subscription.dispose();
  }, [formatMessage, submissionJob]);

  useEffect(() => {
    if (submissionJob) return;
    if (!submissionJobId) return;
    // 后台提交必须由用户点击的 card 通过 jobId 精确绑定。
    // 新建问题上报不再猜测“最后一个活动 job”，避免旧上传状态锁住新表单。
    const selectedJob = getFeedbackSubmissionJob(submissionJobId);
    if (!selectedJob) return;
    logger.debug("[FeedbackSubmitForm] 恢复后台反馈任务", {
      jobId: selectedJob.id,
      hasFormDraft: Boolean(selectedJob.formDraft),
      screenshotCount: selectedJob.formDraft.screenshots?.length ?? 0,
    });
    // 恢复 job 进度时必须同时恢复该 job 的原始表单，否则问题描述为空。
    // 表单快照随 job 保存，确保并发提交时点击不同 card 能看到各自的内容。
    applySubmitDraft(selectedJob.formDraft);
    activeSubmissionJobRef.current = selectedJob;
    setSubmissionJob(selectedJob);
  }, [applySubmitDraft, submissionJob, submissionJobId]);

  useEffect(() => {
    if (!initialDraft || appliedDraftRef.current === initialDraft) return;
    applySubmitDraft(initialDraft);
  }, [applySubmitDraft, initialDraft]);

  const appendScreenshotFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length === 0) return;

      setError(null);
      try {
        const remaining = Math.max(MAX_SCREENSHOT_ATTACHMENTS - screenshots.length, 0);
        const next = await Promise.all(
          imageFiles.slice(0, remaining).map((file) => readScreenshotDraft(file)),
        );
        if (next.length > 0) {
          setScreenshots((current) => [...current, ...next].slice(0, MAX_SCREENSHOT_ATTACHMENTS));
        }
        if (imageFiles.length > remaining) {
          setError(
            formatMessage("feedback.submit.screenshotLimit", {
              count: String(MAX_SCREENSHOT_ATTACHMENTS),
            }),
          );
        }
      } catch (readError) {
        setError(getErrorMessage(readError));
      }
    },
    [formatMessage, screenshots.length],
  );

  const handleFormPaste = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (isTextInputFocused(event.currentTarget.ownerDocument)) return;

      const files = Array.from(event.clipboardData.files).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length === 0) return;

      event.preventDefault();
      void appendScreenshotFiles(files);
    },
    [appendScreenshotFiles],
  );

  const handleCancel = useCallback(() => {
    const activeJob = activeSubmissionJobRef.current;
    const activeState = activeJob?.getState();
    if (submitting && activeJob && activeState?.status === "running" && !activeState.ticketId) {
      void cancelFeedbackCreateSubmissionJob(activeJob, { onCancelError: setError });
      return;
    }
    onCancel();
  }, [onCancel, submitting]);

  const handleSubmit = useCallback(async () => {
    const trimmedDescription = description.trim();
    if (!trimmedDescription) {
      setError(formatMessage("feedback.submit.missingDescription"));
      return;
    }
    setSubmitting(true);
    setSubmitProgress({
      kind: "working",
      label: formatMessage("feedback.submission.connectingLabel"),
      detail: formatMessage("feedback.submission.connectingDetail"),
      indeterminate: true,
    });
    setError(null);
    try {
      const shouldCloseOnTicketCreated = shouldAutoCloseFeedbackOnTicketCreated({
        includeLogs,
        screenshotCount: screenshots.length,
      });
      const job = await startSimplifiedFeedbackSubmission({
        feedbackService,
        // 后端正文使用 trim 后的内容，但后台卡片恢复时必须保留用户输入原文。
        description,
        contact,
        screenshots,
        includeLogs,
        ticketType,
        ticketSeverity,
        ticketModule,
        modelContext,
        locale,
        copy: submissionCopy,
        formatMessage: intl.formatMessage,
        onTicketCreated: shouldCloseOnTicketCreated
          ? () => {
              if (mountedRef.current) {
                onCancel();
              }
            }
          : undefined,
        onCompleted: (ticketId) => {
          toast(formatMessage("feedback.submission.submittedToast"), { durationMs: 3000 });
          if (!mountedRef.current) return;
          window.setTimeout(() => {
            if (mountedRef.current && activeSubmissionJobRef.current?.id === job.id) {
              onSubmitted(ticketId);
            }
          }, 1200);
        },
        onError: (message) => {
          if (mountedRef.current) setError(message);
        },
      });
      activeSubmissionJobRef.current = job;
      if (mountedRef.current) {
        setSubmissionJob(job);
      }
      void job.done
        .catch(() => undefined)
        .finally(() => {
          if (mountedRef.current && activeSubmissionJobRef.current?.id === job.id) {
            setSubmitting(false);
          }
        });
    } catch (submitError) {
      setError(getErrorMessage(submitError));
      setSubmitting(false);
    }
  }, [
    contact,
    description,
    feedbackService,
    formatMessage,
    includeLogs,
    locale,
    modelContext,
    onCancel,
    onSubmitted,
    screenshots,
    submissionCopy,
    ticketModule,
    ticketSeverity,
    ticketType,
  ]);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-popover text-foreground"
      onPaste={handleFormPaste}
    >
      <ScrollFadeViewport className="px-6 pb-4 pt-3">
        <div className="mx-auto flex max-w-[720px] flex-col gap-3">
          <DescriptionSection
            value={description}
            max={DESCRIPTION_MAX}
            onChange={setDescription}
            formatMessage={formatMessage}
          />
          <Section
            title={formatMessage("feedback.submit.simple.screenshotTitle")}
            right={
              <span className="text-ui-xs tabular-nums text-foreground-subtle">
                {screenshots.length}/{MAX_SCREENSHOT_ATTACHMENTS}
              </span>
            }
          >
            <FeedbackScreenshotPicker
              screenshots={screenshots}
              screenshotHint={formatMessage("feedback.submit.simple.screenshotHint")}
              screenshotPrivacyHint={formatMessage("feedback.submit.simple.screenshotPrivacyHint")}
              addScreenshotLabel={formatMessage("feedback.submit.addScreenshot")}
              removeScreenshotLabel={formatMessage("feedback.submit.removeScreenshot")}
              onChange={setScreenshots}
              onAddFiles={(files) => {
                void appendScreenshotFiles(files);
              }}
            />
          </Section>
          <ContactSection
            value={contact}
            max={CONTACT_MAX}
            onChange={setContact}
            formatMessage={formatMessage}
          />
          <LogUploadToggle
            checked={includeLogs}
            onCheckedChange={setIncludeLogs}
            label={formatMessage("feedback.submit.simple.logsLabel")}
            hint={formatMessage("feedback.submit.simple.logsHint")}
          />
          {error ? <FeedbackErrorTip message={error} /> : null}
        </div>
      </ScrollFadeViewport>
      <SubmitFooter
        submitting={submitting}
        submitProgress={submitProgress}
        submitDisabled={submitting || !description.trim()}
        onViewTickets={onViewTickets}
        onCancel={handleCancel}
        onSubmit={handleSubmit}
        formatMessage={formatMessage}
      />
    </div>
  );
}

function isTextInputFocused(ownerDocument: Document) {
  const activeElement = ownerDocument.activeElement;
  const view = ownerDocument.defaultView;
  if (!activeElement || !view) return false;
  return (
    activeElement instanceof view.HTMLInputElement ||
    activeElement instanceof view.HTMLTextAreaElement
  );
}

function useActiveFeedbackModelContext(): FeedbackAgentModelContext {
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore(
    (state) => state.activeWorkspaceIdentity ?? undefined,
  );
  const workspaceZCodeState = useZCodeSessionStore((state) =>
    activeWorkspacePath
      ? selectWorkspaceZCodeState(state, activeWorkspacePath, activeWorkspaceIdentity)
      : null,
  );
  return useMemo(
    () => readCurrentAgentModelContext(workspaceZCodeState?.configOptions),
    [workspaceZCodeState?.configOptions],
  );
}

import { create } from "zustand";
import type {
  FeedbackTicketModule,
  FeedbackTicketSeverity,
  FeedbackTicketType,
} from "@zcode/shared";

type FeedbackTab = "submit" | "tickets";

export interface FeedbackAttachmentDraft {
  readonly filename: string;
  readonly contentType: string;
  readonly dataBase64: string;
  readonly size: number;
}

export interface FeedbackSubmitDraft {
  readonly title?: string;
  readonly description?: string;
  readonly contact?: string;
  readonly type?: FeedbackTicketType;
  readonly module?: FeedbackTicketModule;
  readonly severity?: FeedbackTicketSeverity;
  readonly screenshots?: readonly FeedbackAttachmentDraft[];
  readonly includeLogs?: boolean;
}

interface FeedbackUiState {
  open: boolean;
  featureRequestOpen: boolean;
  tab: FeedbackTab;
  submitDraft: FeedbackSubmitDraft | null;
  /** 仅查看指定后台提交时设置；新建反馈必须保持为 null */
  submissionJobId: string | null;
  /** 打开"我的反馈"列表时，可选地高亮某条工单 */
  selectedTicketId: string | null;
  /** 打开后立刻聚焦到提交表单 */
  openSubmit: (draft?: FeedbackSubmitDraft) => void;
  /** 打开指定后台提交任务的进度弹窗 */
  openSubmissionJob: (jobId: string) => void;
  /** 打开独立产品需求反馈弹窗 */
  openFeatureRequest: () => void;
  /** 打开后立刻聚焦到工单列表，可选 highlight */
  openTickets: (ticketId?: string) => void;
  /** 切换 Tab，但不关闭 dialog */
  setTab: (tab: FeedbackTab) => void;
  setSelectedTicketId: (ticketId: string | null) => void;
  close: () => void;
}

export const useFeedbackStore = create<FeedbackUiState>((set) => ({
  open: false,
  featureRequestOpen: false,
  tab: "submit",
  submitDraft: null,
  submissionJobId: null,
  selectedTicketId: null,
  openSubmit: (draft) =>
    set({
      // “问题上报”是新建入口，不能隐式续接上一次仍在上传的 job，
      // 否则新表单会继承旧 job 的 submitting 状态并阻止用户继续提交。
      open: true,
      featureRequestOpen: false,
      tab: "submit",
      submitDraft: draft ?? null,
      submissionJobId: null,
      selectedTicketId: null,
    }),
  openSubmissionJob: (jobId) =>
    set({
      open: true,
      featureRequestOpen: false,
      tab: "submit",
      submitDraft: null,
      submissionJobId: jobId,
      selectedTicketId: null,
    }),
  openFeatureRequest: () =>
    set({
      // 需求反馈和问题上报是两个独立 Dialog，必须互斥打开，避免后台浮层或快捷入口叠出双弹窗。
      open: false,
      featureRequestOpen: true,
      submitDraft: null,
      submissionJobId: null,
      selectedTicketId: null,
    }),
  openTickets: (ticketId) =>
    set({
      open: true,
      featureRequestOpen: false,
      tab: "tickets",
      submitDraft: null,
      submissionJobId: null,
      selectedTicketId: ticketId ?? null,
    }),
  setTab: (tab) =>
    set({
      tab,
      ...(tab === "submit" ? { submissionJobId: null } : {}),
    }),
  setSelectedTicketId: (ticketId) => set({ selectedTicketId: ticketId }),
  close: () =>
    set({
      open: false,
      featureRequestOpen: false,
      submitDraft: null,
      submissionJobId: null,
      selectedTicketId: null,
    }),
}));

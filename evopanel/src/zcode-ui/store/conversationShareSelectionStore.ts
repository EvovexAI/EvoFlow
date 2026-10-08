import { create } from "zustand";
import type { ConversationShareAccessMode } from "@zcode/shared";
import type { ConversationShareFailureIssue } from "@zcode/services";

type ConversationShareScope = "all" | "partial";
type ConversationShareSelectionView = "selection" | "timeline";
type ConversationShareSelectionStage = "selection" | "configuration";
export const DEFAULT_CONVERSATION_SHARE_ACCESS_MODE: ConversationShareAccessMode =
  "public_importable";

export interface ConversationShareAttempt {
  key: string;
  clientRequestId: string;
  disclosureAcceptedAt: number;
}

export interface ConversationShareDisplayError {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount?: number;
  requestId?: string;
  /** 没有服务端 issues 时展示的、按错误类型解析出的可行动文案。 */
  messageId?: string;
}

/** 发布成功但有结果物被跳过时的非阻断提示。 */
export interface ConversationShareDisplayWarnings {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount?: number;
}

export type ConversationShareProgressPhase = "collecting" | "uploading" | "checking";

interface ConversationShareSelectionDraft {
  scope: ConversationShareScope;
  stage: ConversationShareSelectionStage;
  view: ConversationShareSelectionView;
  availableRowIds: readonly number[];
  excludedRowIds: readonly number[];
  productTurnIdByRowId: Readonly<Record<number, string>>;
  accessMode: ConversationShareAccessMode;
}

interface ConversationShareDockState {
  title?: string;
  disclosureAccepted: boolean;
  publishing: boolean;
  progress: ConversationShareProgressPhase;
  completedArtifacts: number;
  totalArtifacts: number;
  publishedShareUrl: string | null;
  error: ConversationShareDisplayError | null;
  warnings: ConversationShareDisplayWarnings | null;
  attempt: ConversationShareAttempt | null;
}

interface ConversationShareSelectionState {
  popoverOpen: boolean;
  drafts: Record<string, ConversationShareSelectionDraft>;
  dockStates: Record<string, ConversationShareDockState>;
  setPopoverOpen: (open: boolean) => void;
  setScope: (taskId: string, scope: ConversationShareScope) => void;
  setAccessMode: (taskId: string, accessMode: ConversationShareAccessMode) => void;
  syncAvailableRowIds: (taskId: string, rowIds: readonly number[]) => void;
  syncAvailableTurns: (
    taskId: string,
    turns: readonly { rowId: number; productTurnId: string }[],
  ) => void;
  toggleRow: (taskId: string, rowId: number) => void;
  /** 按 product turn 身份整轮取消选择（阻断项的「取消选择该轮」入口）。 */
  deselectProductTurn: (taskId: string, productTurnId: string) => void;
  setAllRowsSelected: (taskId: string, selected: boolean) => void;
  goToConfiguration: (taskId: string) => void;
  goToSelection: (taskId: string) => void;
  showTimeline: (taskId: string) => void;
  showSelectionPanel: (taskId: string) => void;
  finishSelection: (taskId: string) => void;
  updateDockState: (taskId: string, patch: Partial<ConversationShareDockState>) => void;
  resetForTests: () => void;
}

const EMPTY_DRAFT: ConversationShareSelectionDraft = Object.freeze({
  scope: "all",
  stage: "selection",
  view: "timeline",
  availableRowIds: Object.freeze([]),
  excludedRowIds: Object.freeze([]),
  productTurnIdByRowId: Object.freeze({}),
  accessMode: DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
});

export const DEFAULT_CONVERSATION_SHARE_DOCK_STATE: ConversationShareDockState = Object.freeze({
  disclosureAccepted: false,
  publishing: false,
  progress: "collecting",
  completedArtifacts: 0,
  totalArtifacts: 0,
  publishedShareUrl: null,
  error: null,
  warnings: null,
  attempt: null,
});

function normalizeRowIds(rowIds: readonly number[]): number[] {
  return [...new Set(rowIds.filter(Number.isSafeInteger))].sort((left, right) => left - right);
}

function getConversationShareDraft(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
): ConversationShareSelectionDraft {
  return state.drafts[taskId] ?? EMPTY_DRAFT;
}

export function getConversationShareDockState(
  state: Pick<ConversationShareSelectionState, "dockStates">,
  taskId: string,
): ConversationShareDockState {
  return state.dockStates[taskId] ?? DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
}

export function getConversationShareSelectedRowIds(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
): number[] {
  const draft = getConversationShareDraft(state, taskId);
  const excluded = new Set(draft.excludedRowIds);
  return draft.availableRowIds.filter((rowId) => !excluded.has(rowId));
}

export function getConversationShareSelectedProductTurnIds(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
): string[] {
  const draft = getConversationShareDraft(state, taskId);
  const seen = new Set<string>();
  return getConversationShareSelectedRowIds(state, taskId).flatMap((rowId) => {
    const productTurnId = draft.productTurnIdByRowId[rowId];
    if (!productTurnId || seen.has(productTurnId)) return [];
    seen.add(productTurnId);
    return [productTurnId];
  });
}

export const useConversationShareSelectionStore = create<ConversationShareSelectionState>()(
  (set) => ({
    popoverOpen: false,
    drafts: {},
    dockStates: {},
    setPopoverOpen: (popoverOpen) => set({ popoverOpen }),
    setScope: (taskId, scope) =>
      set((state) => {
        const currentDraft = state.drafts[taskId];
        const dockStates = { ...state.dockStates };
        if (scope === "partial") {
          if (currentDraft?.scope !== "partial") {
            const previousAttempt = state.dockStates[taskId]?.attempt;
            dockStates[taskId] = previousAttempt
              ? { ...DEFAULT_CONVERSATION_SHARE_DOCK_STATE, attempt: previousAttempt }
              : DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
          }
        } else {
          delete dockStates[taskId];
        }
        return {
          // 进入局部选择后左侧面板成为唯一的范围选择入口，避免两个浮层同时争抢焦点。
          popoverOpen: scope === "partial" ? false : state.popoverOpen,
          drafts: {
            ...state.drafts,
            [taskId]:
              scope === "partial"
                ? {
                    scope,
                    stage: "selection",
                    view: "selection",
                    availableRowIds:
                      state.drafts[taskId]?.availableRowIds ?? EMPTY_DRAFT.availableRowIds,
                    // 每次从「全部对话」进入都是新的选择草稿，按产品语义默认全选。
                    excludedRowIds: [],
                    productTurnIdByRowId:
                      state.drafts[taskId]?.productTurnIdByRowId ??
                      EMPTY_DRAFT.productTurnIdByRowId,
                    accessMode: state.drafts[taskId]?.accessMode ?? EMPTY_DRAFT.accessMode,
                  }
                : EMPTY_DRAFT,
          },
          dockStates,
        };
      }),
    setAccessMode: (taskId, accessMode) =>
      set((state) => ({
        drafts: {
          ...state.drafts,
          [taskId]: {
            ...(state.drafts[taskId] ?? EMPTY_DRAFT),
            accessMode,
          },
        },
      })),
    syncAvailableRowIds: (taskId, rowIds) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial") return state;
        const availableRowIds = normalizeRowIds(rowIds);
        const available = new Set(availableRowIds);
        const excludedRowIds = current.excludedRowIds.filter((rowId) => available.has(rowId));
        if (
          availableRowIds.length === current.availableRowIds.length &&
          availableRowIds.every((rowId, index) => current.availableRowIds[index] === rowId) &&
          excludedRowIds.length === current.excludedRowIds.length
        ) {
          return state;
        }
        return {
          drafts: {
            ...state.drafts,
            [taskId]: { ...current, availableRowIds, excludedRowIds },
          },
        };
      }),
    syncAvailableTurns: (taskId, turns) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial") return state;
        const productTurnIdByRowId = Object.fromEntries(
          turns.map((turn) => [turn.rowId, turn.productTurnId]),
        );
        const availableRowIds = normalizeRowIds(turns.map((turn) => turn.rowId));
        const available = new Set(availableRowIds);
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              availableRowIds,
              excludedRowIds: current.excludedRowIds.filter((rowId) => available.has(rowId)),
              productTurnIdByRowId,
            },
          },
        };
      }),
    toggleRow: (taskId, rowId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial" || !current.availableRowIds.includes(rowId)) {
          return state;
        }
        const excluded = new Set(current.excludedRowIds);
        if (excluded.has(rowId)) excluded.delete(rowId);
        else excluded.add(rowId);
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              excludedRowIds: [...excluded].sort((left, right) => left - right),
            },
          },
        };
      }),
    /**
     * 按 product turn 身份整轮取消选择。
     *
     * 不能让 UI 用 service 的 turnOrdinal 去索引自己的 per-query 列表：
     * 两套编号在含系统上下文轮或多 steer query 的会话里必然错位；而且 toggleRow 只
     * 排除一行，同一轮的其他 query 仍留在选择里，阻断轮根本没被移除。
     * 「取消该轮」的语义是整轮，因此按 productTurnId 一次性排除全部行，且幂等。
     */
    deselectProductTurn: (taskId, productTurnId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial" || !productTurnId) return state;
        const excluded = new Set(current.excludedRowIds);
        let changed = false;
        for (const rowId of current.availableRowIds) {
          if (current.productTurnIdByRowId[rowId] !== productTurnId || excluded.has(rowId)) {
            continue;
          }
          excluded.add(rowId);
          changed = true;
        }
        if (!changed) return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              excludedRowIds: [...excluded].sort((left, right) => left - right),
            },
          },
        };
      }),
    setAllRowsSelected: (taskId, selected) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial") return state;
        const excludedRowIds = selected ? [] : [...current.availableRowIds];
        if (
          excludedRowIds.length === current.excludedRowIds.length &&
          excludedRowIds.every((rowId, index) => current.excludedRowIds[index] === rowId)
        ) {
          return state;
        }
        return {
          drafts: {
            ...state.drafts,
            [taskId]: { ...current, excludedRowIds },
          },
        };
      }),
    goToConfiguration: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (
          current.scope !== "partial" ||
          current.stage === "configuration" ||
          getConversationShareSelectedRowIds(state, taskId).length === 0
        ) {
          return state;
        }
        return {
          drafts: {
            ...state.drafts,
            [taskId]: { ...current, stage: "configuration" },
          },
        };
      }),
    goToSelection: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial" || current.stage === "selection") return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: { ...current, stage: "selection", view: "selection" },
          },
        };
      }),
    showTimeline: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial") return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: { ...current, view: "timeline" },
          },
        };
      }),
    showSelectionPanel: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial" || current.stage !== "selection") return state;
        return {
          // timeline 被标记为 popover 的 keep-open 区域，导致返回左侧面板时
          // 右上角 dropdown 仍滞留。面板切换由 store 收口，同时关闭 dropdown。
          popoverOpen: false,
          drafts: {
            ...state.drafts,
            [taskId]: { ...current, view: "selection" },
          },
        };
      }),
    finishSelection: (taskId) =>
      set((state) => {
        const dockStates = { ...state.dockStates };
        const previousAttempt = dockStates[taskId]?.attempt;
        if (previousAttempt) {
          // 幂等重试记录按 session 保留，但关闭后的可见结果、进度和错误必须清空。
          dockStates[taskId] = {
            ...DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
            attempt: previousAttempt,
          };
        } else {
          delete dockStates[taskId];
        }
        return {
          drafts: { ...state.drafts, [taskId]: EMPTY_DRAFT },
          // SessionPane 复用实例时，分享成功态不能留在组件本地，
          // 切到其它 session 后会继续被渲染；结束分享必须只清理当前 session 的 dock key。
          dockStates,
        };
      }),
    updateDockState: (taskId, patch) =>
      set((state) => ({
        dockStates: {
          ...state.dockStates,
          [taskId]: {
            ...getConversationShareDockState(state, taskId),
            ...patch,
          },
        },
      })),
    resetForTests: () =>
      set({
        popoverOpen: false,
        drafts: {},
        dockStates: {},
      }),
  }),
);

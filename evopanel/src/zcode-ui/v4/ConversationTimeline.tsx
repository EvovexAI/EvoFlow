/* oxlint-disable eslint(max-lines) -- ConversationTimeline 集中承载虚拟滚动、滚动锚定、loadOlder 与 find 高亮协调；拆散会让同一滚动状态跨文件传递。 */
import {
  Component,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { TID_V4_TIMELINE, TID_V4_TIMELINE_BOTTOM } from "@zcode/shared";
import type {
  ApiRetryState,
  AttachmentRef,
  CommandAck,
  ConversationRow,
  ConversationRowTarget,
  QueueItem,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { attachScrollJitterDiag, detachScrollJitterDiag, recordScrollWrite } from "@/v4/scrollJitterDiag.js";
import { logger } from "@/logger.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import { ConversationPendingGuideList } from "@/v4/ConversationPendingGuideList.js";
import type { AssistantFeedbackHandler } from "@/v4/ConversationRowView.js";
import { ConversationTurnNavigator } from "@/v4/ConversationTurnNavigator.js";
import { syncConversationShareSelectionPanelLayout } from "@/v4/conversationShareSelectionPanelLayout.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { splitConversationTimelineLiveTail } from "@/v4/conversationTimelineLiveTail.js";
import {
  getConversationContentWidthClassName,
  getConversationStatusPanelOffsetClassName,
} from "@/v4/conversationLayout.js";
import {
  buildConversationTurnRenderUnits,
  tryAppendTrailingUserInputUnit,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import {
  inspectConversationTurnFoldHealth,
  summarizeFoldHealthFindings,
} from "@/v4/conversationTurnFoldHealth.js";
import { logV4Life } from "../../react/lib/v4-lifecycle-log.js";
import {
  resolveConversationTurnNavigatorActiveQueryRowId,
  resolveConversationTurnNavigatorHydrationRetryDelayMs,
  shouldHydrateConversationTurnNavigatorDirectory,
  type ConversationTurnNavigatorHydrationResult,
  type ConversationTurnNavigatorQueryPosition,
  type ConversationTurnNavigatorVirtualItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import {
  DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  TimelineRowHeightCache,
} from "@/v4/timelineRowHeightCache.js";
import {
  readChatSessionScrollMemoryState,
  resolveChatSessionScrollRestoreTop,
  saveChatSessionScrollMemoryState,
  type ChatSessionScrollMemoryState,
} from "@/lib/chatSessionScrollMemory.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import {
  anchorActionAfterContentChange,
  historyPrefetchTriggerPx,
  initialFollowing,
  isAtBottom,
  prependScrollAdjustment,
  prependVirtualAnchorAdjustment,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
  shouldAdjustVirtualizerForItemSizeChange,
  shouldShowBackToBottom,
  shouldTriggerLoadOlder,
  timelineKeyboardScrollIntent,
  timelineTouchScrollIntent,
  timelineWheelScrollIntent,
  type PrependVirtualAnchor,
  type TimelineUserScrollIntent,
} from "@/v4/timelineScrollAnchor.js";
import { useConversationTimelineFind } from "@/v4/useConversationTimelineFind.js";
import { ConversationSelectionTooltip } from "@/v4/ConversationSelectionTooltip.js";
import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";

// memo 组件参数中的 `pendingGuides = []` 会在每次调用时创建新引用，
// 让未传该属性的渲染绕过稳定引用边界；共享只读空数组可保持默认值恒定。
const EMPTY_PENDING_GUIDES: readonly QueueItem[] = [];

const ROW_OVERSCAN = 8;
const RUNNING_WORK_DURATION_TICK_MS = 1000;
const COMPOSER_MESSAGE_MASK_FADE_PX = 24;
/** sticky bottomDock 叠在滚动视口内时，为 composer 预留的透明高度。 */
const COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX = 96;
/**
 * EvoFlow 单栏把 composer 挂在 HostStack 外稳定槽时没有 sticky 叠层，
 * 只需很短的底边淡出；再用 96px 会在输入框上方留出一大块「空白阴影」。
 */
const COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_EXTERNAL_PX = 20;
const USER_SCROLL_INTENT_TTL_MS = 1200;
const LAYOUT_SCROLL_GUARD_MS = 250;
const CONTENT_WIDTH_RESIZE_SETTLE_MS = 120;
const SCROLL_MEMORY_RESTORE_TOLERANCE_PX = 1;

function scheduleMicrotask(callback: () => void): void {
  // 部分 WebView/最小 DOM 运行时没有 window.queueMicrotask；调度能力应从
  // globalThis 注入，并保留 Promise 微任务降级，避免滚动恢复在 commit 阶段直接中断。
  if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(callback);
    return;
  }
  void Promise.resolve().then(callback);
}

function isEditableScrollTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

// v4 时间线重写滚动控件时把可访问名称误做成了可见文字，偏离旧版
// 的圆形下箭头样式；这里集中渲染图标按钮，避免两个定位分支再次产生视觉差异。
function ConversationBackToBottomButton({
  className,
  label,
  onClick,
}: {
  className: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={label}
      title={label}
      type="button"
      size="icon"
      variant="outline"
      className={cn("rounded-full bg-card hover:bg-card-selected", className)}
      data-testid={TID_V4_TIMELINE_BOTTOM}
      onClick={() =>
        runUserAction({
          input: { featureId: "conversation.navigation", action: "jump_bottom", trigger: "button" },
          operation: onClick,
          completed: { resultSource: "local_commit" },
          failureStage: "timeline_scroll",
        })
      }
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
}

interface ConversationScrollMemoryScopeSnapshot {
  key: string;
  state: ChatSessionScrollMemoryState;
}

type PendingScrollMemoryRestoreWait = "rows" | "content";

interface PendingScrollMemoryRestore extends ConversationScrollMemoryScopeSnapshot {
  rowWindowKey: string;
  waitFor: PendingScrollMemoryRestoreWait;
}

function resolvePendingScrollMemoryRestoreWait(
  state: ChatSessionScrollMemoryState | null,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  hasRows: boolean,
): PendingScrollMemoryRestoreWait | null {
  if (!state || state.wasPinnedToBottom !== false) return null;
  if (!hasRows || !element) return "rows";

  const restoredTop = resolveChatSessionScrollRestoreTop(state, element);
  return restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX < state.scrollTop ? "content" : null;
}

function canReleasePendingScrollMemoryRestore(
  pendingRestore: PendingScrollMemoryRestore,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  rowCount: number,
  hasOlderRows: boolean,
  rowWindowKey: string,
): boolean {
  if (!element) return false;
  if (pendingRestore.waitFor === "rows" && rowCount === 0) return false;
  const restoredTop = resolveChatSessionScrollRestoreTop(pendingRestore.state, element);
  const targetIsRepresentable =
    restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX >= pendingRestore.state.scrollTop;
  if (targetIsRepresentable || element.scrollHeight >= pendingRestore.state.scrollHeight) {
    return true;
  }
  // 新 lease 的首帧 rows 可能仍是截断尾窗；只要还能拉取更早历史，就继续保留原始
  // 恢复意图，避免把临时 clamp 后的 scrollTop 当成最终阅读锚点。
  return rowCount > 0 && !hasOlderRows && pendingRestore.rowWindowKey !== rowWindowKey;
}

interface ConversationScrollMemoryScopeCaptureProps {
  scopeKey: string | null;
  capture: (previousKey: string | null) => ConversationScrollMemoryScopeSnapshot | null;
  commit: (snapshot: ConversationScrollMemoryScopeSnapshot | null) => void;
}

/** React 的 before-mutation snapshot：scope cleanup 时普通 layout effect 已看到新 DOM。 */
class ConversationScrollMemoryScopeCapture extends Component<
  ConversationScrollMemoryScopeCaptureProps,
  unknown,
  ConversationScrollMemoryScopeSnapshot | null
> {
  getSnapshotBeforeUpdate(
    previousProps: ConversationScrollMemoryScopeCaptureProps,
  ): ConversationScrollMemoryScopeSnapshot | null {
    if (previousProps.scopeKey === this.props.scopeKey) return null;
    return this.props.capture(previousProps.scopeKey);
  }

  componentDidUpdate(
    _previousProps: ConversationScrollMemoryScopeCaptureProps,
    _previousState: unknown,
    snapshot: ConversationScrollMemoryScopeSnapshot | null,
  ): void {
    this.props.commit(snapshot);
  }

  render(): null {
    return null;
  }
}

/**
 * tanstack 竖向测高。RO borderBox 在 transform/显隐抖动时可能偏成 ≈72（估高），
 * 而 getBoundingClientRect 仍是正文真实高度——两者取较大正值，避免把 virtualizer
 * 间距锁死成 DEFAULT_ROW_HEIGHT_ESTIMATE_PX（叠字 / !EST72）。
 */
function measureRowHeight(element: Element, entry: ResizeObserverEntry | undefined): number {
  const rectH = Math.round(element.getBoundingClientRect().height);
  const boxSize = entry?.borderBoxSize?.[0];
  const entryH = boxSize ? Math.round(boxSize.blockSize) : 0;
  if (entryH > 0 && rectH > 0) return Math.max(entryH, rectH);
  if (entryH > 0) return entryH;
  return rectH;
}

function getUnitHeightCacheKey(unit: ConversationTurnRenderUnit | undefined): string | undefined {
  return unit?.key;
}

interface ConversationTimelineProps {
  rows: readonly ConversationRow[];
  /** CLI 权威 queue 中等待 model-step 注入的 guide；只改变 renderer 落位。 */
  pendingGuides?: readonly QueueItem[];
  /** runtime memory 状态，只交给当前 live turn，不进入历史虚拟列表。 */
  apiRetry?: ApiRetryState | null;
  /** 投影全序行数（rows.totalCount；窗口截断后大于 rows.length，仅用于滚动条估计/诊断）。 */
  totalCount: number;
  /**
   * 会话身份键（sessionId ?? "draft"）。切换时重置滚动锚定与测高缓存——
   * rowId 在不同 session 间会重复，测高缓存禁止跨会话串号。
   */
  sessionKey: string;
  /** renderer-local 滚动记忆 key；draft 为 null，不参与保存或恢复。 */
  scrollMemoryKey?: string | null;
  /** 行渲染上下文（theme/codePreviewSettings/workspacePath）；宿主保证引用稳定。 */
  rowContext: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onEdit?: (
    target: ConversationRowTarget,
    newText: string,
    attachments?: readonly AttachmentRef[],
    workspaceMode?: "preserve" | "rewind",
  ) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;
  /** 还有更早历史可拉（窗口首行 > 全序首行）。 */
  canLoadOlder?: boolean;
  /** loadOlder 在途，抑制重复触发。 */
  loadingOlder?: boolean;
  /** 拉取更早一窗历史（接近顶部时自动预取）。 */
  onLoadOlder?: () => Promise<void> | void;
  /** 宽屏问题目录挂载后一次补齐当前有效分支的全部历史。 */
  onLoadAllOlder?: () => Promise<ConversationTurnNavigatorHydrationResult>;
  /**
   * 问题导航目录失效代际（store turnNavigatorDirectoryRevision）。
   * real-user query 增删后终态必须失效重探测；组件 hydration key
   * 追加此 revision，避免同一 logEpoch 内永久拦截。
   */
  turnNavigatorDirectoryRevision?: number;
  /** 与旧 ChatView 对齐：composer dock 属于同一个滚动视口，sticky 到滚动容器底部。 */
  bottomDock?: ReactNode;
  /** 分享选择面板所在的共享父容器；用于把 dock 的真实位置写入同一坐标系。 */
  selectionPanelLayoutContainerRef?: { current: HTMLElement | null };
  /**
   * 锁定背景滚动。
   *
   * 分享选择面板只用 scrim 隔离了正文指针事件，滚动容器仍是 overflow-y-auto，
   * 原生滚动条拖拽和键盘 PageUp/Down 仍能改变 scrollTop，勾选目标会在面板下方漂走。
   */
  backgroundScrollLocked?: boolean;
  /** rows 为空时的可选内容；正式空 session 传空，草稿态传问候语。 */
  emptyState?: ReactNode;
  /**
   * 滚动容器内、消息层之上的常驻内容（分享导入的只读块 + 分割线）。
   *
   * 必须在容器内而不是做成固定横幅，才能与实时对话一起滚动；rows 为空时也要渲染，
   * 所以它落在 emptyState 分支之外。
   */
  headerSlot?: ReactNode;
  /** 草稿态让 emptyState 与同一个 bottomDock 作为整体居中，不重挂 composer。 */
  centerEmptyStateWithDock?: boolean;
  /** 窄屏/粗指针视口保留紧凑居中布局，不复用桌面草稿安全间距。 */
  compactEmptyStateWithDock?: boolean;
  /** 右侧状态面板对消息列的布局模式；auto 由 conversation container query 裁决。 */
  summaryPanelLayout?: "none" | "auto" | "inline";
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  sessionPhase?: SessionPhase;
  /**
   * 与右下角停止按钮同源（EvoFlow selectedTurnBusy）。
   * 末轮「工作中」齿轮跟此信号对齐，避免停按钮亮着而左下角齿轮熄灭。
   */
  sessionBusy?: boolean;
  /** 宿主可调用的一次性“滚动到底部”动作；不持有 conversation 或跨 renderer 状态。 */
  scrollToBottomActionRef?: { current: (() => void) | null };
  /** 宿主可调用的一次性 query 定位动作；不改变分享面板 view。 */
  scrollToQueryActionRef?: {
    current: ((target: { unitIndex: number; rowId: number }) => void) | null;
  };
  selectionActions?: {
    enabled: boolean;
    sideActionDisabled?: boolean;
    onAddToCurrentTask: (reference: ConversationSelectionReference) => void;
    onAskInSideChat: (reference: ConversationSelectionReference) => void;
  };
  /** 分享选择阶段的本轮勾选状态；仅桌面分享时间线传入。 */
  shareSelection?: {
    eligibleRowIds: ReadonlySet<number>;
    selectedRowIds: ReadonlySet<number>;
    onToggle: (rowId: number) => void;
  };
  /** 分享选择流程存在时，左侧 rail 由分享面板或 reopen 按钮独占。 */
  hideTurnNavigator?: boolean;
  /**
   * KeepAlive 宿主是否处于布局可见（非 display:none / 非 inert 隐藏层）。
   * false→true 时强制 virtualizer.measure()，消化隐藏期可能写入的坏测高。
   */
  layoutActive?: boolean;
}

/**
 * 虚拟滚动 timeline：动态测高（ResizeObserver 驱动 remeasure）+ 底部锚定 +
 * 「回到底部」。滚动位置/跟随态/测高缓存全部为组件实例状态——多 pane（同会话或
 * 异会话）各自独立，互不干扰；数据订阅共享经 sessionDataLayer lease 处理。
 *
 * React 性能：rows 高频变化（流式 delta），滚动相关回调全部经 ref 读取最新值，
 * 保持稳定引用；跟随态存 ref（每帧变化不触发渲染），仅「回到底部」可见性走 state。
 */
function ConversationTimelineImpl({
  rows,
  pendingGuides = EMPTY_PENDING_GUIDES,
  apiRetry = null,
  totalCount,
  sessionKey,
  scrollMemoryKey = null,
  rowContext,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  canLoadOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onLoadAllOlder,
  turnNavigatorDirectoryRevision = 0,
  bottomDock,
  selectionPanelLayoutContainerRef,
  backgroundScrollLocked = false,
  emptyState,
  headerSlot,
  centerEmptyStateWithDock = false,
  compactEmptyStateWithDock = false,
  summaryPanelLayout = "none",
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  sessionPhase,
  sessionBusy = false,
  scrollToBottomActionRef,
  scrollToQueryActionRef,
  selectionActions,
  shareSelection,
  hideTurnNavigator = false,
  layoutActive = true,
}: ConversationTimelineProps) {
  const { intl } = useZCodeIntl();
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerSlotRef = useRef<HTMLDivElement>(null);
  // headerSlot 高度参与虚拟窗口换算（scrollMargin），必须随内容与宽度变化实时跟进，
  // 否则只读块加载完成或窗口变宽换行后，虚拟行会整体错位。
  //
  // 依赖必须是「有没有 slot」而不是 headerSlot 本身：后者是 ReactNode，宿主传的是内联 JSX，
  // 每次渲染都是新对象，会让 ResizeObserver 在流式输出期间每帧重建。
  const hasHeaderSlot = Boolean(headerSlot);
  const [headerSlotHeight, setHeaderSlotHeight] = useState(0);
  useEffect(() => {
    const element = headerSlotRef.current;
    if (!element) {
      setHeaderSlotHeight(0);
      return;
    }
    const sync = () => {
      const next = element.getBoundingClientRect().height;
      setHeaderSlotHeight((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasHeaderSlot]);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  /** 乐观追加：复用上帧 units，避免整窗 rebuild（send 路径 ~300ms longtask）。 */
  const renderUnitsCacheRef = useRef<{
    rows: readonly ConversationRow[];
    liveNowMs: number;
    sessionPhase: SessionPhase | undefined;
    sessionBusy: boolean;
    units: ConversationTurnRenderUnit[];
  } | null>(null);
  const renderUnits = useMemo(() => {
    const options = { nowMs: liveNowMs, sessionPhase, sessionBusy };
    const cached = renderUnitsCacheRef.current;
    if (
      cached &&
      cached.liveNowMs === liveNowMs &&
      cached.sessionPhase === sessionPhase &&
      cached.sessionBusy === sessionBusy &&
      cached.rows !== rows
    ) {
      const appended = tryAppendTrailingUserInputUnit(cached.units, cached.rows, rows, options);
      if (appended) {
        renderUnitsCacheRef.current = {
          rows,
          liveNowMs,
          sessionPhase,
          sessionBusy,
          units: appended,
        };
        return appended;
      }
    }
    const built = buildConversationTurnRenderUnits(rows, options);
    renderUnitsCacheRef.current = { rows, liveNowMs, sessionPhase, sessionBusy, units: built };
    return built;
  }, [liveNowMs, rows, sessionBusy, sessionPhase]);
  const { virtualizedUnits, liveUnit, liveUnitIndex } = useMemo(
    () => splitConversationTimelineLiveTail(renderUnits),
    [renderUnits],
  );
  // 「已工作」折叠乱套时打 fold_anomaly，避免再靠截图肉眼猜。
  const foldHealthSigRef = useRef("");
  useEffect(() => {
    const report = inspectConversationTurnFoldHealth(renderUnits);
    if (report.ok) {
      foldHealthSigRef.current = "";
      return;
    }
    if (foldHealthSigRef.current === report.signature) return;
    foldHealthSigRef.current = report.signature;
    logV4Life({
      event: "fold_anomaly",
      level: "warn",
      threadId: rowContext.sessionId,
      zh: `时间线折叠异常：${summarizeFoldHealthFindings(report.findings)}`,
      detail: {
        findings: report.findings,
        unitCount: renderUnits.length,
        running: renderUnits.some((u) => u.isRunning),
      },
      skipDedupe: true,
    });
  }, [renderUnits, rowContext.sessionId]);
  const hasRunningUnit = useMemo(() => renderUnits.some((unit) => unit.isRunning), [renderUnits]);
  const turnNavigatorQueryRowIds = useMemo(
    () =>
      new Set(
        renderUnits.flatMap((unit) =>
          unit.visibleUserInputs.filter((row) => row.origin === "realUser").map((row) => row.rowId),
        ),
      ),
    [renderUnits],
  );
  const turnNavigatorQueryRowIdsRef = useRef(turnNavigatorQueryRowIds);
  turnNavigatorQueryRowIdsRef.current = turnNavigatorQueryRowIds;
  const centeredEmptyLayout = centerEmptyStateWithDock && renderUnits.length === 0;
  const responsiveCenteredEmptyLayout = centeredEmptyLayout && !compactEmptyStateWithDock;
  // 高频值经 ref 供稳定回调读取（不进依赖数组）。
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const unitsRef = useRef(renderUnits);
  unitsRef.current = renderUnits;
  const virtualizedUnitsRef = useRef(virtualizedUnits);
  virtualizedUnitsRef.current = virtualizedUnits;
  const liveTailRef = useRef<HTMLDivElement>(null);
  const messageLayerRef = useRef<HTMLDivElement>(null);
  const virtualHistoryRef = useRef<HTMLDivElement>(null);
  const stableContentWidthRef = useRef<number | null>(null);
  const contentWidthResizeActiveRef = useRef(false);
  const contentWidthResizeSettleTimerRef = useRef<number | null>(null);
  const committingMeasuredLayoutRef = useRef(false);
  const contentMeasurementPendingRef = useRef(false);
  const messageLayerMaskObserverRef = useRef<ResizeObserver | null>(null);
  const isContentWidthChanging = useCallback(() => {
    const currentContentWidth = virtualHistoryRef.current?.clientWidth ?? null;
    const stableContentWidth = stableContentWidthRef.current;
    return (
      committingMeasuredLayoutRef.current ||
      contentWidthResizeActiveRef.current ||
      (currentContentWidth !== null &&
        stableContentWidth !== null &&
        currentContentWidth !== stableContentWidth)
    );
  }, []);
  // loadOlder 相关值经 ref 读取，保持 handleScroll 稳定引用。
  const loadOlderRef = useRef({ canLoadOlder, loadingOlder, onLoadOlder });
  loadOlderRef.current = { canLoadOlder, loadingOlder, onLoadOlder };
  const followingRef = useRef(initialFollowing());
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const userScrollIntentRef = useRef<{
    intent: TimelineUserScrollIntent;
    observedAt: number;
  }>({ intent: "none", observedAt: 0 });
  const touchClientYRef = useRef<number | null>(null);
  const scrollbarPointerIdRef = useRef<number | null>(null);
  const layoutScrollGuardUntilRef = useRef(0);
  const userAdjustedScrollSinceRestoreRef = useRef(false);
  const suppressVirtualizerAdjustmentDuringRestoreRef = useRef(false);
  const latestScrollMemoryStateRef = useRef<{
    key: string;
    state: ChatSessionScrollMemoryState;
  } | null>(null);
  const pendingDetachedScrollRestoreRef = useRef<PendingScrollMemoryRestore | null>(null);
  // 组件「已账目」的 scrollTop——scroll 事件读取值或组件自身
  // 程序化写入（贴底/prepend 平移）后的回读值。贴底 effect 拿它对账未观察滚动
  // （滚动已发生、scroll 事件未派发），防止过期 following=true 把用户/测试的上滚拽回底部。
  const lastObservedScrollTopRef = useRef(0);
  // prepend 锚定基线（上一 commit 的首行/总高度），见下方对账效应。
  const prependAnchorRef = useRef<{
    firstRowId: number | null;
    totalSize: number;
  }>({ firstRowId: null, totalSize: 0 });
  const pendingPrependVirtualAnchorRef = useRef<PrependVirtualAnchor | null>(null);
  const heightCacheRef = useRef<TimelineRowHeightCache | null>(null);
  if (heightCacheRef.current === null) {
    heightCacheRef.current = new TimelineRowHeightCache();
  }
  const [backToBottomVisible, setBackToBottomVisible] = useState(false);
  const [turnNavigatorViewport, setTurnNavigatorViewport] = useState({
    scrollOffsetPx: 0,
    viewportHeightPx: 0,
    activeQueryRowId: undefined as number | undefined,
  });
  const [turnNavigatorContainerWidthPx, setTurnNavigatorContainerWidthPx] = useState(0);
  const turnNavigatorJumpFrameRef = useRef<number | null>(null);
  const turnNavigatorHydrationAttemptRef = useRef<{
    attemptCount: number;
    key: string | null;
    retryTimer: number | null;
    status: "idle" | "in-flight" | "waiting" | "terminal";
  }>({ attemptCount: 0, key: null, retryTimer: null, status: "idle" });
  const [turnNavigatorHydrationRetryRevision, setTurnNavigatorHydrationRetryRevision] = useState(0);
  const timelineRootRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const shareSelectionPanelLayoutRef = useRef<{
    centerYPx: number;
    maxHeightPx: number;
  } | null>(null);
  // 右侧状态面板完整 inline 展开时，中间消息列和输入 dock 必须使用同一偏移；
  // 否则面板会覆盖正文，而不是并排布局。
  const summaryPanelInlineOffsetClassName =
    getConversationStatusPanelOffsetClassName(summaryPanelLayout);
  const contentWidthClassName = getConversationContentWidthClassName({
    centeredEmptyLayout,
    statusPanelLayout: summaryPanelLayout,
  });

  const syncShareSelectionPanelLayout = useCallback(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    // 选择面板是 SessionPane 的兄弟节点，不能把 CSS 变量写在 Timeline
    // 自身，否则面板拿不到 dock 的真实边界；统一写入共享父容器供两者使用。
    const layout = syncConversationShareSelectionPanelLayout(container, dock);
    const previous = shareSelectionPanelLayoutRef.current;
    if (previous?.centerYPx === layout.centerYPx && previous.maxHeightPx === layout.maxHeightPx) {
      return;
    }
    shareSelectionPanelLayoutRef.current = layout;
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef]);

  useLayoutEffect(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    syncShareSelectionPanelLayout();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(syncShareSelectionPanelLayout);
      resizeObserver.observe(container);
      resizeObserver.observe(timelineRootRef.current ?? container);
      if (scrollRef.current) {
        resizeObserver.observe(scrollRef.current);
      }
      resizeObserver.observe(dock);
    }

    // ResizeObserver 在部分 Electron flex 布局中可能晚于窗口尺寸变化回调，
    // 因此窗口 resize 也始终触发一次几何同步，保证面板随窗口放大/缩小。
    window.addEventListener("resize", syncShareSelectionPanelLayout);
    return () => {
      window.removeEventListener("resize", syncShareSelectionPanelLayout);
      resizeObserver?.disconnect();
    };
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef, syncShareSelectionPanelLayout]);

  // 上滚抖动诊断必须挂在日常滚动层上（以前误挂在分享选区锁定分支，普通聊天永远无日志）。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    attachScrollJitterDiag(el);
    return () => detachScrollJitterDiag(el);
  }, [sessionKey]);

  useEffect(() => {
    if (!hasRunningUnit) {
      return;
    }

    // 运行中的 assistant work 状态文案要显示“工作中 N 秒”并随时间推进；
    // 完成态耗时由协议事实固定，builder 会拒绝把这个 UI 时钟用于已结束轮次。
    setLiveNowMs(Date.now());
    const timer = window.setInterval(() => {
      setLiveNowMs(Date.now());
    }, RUNNING_WORK_DURATION_TICK_MS);

    return () => window.clearInterval(timer);
  }, [hasRunningUnit]);

  useLayoutEffect(() => {
    const element = timelineRootRef.current;
    if (!element) return;

    // rail 改由 CSS container query 隐藏后，完整历史补拉失去了同一宽度
    // 资格边界，手机远控与窄分屏也会请求全部 rows。这里仅同步只读分页资格；
    // rail 的显隐、占位与过渡仍完全由 CSS 裁决，不恢复 composer 几何测量。
    const commitWidth = (width: number) => {
      const normalizedWidth = Math.max(0, Math.round(width));
      setTurnNavigatorContainerWidthPx((current) =>
        current === normalizedWidth ? current : normalizedWidth,
      );
    };
    const readWidth = () => commitWidth(element.clientWidth);
    readWidth();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        const borderBox = entry?.borderBoxSize?.[0];
        commitWidth(borderBox?.inlineSize ?? entry?.contentRect.width ?? element.clientWidth);
      });
      observer.observe(element);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", readWidth);
    return () => window.removeEventListener("resize", readWidth);
  }, []);

  useEffect(() => {
    if (
      !shouldHydrateConversationTurnNavigatorDirectory({
        canLoadOlder,
        containerWidthPx: turnNavigatorContainerWidthPx,
        hasLoadHandler: Boolean(onLoadAllOlder),
        loadingOlder,
      })
    ) {
      return;
    }
    // terminal key 必须与 store turnNavigatorDirectoryRevision 同步。
    // 仅用 sessionKey + logEpoch 时，real-user query 增删不换 epoch，
    // 组件层 terminal 永久拦截，store 即使失效缓存也无法重新探测。
    const hydrationKey = `${sessionKey}:${rowContext.logEpoch ?? "unknown"}:${turnNavigatorDirectoryRevision}`;
    const attempt = turnNavigatorHydrationAttemptRef.current;
    if (attempt.key !== hydrationKey) {
      if (attempt.retryTimer !== null) window.clearTimeout(attempt.retryTimer);
      Object.assign(attempt, {
        attemptCount: 0,
        key: hydrationKey,
        retryTimer: null,
        status: "idle" as const,
      });
    }
    if (attempt.status !== "idle" || !onLoadAllOlder) return;
    attempt.status = "in-flight";
    logger.debug("[v4-turn-navigator] 目录请求补齐完整历史", {
      attempt: attempt.attemptCount + 1,
      loadedRows: rows.length,
      sessionKey,
      totalRows: totalCount,
    });
    void onLoadAllOlder().then((result) => {
      if (attempt.key !== hydrationKey) return;
      if (result.status === "hydrated" || result.status === "not-enough-queries") {
        attempt.status = "terminal";
        return;
      }
      if (result.status === "stale") {
        attempt.status = "idle";
        return;
      }
      attempt.attemptCount += 1;
      const retryDelayMs = resolveConversationTurnNavigatorHydrationRetryDelayMs(
        attempt.attemptCount,
      );
      if (retryDelayMs === null) {
        attempt.status = "terminal";
        return;
      }
      attempt.status = "waiting";
      attempt.retryTimer = window.setTimeout(() => {
        if (attempt.key !== hydrationKey) return;
        attempt.retryTimer = null;
        attempt.status = "idle";
        setTurnNavigatorHydrationRetryRevision((revision) => revision + 1);
      }, retryDelayMs);
    });
  }, [
    canLoadOlder,
    loadingOlder,
    onLoadAllOlder,
    rowContext.logEpoch,
    rows,
    sessionKey,
    totalCount,
    turnNavigatorContainerWidthPx,
    turnNavigatorDirectoryRevision,
    turnNavigatorHydrationRetryRevision,
  ]);

  useEffect(
    () => () => {
      const timer = turnNavigatorHydrationAttemptRef.current.retryTimer;
      if (timer !== null) window.clearTimeout(timer);
    },
    [],
  );

  const getScrollElement = useCallback(() => scrollRef.current, []);
  const getItemKey = useCallback(
    (index: number) => virtualizedUnitsRef.current[index]?.key ?? index,
    [],
  );
  // 测高缓存兜底：行卸载重挂（甚至 virtualizer 重建）时用上次真实测量代替固定估计。
  const estimateSize = useCallback(
    (index: number) =>
      heightCacheRef.current?.estimate(
        getUnitHeightCacheKey(virtualizedUnitsRef.current[index]),
        DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
      ) ?? DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
    [],
  );
  const layoutActiveRef = useRef(layoutActive);
  layoutActiveRef.current = layoutActive;

  // KeepAlive 切回可见后短暂窗口：宁可信更大几何，也不吃 ≈72 的毒测高。
  const remountMeasureGuardUntilRef = useRef(0);
  /** KeepAlive 切回可见后贴底；在 scrollToBottom 定义后写入，供上方 layout effect 调用。 */
  const becomeVisibleFollowBottomRef = useRef<(() => void) | null>(null);
  // 动态测高：virtualizer 对窗口内元素挂 ResizeObserver，流式行长高即回调此处；
  // 同时把真实高度写入稳定的 turnId 缓存。
  // visibility:hidden 时几何仍有效（CDP 实证：正文高 1324 但间距锁 72）。
  // 隐藏期只拒绝 0，绝不把有效测高丢弃成 DEFAULT 72。
  const measureElement = useCallback((element: Element, entry: ResizeObserverEntry | undefined) => {
    const indexAttr = element.getAttribute("data-index");
    const unit = indexAttr === null ? undefined : virtualizedUnitsRef.current[Number(indexAttr)];
    const cacheKey = getUnitHeightCacheKey(unit);
    const cached =
      cacheKey !== undefined ? heightCacheRef.current?.get(cacheKey) : undefined;

    const height = measureRowHeight(element, entry);
    if (height <= 0) {
      // 仅 0/不可用时回落缓存或估高（display:none 残留路径）。
      if (cached && cached > 0) return cached;
      return (
        heightCacheRef.current?.estimate(
          cacheKey,
          DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
        ) ?? DEFAULT_ROW_HEIGHT_ESTIMATE_PX
      );
    }
    // 毒测高：≈72 且远小于已有真实缓存——永远信缓存（不限显隐窗口）。
    // 浮层实证：可见滚动时也会 gap→72 而 DOM h=383。
    const looksLikeEstimate =
      height <= DEFAULT_ROW_HEIGHT_ESTIMATE_PX + 8 &&
      !!cached &&
      cached > DEFAULT_ROW_HEIGHT_ESTIMATE_PX * 2 &&
      height < cached * 0.5;
    const resolved = looksLikeEstimate && cached ? cached : height;

    if (cacheKey !== undefined) {
      heightCacheRef.current?.set(cacheKey, resolved);
    }
    return resolved;
  }, []);

  const [measuredLayoutRevision, commitMeasuredLayout] = useState(0);
  const virtualizer = useVirtualizer({
    count: virtualizedUnits.length,
    getScrollElement,
    estimateSize,
    overscan: ROW_OVERSCAN,
    getItemKey,
    measureElement,
    // headerSlot（分享导入的只读块）与虚拟列表同处一个滚动容器，
    // 且高度可观。不告知这段偏移，虚拟窗口会按 scrollTop 直接索引 item，
    // 渲染窗口整体偏移一个 header 高度，用户滚到的区域会是空白。
    scrollMargin: headerSlotHeight,
  });

  // 思考行显隐会显著改变 turn 高度。缓存仍按 turnId 键控，不带 reasoning 布局 epoch——
  // 开启「显示思考过程」后若沿用旧矮缓存，上滚历史会估矮→假贴底→跳回最新。
  const showReasoningLayout = rowContext.messageStreamShowReasoning === true;
  const prevShowReasoningLayoutRef = useRef(showReasoningLayout);
  useLayoutEffect(() => {
    if (prevShowReasoningLayoutRef.current === showReasoningLayout) return;
    prevShowReasoningLayoutRef.current = showReasoningLayout;
    heightCacheRef.current?.clear();
    virtualizer.measure();
  }, [showReasoningLayout, virtualizer]);

  const prevLayoutActiveRef = useRef(layoutActive);
  // KeepAlive 切回可见：heal 低估高度；跟底/guard 在下方 scrollToBottom 定义后再挂（避免 TDZ）。
  useLayoutEffect(() => {
    const wasActive = prevLayoutActiveRef.current;
    prevLayoutActiveRef.current = layoutActive;
    if (!wasActive && layoutActive) {
      remountMeasureGuardUntilRef.current = performance.now() + 450;
      layoutScrollGuardUntilRef.current = Date.now() + 450;
      const cache = heightCacheRef.current;
      const units = virtualizedUnitsRef.current;
      const root = scrollRef.current;
      const domHeights = new Map<number, number>();
      if (root) {
        root.querySelectorAll("[data-v4-turn-unit][data-index]").forEach((node) => {
          const idx = Number((node as HTMLElement).getAttribute("data-index"));
          if (!Number.isFinite(idx)) return;
          const h = Math.round((node as HTMLElement).getBoundingClientRect().height);
          if (h > DEFAULT_ROW_HEIGHT_ESTIMATE_PX) domHeights.set(idx, h);
        });
      }
      for (let i = 0; i < units.length; i++) {
        const key = getUnitHeightCacheKey(units[i]);
        const dom = domHeights.get(i);
        const cached = key !== undefined ? cache?.get(key) : undefined;
        const size = Math.max(dom ?? 0, cached ?? 0);
        if (size > DEFAULT_ROW_HEIGHT_ESTIMATE_PX) {
          if (key !== undefined) cache?.set(key, size);
          virtualizer.resizeItem(i, size);
        }
      }
      // 仅在「仍跟随 / 记忆贴底」时首帧恢复跟底；用户已明确上滚则不得用陈旧
      // wasPinnedToBottom 把历史拽回底部。此处直接读 intent ref（getActiveUserScrollIntent
      // 声明在后，layout effect 依赖里引用会 TDZ）。
      const intentObserved = userScrollIntentRef.current;
      const awayIntent =
        intentObserved.intent === "awayFromBottom" &&
        Date.now() - intentObserved.observedAt <= USER_SCROLL_INTENT_TTL_MS;
      const memoryPinned =
        !awayIntent &&
        !!scrollMemoryKey &&
        readChatSessionScrollMemoryState(scrollMemoryKey)?.wasPinnedToBottom === true;
      if (!awayIntent && (followingRef.current || memoryPinned)) {
        if (!followingRef.current) {
          followingRef.current = true;
          setBackToBottomVisible(false);
        }
        becomeVisibleFollowBottomRef.current?.();
      }
      let cancelled = false;
      let raf2 = 0;
      const raf1 = window.requestAnimationFrame(() => {
        raf2 = window.requestAnimationFrame(() => {
          if (cancelled) return;
          virtualizer.measure();
          layoutScrollGuardUntilRef.current = Date.now() + LAYOUT_SCROLL_GUARD_MS;
          const later = userScrollIntentRef.current;
          const laterAway =
            later.intent === "awayFromBottom" &&
            Date.now() - later.observedAt <= USER_SCROLL_INTENT_TTL_MS;
          if (followingRef.current && !laterAway) {
            becomeVisibleFollowBottomRef.current?.();
          }
        });
      });
      return () => {
        cancelled = true;
        window.cancelAnimationFrame(raf1);
        if (raf2) window.cancelAnimationFrame(raf2);
      };
    }
    return undefined;
  }, [layoutActive, virtualizer, scrollMemoryKey]);

  // 可见态持续 heal：浮层已实证「DOM h=383 但 gap→72」——virtualizer 仍信估高，
  // 仅靠 RO/切会话 heal 不够。挂载行若 rect 明显大于当前 size，强制 resizeItem。
  // 批测高在途时让位 ZCode 同步提交路径，避免上滚/流式帧里与 stickToBottom 互抢。
  const healMountedTurnHeights = useCallback(() => {
    if (!layoutActiveRef.current) return 0;
    if (contentMeasurementPendingRef.current || committingMeasuredLayoutRef.current) return 0;
    const root = scrollRef.current;
    if (!root) return 0;
    const cache = heightCacheRef.current;
    const units = virtualizedUnitsRef.current;
    const virtualItems = virtualizer.getVirtualItems();
    const sizeByIndex = new Map<number, number>();
    for (const item of virtualItems) sizeByIndex.set(item.index, item.size);
    let fixed = 0;
    root.querySelectorAll("[data-v4-turn-unit][data-index]").forEach((node) => {
      const el = node as HTMLElement;
      // live tail 不在 virtualizer 测高账本里，跳过。
      if (el.getAttribute("data-v4-running-live-tail") === "true") return;
      const idx = Number(el.getAttribute("data-index"));
      if (!Number.isFinite(idx) || idx < 0 || idx >= units.length) return;
      const domH = Math.round(el.getBoundingClientRect().height);
      if (domH <= DEFAULT_ROW_HEIGHT_ESTIMATE_PX) return;
      const current = sizeByIndex.get(idx) ?? 0;
      if (domH <= current + 24) return;
      const key = getUnitHeightCacheKey(units[idx]);
      if (key !== undefined) cache?.set(key, domH);
      virtualizer.resizeItem(idx, domH);
      fixed += 1;
    });
    return fixed;
  }, [virtualizer]);

  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
    const adjust = shouldAdjustVirtualizerForItemSizeChange({
      // 前插批次由下方 prepend 锚点统一补偿；逐行测高再补一次会把阅读位置推到底部。
      suppressAdjustment:
        suppressVirtualizerAdjustmentDuringRestoreRef.current ||
        (contentMeasurementPendingRef.current &&
          prependAnchorRef.current.firstRowId !== null &&
          (rowsRef.current[0]?.rowId ?? Infinity) < prependAnchorRef.current.firstRowId),
      following: followingRef.current,
      contentWidthChanging: isContentWidthChanging(),
      itemEnd: item.end,
      // 同批 RO 的 item 坐标尚未重算，原生 scrollTop 已含前一行补偿；混用会把目标之后
      // 的行也判为视口上方。比较 virtualizer 同一测量批次的偏移，再由原生 scroll 入账。
      scrollTop: virtualizer.scrollOffset ?? scrollRef.current?.scrollTop ?? 0,
    });
    if (adjust) recordScrollWrite("virtualizerItemSizeAdjust", scrollRef.current);
    return adjust;
  };
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const turnNavigatorVirtualItems: ConversationTurnNavigatorVirtualItem[] = useMemo(() => {
    const historyItems = virtualRows.map((row) => ({
      index: row.index,
      size: row.size,
      start: row.start,
    }));
    if (liveUnitIndex === null) return historyItems;
    return [
      ...historyItems,
      {
        index: liveUnitIndex,
        start: totalSize,
        // live tail 不参与 virtualizer 测高；覆盖剩余滚动区即可供目录判定当前轮次。
        size: Number.MAX_SAFE_INTEGER - totalSize,
      },
    ];
  }, [liveUnitIndex, totalSize, virtualRows]);
  const mountedRowsKey = useMemo(
    () =>
      [
        measuredLayoutRevision,
        ...virtualRows.map((row) => `${row.key}:${row.start}:${row.size}`),
        ...(liveUnit === null ? [] : [String(liveUnit.key)]),
      ].join(":"),
    [liveUnit, measuredLayoutRevision, virtualRows],
  );

  useLayoutEffect(() => {
    if (!layoutActive) return;
    healMountedTurnHeights();
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      healMountedTurnHeights();
      raf2 = window.requestAnimationFrame(() => {
        healMountedTurnHeights();
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
    };
  }, [layoutActive, mountedRowsKey, totalSize, healMountedTurnHeights]);

  useEffect(() => {
    if (!layoutActive) return;
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    // 跟底时流式/测高会持续变高，滚动中补一次 heal 即可。
    // 离底上滚时禁止 scroll 联动 heal：每帧 resizeItem + 逐行补偿会把阅读位置推飞。
    const onScroll = () => {
      if (!followingRef.current) return;
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        healMountedTurnHeights();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // 周期 heal 只在跟底时跑；离底靠 batch measure + 切回可见 heal 纠偏。
    const timer = window.setInterval(() => {
      if (!followingRef.current) return;
      healMountedTurnHeights();
    }, 1000);
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
      window.clearInterval(timer);
    };
  }, [layoutActive, healMountedTurnHeights, sessionKey]);


  const markProgrammaticScroll = useCallback(() => {
    if (programmaticScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(programmaticScrollFrameRef.current);
    }
    programmaticScrollFrameRef.current = window.requestAnimationFrame(() => {
      programmaticScrollFrameRef.current = null;
    });
  }, []);

  const commitFollowing = useCallback((following: boolean) => {
    if (followingRef.current === following) return;
    followingRef.current = following;
    setBackToBottomVisible(shouldShowBackToBottom(following, unitsRef.current.length));
  }, []);

  const clearUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = { intent: "none", observedAt: 0 };
    touchClientYRef.current = null;
    scrollbarPointerIdRef.current = null;
  }, []);

  const getActiveUserScrollIntent = useCallback((): TimelineUserScrollIntent => {
    const current = userScrollIntentRef.current;
    const interactionActive =
      touchClientYRef.current !== null || scrollbarPointerIdRef.current !== null;
    if (interactionActive) {
      return current.intent === "none" ? "unknown" : current.intent;
    }
    return Date.now() - current.observedAt <= USER_SCROLL_INTENT_TTL_MS ? current.intent : "none";
  }, []);

  const markLayoutScrollGuard = useCallback(() => {
    layoutScrollGuardUntilRef.current = Date.now() + LAYOUT_SCROLL_GUARD_MS;
  }, []);

  const markUserScrollIntent = useCallback(
    (intent: TimelineUserScrollIntent) => {
      if (intent === "none") return;
      userScrollIntentRef.current = { intent, observedAt: Date.now() };
      // running -> terminal 会在同一帧迁移 live tail、折叠工作历史并触发
      // virtualizer 测高。向上滚动必须在 scroll 事件之前先拿走滚动权，否则终态
      // layout effect 会拿过期的 following=true 把用户重新拽到底部。
      //
      // 不要再要求 scrollHeight>clientHeight：行高估矮（如思考行显隐变化后缓存偏小）
      // 时内容「看似」不足一屏，条件失败 → following 粘死 → 只能看见最新、上滚像跳。
      if (intent === "awayFromBottom") {
        commitFollowing(false);
        userAdjustedScrollSinceRestoreRef.current = true;
      }
    },
    [commitFollowing],
  );

  /**
   * 预取更早行。scroll 与「到顶继续上滚」的 wheel 共用：几何顶 scrollTop=0 时
   * 继续 wheel 不再产生 scroll 事件，只靠 onScroll 会永远卡住（轨迹 auto=1 /
   * loading=0 / winFirst 不前进）。
   */
  const tryLoadOlderNearTop = useCallback((element: HTMLDivElement, following: boolean) => {
    const loadOlder = loadOlderRef.current;
    const triggerPx = historyPrefetchTriggerPx(element.clientHeight);
    if (
      !shouldTriggerLoadOlder({
        scrollTop: element.scrollTop,
        canLoadOlder: loadOlder.canLoadOlder,
        loadingOlder: loadOlder.loadingOlder,
        triggerPx,
        following,
      })
    ) {
      return false;
    }
    const anchorMeasurement = virtualizer.getVirtualItemForOffset(element.scrollTop);
    const anchorUnit = anchorMeasurement
      ? virtualizedUnitsRef.current[anchorMeasurement.index]
      : undefined;
    pendingPrependVirtualAnchorRef.current =
      anchorMeasurement && anchorUnit?.key === anchorMeasurement.key
        ? {
            key: anchorUnit.key,
            offsetTop: anchorMeasurement.start - element.scrollTop,
            start: anchorMeasurement.start,
          }
        : null;
    logger.debug("[v4-timeline] 接近历史窗口顶部，自动预取更早行", {
      scrollTop: element.scrollTop,
      triggerPx,
    });
    void loadOlder.onLoadOlder?.();
    return true;
  }, [virtualizer]);

  const handleWheelCapture = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      const intent = timelineWheelScrollIntent(event.deltaY);
      markUserScrollIntent(intent);
      // 到顶后继续上滚：没有 scroll Δ，必须在 wheel 上补一次 loadOlder。
      if (intent !== "awayFromBottom") return;
      const element = scrollRef.current;
      if (!element) return;
      tryLoadOlderNearTop(element, false);
    },
    [markUserScrollIntent, tryLoadOlderNearTop],
  );

  const handleTouchStartCapture = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    touchClientYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMoveCapture = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const nextClientY = event.touches[0]?.clientY;
      const previousClientY = touchClientYRef.current;
      if (nextClientY === undefined || previousClientY === null) return;
      markUserScrollIntent(timelineTouchScrollIntent(previousClientY, nextClientY));
      touchClientYRef.current = nextClientY;
    },
    [markUserScrollIntent],
  );

  const handleTouchEndCapture = useCallback(() => {
    touchClientYRef.current = null;
  }, []);

  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      markUserScrollIntent(
        timelineKeyboardScrollIntent({
          key: event.key,
          shiftKey: event.shiftKey,
          editableTarget: isEditableScrollTarget(event.target),
        }),
      );
    },
    [markUserScrollIntent],
  );

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 内容区点击（尤其 composer 发送）不是滚动意图；只有 scrollbar/空白命中
      // scroll container 自身时才登记未知方向，随后由真实 scroll 落点裁决。
      if (event.target !== event.currentTarget) return;
      scrollbarPointerIdRef.current = event.pointerId;
      markUserScrollIntent("unknown");
    },
    [markUserScrollIntent],
  );

  const handlePointerEndCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrollbarPointerIdRef.current === event.pointerId) {
      scrollbarPointerIdRef.current = null;
    }
  }, []);

  const syncMessageLayerMask = useCallback(
    (element: HTMLDivElement) => {
      const messageLayer = messageLayerRef.current;
      if (!messageLayer) return;

      if (
        isAtBottom({
          scrollTop: element.scrollTop,
          viewportHeight: element.clientHeight,
          contentHeight: element.scrollHeight,
        })
      ) {
        // 贴底时消息已经位于正常文档流末尾，不会经过 sticky composer；
        // 继续保留 mask 会无意义地淡出最后一条消息，只有离底滚动时才需要遮罩。
        messageLayer.style.maskImage = "none";
        messageLayer.style.webkitMaskImage = "none";
        return;
      }

      // 有 sticky bottomDock：按 composer 高度留透明带；无 dock（EvoFlow 外置稳定槽）
      // 只留很短底边淡出，避免输入框上方一大块空白阴影。
      const transparentHeightPx = bottomDock
        ? COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX
        : COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_EXTERNAL_PX;
      const fadePx = bottomDock
        ? COMPOSER_MESSAGE_MASK_FADE_PX
        : Math.min(COMPOSER_MESSAGE_MASK_FADE_PX, 12);

      const viewportHeight = element.clientHeight;
      const transparentStart = Math.max(0, viewportHeight - transparentHeightPx);
      const opaqueEnd = Math.max(0, transparentStart - fadePx);
      const viewportTopInLayer = Math.max(0, element.scrollTop - messageLayer.offsetTop);
      const maskImage = `linear-gradient(to bottom, black 0, black ${opaqueEnd}px, transparent ${transparentStart}px, transparent 100%)`;

      // dock 的透明 padding 能保留分屏 focus ring，但消息会从留白透出；
      // mask 必须随 scroll viewport 对齐且只裁消息层，不能裁掉 sticky composer 与按钮。
      messageLayer.style.maskImage = maskImage;
      messageLayer.style.webkitMaskImage = maskImage;
      messageLayer.style.maskPosition = `0 ${viewportTopInLayer}px`;
      messageLayer.style.webkitMaskPosition = `0 ${viewportTopInLayer}px`;
      messageLayer.style.maskSize = `100% ${viewportHeight}px`;
      messageLayer.style.webkitMaskSize = `100% ${viewportHeight}px`;
    },
    [bottomDock],
  );

  const syncTurnNavigatorViewport = useCallback(
    (element: HTMLDivElement) => {
      syncMessageLayerMask(element);
      const viewportRect = element.getBoundingClientRect();
      const queryPositions: ConversationTurnNavigatorQueryPosition[] = [];
      for (const rowElement of element.querySelectorAll<HTMLElement>("[data-row-id]")) {
        const rowId = Number(rowElement.dataset.rowId);
        if (!Number.isSafeInteger(rowId) || !turnNavigatorQueryRowIdsRef.current.has(rowId)) {
          continue;
        }
        const rowRect = rowElement.getBoundingClientRect();
        const start = element.scrollTop + rowRect.top - viewportRect.top;
        queryPositions.push({ rowId, start, end: start + rowRect.height });
      }
      const nextViewport = {
        scrollOffsetPx: element.scrollTop,
        viewportHeightPx: element.clientHeight,
        // turn 级 active 只能命中同 turn 的第一条 query。这里从已挂载
        // 的稳定 row anchor 推导当前 query；虚拟 turn 尚未挂载时组件再回退 unit。
        activeQueryRowId: resolveConversationTurnNavigatorActiveQueryRowId({
          positions: queryPositions,
          scrollOffsetPx: element.scrollTop,
          viewportHeightPx: element.clientHeight,
        }),
      };
      setTurnNavigatorViewport((current) =>
        current.scrollOffsetPx === nextViewport.scrollOffsetPx &&
        current.viewportHeightPx === nextViewport.viewportHeightPx &&
        current.activeQueryRowId === nextViewport.activeQueryRowId
          ? current
          : nextViewport,
      );
    },
    [syncMessageLayerMask],
  );

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    const messageLayer = messageLayerRef.current;
    if (!scrollElement || !messageLayer) return;

    const sync = () => syncMessageLayerMask(scrollElement);
    sync();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(sync);
      messageLayerMaskObserverRef.current = observer;
      observer.observe(scrollElement);
      observer.observe(messageLayer);
      return () => {
        observer.disconnect();
        if (messageLayerMaskObserverRef.current === observer) {
          messageLayerMaskObserverRef.current = null;
        }
      };
    }

    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [syncMessageLayerMask, renderUnits.length === 0]);

  const buildCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const metrics = {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      };
      const wasPinnedToBottom = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics,
        lastObservedScrollTop: lastObservedScrollTopRef.current,
      });
      return {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        wasPinnedToBottom,
        updatedAt: Date.now(),
      };
    },
    [],
  );

  const cacheCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const state = buildCurrentScrollMemoryState(element);
      if (scrollMemoryKey) {
        latestScrollMemoryStateRef.current = { key: scrollMemoryKey, state };
      }
      return state;
    },
    [buildCurrentScrollMemoryState, scrollMemoryKey],
  );

  const notifyScrollObserversAfterCommit = useCallback((element: HTMLDivElement) => {
    scheduleMicrotask(() => {
      if (scrollRef.current !== element) return;
      element.dispatchEvent(new Event("scroll"));
    });
  }, []);

  const captureScrollMemoryBeforeScopeMutation = useCallback(
    (previousKey: string | null): ConversationScrollMemoryScopeSnapshot | null => {
      const pendingRestore = pendingDetachedScrollRestoreRef.current;
      if (pendingRestore?.key === previousKey) {
        // 会话数据尚未到达时 DOM 只能读到被钳制的 scrollTop=0；此时切换
        // 任务不能用空时间线覆盖原记忆，必须保留尚未落地的 detached 恢复意图。
        return pendingRestore;
      }
      const element = scrollRef.current;
      if (!previousKey || !element) return null;
      return {
        key: previousKey,
        state: buildCurrentScrollMemoryState(element),
      };
    },
    [buildCurrentScrollMemoryState],
  );

  const commitCapturedScrollMemory = useCallback(
    (snapshot: ConversationScrollMemoryScopeSnapshot | null) => {
      if (!snapshot) return;
      latestScrollMemoryStateRef.current = snapshot;
      saveChatSessionScrollMemoryState(snapshot.key, snapshot.state);
    },
    [],
  );

  // 贴底必须 instant（scrollTop 赋值）：smooth 的中间帧会被 scroll 判定误读为「离底」。
  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    markProgrammaticScroll();
    // 草稿安全居中允许内容在低高度下向下溢出；若沿用真实会话吸底，
    // 顶部安全留白会被滚走。草稿始终展示顶部，真实会话继续吸底。
    recordScrollWrite("scrollToBottom", element);
    element.scrollTop = responsiveCenteredEmptyLayout ? 0 : element.scrollHeight;
    // 回读取钳制后的落点入账（浏览器会把赋值钳到最大可滚动距离）。
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    userAdjustedScrollSinceRestoreRef.current = false;
    cacheCurrentScrollMemoryState(element);
    notifyScrollObserversAfterCommit(element);
  }, [
    cacheCurrentScrollMemoryState,
    responsiveCenteredEmptyLayout,
    markProgrammaticScroll,
    notifyScrollObserversAfterCommit,
    syncTurnNavigatorViewport,
  ]);

  // KeepAlive 切回贴底：只在 following 仍成立时执行。
  // 禁止读陈旧 wasPinnedToBottom 再 commitFollowing(true)——用户上滚看历史后
  // rAF/measure 会把人拽回底部，表现为「往上滚历史不显示」。
  becomeVisibleFollowBottomRef.current = () => {
    if (!followingRef.current) return;
    if (userAdjustedScrollSinceRestoreRef.current) return;
    markLayoutScrollGuard();
    commitFollowing(true);
    scrollToBottom();
  };

  useLayoutEffect(() => {
    const contentColumn = virtualHistoryRef.current;
    if (!contentColumn || typeof ResizeObserver === "undefined") return;

    stableContentWidthRef.current = contentColumn.clientWidth;
    let observedViewportHeight = scrollRef.current?.clientHeight ?? 0;
    let observeContentFrame: number | null = null;
    let disposed = false;
    const observer = new ResizeObserver(() => {
      const nextWidth = contentColumn.clientWidth;
      const element = scrollRef.current;
      if (!element) return;
      const viewportHeightChanged = observedViewportHeight !== element.clientHeight;
      observedViewportHeight = element.clientHeight;
      if (nextWidth === stableContentWidthRef.current && !viewportHeightChanged) return;
      markLayoutScrollGuard();
      commitFollowing(
        reconcileFollowingForContentAnchor({
          following: followingRef.current,
          metrics: {
            scrollTop: element.scrollTop,
            viewportHeight: element.clientHeight,
            contentHeight: element.scrollHeight,
          },
          lastObservedScrollTop: lastObservedScrollTopRef.current,
          userScrollIntent: getActiveUserScrollIntent(),
        }),
      );
      if (followingRef.current) {
        if (contentWidthResizeSettleTimerRef.current !== null) {
          window.clearTimeout(contentWidthResizeSettleTimerRef.current);
          contentWidthResizeSettleTimerRef.current = null;
        }
        // 本批次统一提交布局与吸底，其间其他内容 effect 不得按中间高度吸底。
        observer.unobserve(contentColumn);
        const messageLayer = messageLayerRef.current;
        const maskObserver = messageLayerMaskObserverRef.current;
        // 同步占位高度也会改变父消息层的高度；其蒙层观察器需要一起暂停，
        // 否则在更深层的 RO 通知中改变父层，会产生 undelivered notifications。
        if (messageLayer) maskObserver?.unobserve(messageLayer);
        committingMeasuredLayoutRef.current = true;
        try {
          // virtualizer 的 ResizeObserver 默认异步提交 React；先吸底会使用旧占位高度，
          // 下一帧测高提交后再跳一次。仅在 observer 内批量测高并同步提交，避免跨帧追赶。
          const measurements = Array.from(
            contentColumn.querySelectorAll(":scope > [data-index]"),
            (node) => ({
              index: Number(node.getAttribute("data-index")),
              height: measureElement(node, undefined),
            }),
          );
          flushSync(() => {
            for (const item of measurements) virtualizer.resizeItem(item.index, item.height);
            // 缓存可能已经更新且没有差量，仍需明确提交，不能依赖空回调冲刷旧任务。
            commitMeasuredLayout((revision) => revision + 1);
          });
        } finally {
          committingMeasuredLayoutRef.current = false;
          // 暂停的是本批次会写入高度的观察目标，不推迟测高或吸底。下一帧继续
          // 观察内容列宽度，以覆盖视口停止后仍在进行的 CSS 宽度过渡。
          if (observeContentFrame !== null) window.cancelAnimationFrame(observeContentFrame);
          if (!disposed) {
            observeContentFrame = window.requestAnimationFrame(() => {
              observeContentFrame = null;
              observer.observe(contentColumn);
              if (
                messageLayer &&
                messageLayerRef.current === messageLayer &&
                messageLayerMaskObserverRef.current === maskObserver
              ) {
                maskObserver?.observe(messageLayer);
              }
            });
          }
        }
        if (disposed) return;
        stableContentWidthRef.current = contentColumn.clientWidth;
        contentWidthResizeActiveRef.current = false;
        // 同步提交可能触发其他布局处理；用户上滚或定位始终优先。
        if (followingRef.current && getActiveUserScrollIntent() !== "awayFromBottom") {
          scrollToBottom();
        }
        return;
      }
      if (nextWidth === stableContentWidthRef.current) return;

      // 宽度变化会让虚拟行分批重新测高；逐行补偿或逐批追底都会
      // 连续改写 scrollTop。resize 期间暂停两者，稳定后只执行一次最终贴底。
      contentWidthResizeActiveRef.current = true;
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
      }
      contentWidthResizeSettleTimerRef.current = window.setTimeout(() => {
        stableContentWidthRef.current = contentColumn.clientWidth;
        contentWidthResizeActiveRef.current = false;
        contentWidthResizeSettleTimerRef.current = null;
        // 宽度校正期间禁用测高补偿；发布既有生命周期的结束，使待定位搜索此时接管。
        commitMeasuredLayout((revision) => revision + 1);
        if (followingRef.current) {
          scrollToBottom();
        }
      }, CONTENT_WIDTH_RESIZE_SETTLE_MS);
    });
    observer.observe(contentColumn);
    if (scrollRef.current) observer.observe(scrollRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
      if (observeContentFrame !== null) window.cancelAnimationFrame(observeContentFrame);
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
        contentWidthResizeSettleTimerRef.current = null;
      }
      contentWidthResizeActiveRef.current = false;
    };
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    markLayoutScrollGuard,
    measureElement,
    renderUnits.length === 0,
    scrollToBottom,
    virtualizer,
  ]);

  useLayoutEffect(() => {
    const element = liveTailRef.current;
    const cacheKey = getUnitHeightCacheKey(liveUnit ?? undefined);
    if (!element || cacheKey === undefined) return;

    const cacheHeight = (entry?: ResizeObserverEntry) => {
      const height = measureRowHeight(element, entry);
      heightCacheRef.current?.set(cacheKey, height);
      return height;
    };
    let observedHeight = cacheHeight();
    if (typeof ResizeObserver === "undefined") return;

    // projection revision 的父 layout effect 可能早于 Markdown 子树最终测高；
    // 旧 observer 只缓存高度，正文会先把 loading 槽顶下去，后续 commit 才补 scrollTop。
    // ResizeObserver 在绘制前拿到真实高度，这里仅在仍拥有 following 滚动权时同步吸底；
    // 用户已经上滚（包括 scroll event 尚未入账的竞态）则只缓存，不夺回阅读位置。
    const observer = new ResizeObserver((entries) => {
      const nextHeight = cacheHeight(entries[0]);
      if (nextHeight === observedHeight) return;
      observedHeight = nextHeight;

      const scrollElement = scrollRef.current;
      if (!scrollElement) return;
      markLayoutScrollGuard();
      const following = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics: {
          scrollTop: scrollElement.scrollTop,
          viewportHeight: scrollElement.clientHeight,
          contentHeight: scrollElement.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
      });
      commitFollowing(following);
      if (anchorActionAfterContentChange(following, isContentWidthChanging()) === "stickToBottom") {
        scrollToBottom();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    isContentWidthChanging,
    liveUnit?.key,
    markLayoutScrollGuard,
    scrollToBottom,
  ]);

  const saveCurrentScrollMemory = useCallback(() => {
    const key = scrollMemoryKey;
    const element = scrollRef.current;
    if (!key) return;
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    const cached = latestScrollMemoryStateRef.current;
    const cachedState = cached?.key === key ? cached.state : null;
    const state =
      pendingRestore?.key === key
        ? pendingRestore.state
        : element
          ? cacheCurrentScrollMemoryState(element)
          : cachedState;
    if (state) saveChatSessionScrollMemoryState(key, state);
  }, [cacheCurrentScrollMemoryState, scrollMemoryKey]);

  const restoreScrollMemory = useCallback(
    (state: ChatSessionScrollMemoryState) => {
      const element = scrollRef.current;
      if (!element) return;
      clearUserScrollIntent();
      markProgrammaticScroll();
      recordScrollWrite("scrollMemoryRestore", element);
      element.scrollTop = resolveChatSessionScrollRestoreTop(state, element);
      lastObservedScrollTopRef.current = element.scrollTop;
      followingRef.current = false;
      setBackToBottomVisible(shouldShowBackToBottom(false, unitsRef.current.length));
      syncTurnNavigatorViewport(element);
      userAdjustedScrollSinceRestoreRef.current = false;
      cacheCurrentScrollMemoryState(element);
    },
    [
      cacheCurrentScrollMemoryState,
      clearUserScrollIntent,
      markProgrammaticScroll,
      syncTurnNavigatorViewport,
    ],
  );

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const programmaticScroll =
      programmaticScrollFrameRef.current !== null &&
      Math.abs(element.scrollTop - lastObservedScrollTopRef.current) < 1;
    const userScrollIntent = getActiveUserScrollIntent();
    // 用户输入优先；guard 内且仍近底的未分类 scroll 视为布局补偿（heal/measure）。
    // 已离底时不得再当 layout——否则切会话后滚动条上翻会被 450ms remount guard
    // 吞掉，following 不清、内容 effect 继续贴底，历史像「滚不动/不显示」。
    const inRemountMeasureGuard =
      performance.now() <= remountMeasureGuardUntilRef.current;
    const inLayoutGuard = Date.now() <= layoutScrollGuardUntilRef.current;
    const nearBottom = isAtBottom({
      scrollTop: element.scrollTop,
      viewportHeight: element.clientHeight,
      contentHeight: element.scrollHeight,
    });
    const scrollSource =
      userScrollIntent !== "none"
        ? "user"
        : programmaticScroll
          ? "programmatic"
          : (inLayoutGuard || inRemountMeasureGuard) && nearBottom
            ? "layout"
            : "user";
    // virtualizer 的原生 offset observer 会先于 React onScroll 入账；到这里即可确认它
    // 已看见恢复后的真实 scrollTop。用户滚动也应立即结束保护窗，把滚动权交还用户。
    if (scrollSource !== "layout") {
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    }
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    const following = resolveFollowingAfterScroll({
      following: followingRef.current,
      source: scrollSource,
      userScrollIntent,
      metrics: {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      },
    });
    commitFollowing(following);
    if (scrollSource === "user") {
      pendingDetachedScrollRestoreRef.current = null;
      userAdjustedScrollSinceRestoreRef.current = true;
      saveCurrentScrollMemory();
    }
    // 跟底时禁止预取：短尾窗 scrollTop 永远落在 2×视口预取带，会与 soft-cap /
    // scrollToBottom 互殴（轨迹 !JUMP src=scrollToBottom + loading 抖动）。
    tryLoadOlderNearTop(element, following);
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    saveCurrentScrollMemory,
    syncTurnNavigatorViewport,
    tryLoadOlderNearTop,
  ]);

  const handleBackToBottom = useCallback(() => {
    pendingDetachedScrollRestoreRef.current = null;
    clearUserScrollIntent();
    commitFollowing(true);
    scrollToBottom();
    // scrollToBottom 只更新组件内 ref；若用户点击后立刻切任务，scope
    // cleanup/scroll 事件可能还没运行，旧 Map 会把下次恢复重新带回中部甚至顶部。
    saveCurrentScrollMemory();
  }, [clearUserScrollIntent, commitFollowing, saveCurrentScrollMemory, scrollToBottom]);

  useLayoutEffect(() => {
    if (!scrollToBottomActionRef) return;
    scrollToBottomActionRef.current = handleBackToBottom;
    return () => {
      // 只清理本实例登记的动作，避免切 pane 时旧 cleanup 覆盖新 timeline。
      if (scrollToBottomActionRef.current === handleBackToBottom) {
        scrollToBottomActionRef.current = null;
      }
    };
  }, [handleBackToBottom, scrollToBottomActionRef]);

  const scrollToQuery = useCallback(
    (target: { unitIndex: number; rowId: number }, behavior: ScrollBehavior = "auto") => {
      clearUserScrollIntent();
      commitFollowing(false);
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }

      const scrollMountedQuery = (element: HTMLDivElement): boolean => {
        const rowElement = element.querySelector<HTMLElement>(`[data-row-id="${target.rowId}"]`);
        if (!rowElement) return false;
        const targetTop =
          element.scrollTop +
          rowElement.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        recordScrollWrite("scrollToQuery", element);
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        logger.debug("[v4-turn-navigator] 定位用户 query", {
          behavior,
          rowId: target.rowId,
          unitIndex: target.unitIndex,
        });
        return true;
      };

      const element = scrollRef.current;
      if (!element || scrollMountedQuery(element)) return;

      // product turn 是虚拟列表的最小挂载单元，steer query 是单元内锚点。目标未挂载时
      // 先无动画挂载所属 turn，再按用户 motion 偏好精确滚到 row，不能退回 turn 开头。
      if (target.unitIndex === liveUnitIndex) {
        const liveTail = liveTailRef.current;
        if (liveTail) {
          recordScrollWrite("scrollToQueryLiveTailMount", element);
          element.scrollTop =
            element.scrollTop +
            liveTail.getBoundingClientRect().top -
            element.getBoundingClientRect().top;
        }
      } else {
        recordScrollWrite("virtualizerScrollToIndex", element);
        virtualizer.scrollToIndex(target.unitIndex, {
          align: "start",
          behavior: "auto",
        });
      }

      let remainingAttempts = 12;
      const alignMountedQuery = () => {
        turnNavigatorJumpFrameRef.current = null;
        const currentElement = scrollRef.current;
        if (currentElement && scrollMountedQuery(currentElement)) return;
        remainingAttempts -= 1;
        if (remainingAttempts <= 0) {
          logger.warn("[v4-turn-navigator] query 锚点挂载超时", {
            rowId: target.rowId,
            unitIndex: target.unitIndex,
          });
          return;
        }
        turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
      };
      turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
    },
    [clearUserScrollIntent, commitFollowing, liveUnitIndex, syncTurnNavigatorViewport, virtualizer],
  );

  useLayoutEffect(() => {
    if (!scrollToQueryActionRef) return;
    const action = (target: { unitIndex: number; rowId: number }) => {
      scrollToQuery(target);
    };
    scrollToQueryActionRef.current = action;
    return () => {
      if (scrollToQueryActionRef.current === action) {
        scrollToQueryActionRef.current = null;
      }
    };
  }, [scrollToQuery, scrollToQueryActionRef]);

  useEffect(
    () => () => {
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }
    },
    [sessionKey],
  );

  const scrollToUnit = useCallback(
    (unitIndex: number, behavior: ScrollBehavior = "auto") => {
      clearUserScrollIntent();
      commitFollowing(false);
      if (unitIndex === liveUnitIndex) {
        const element = scrollRef.current;
        const liveTail = liveTailRef.current;
        if (!element || !liveTail) return;
        const targetTop =
          element.scrollTop +
          liveTail.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        recordScrollWrite("scrollToQueryLiveTail", element);
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        return;
      }
      const scrollElement = scrollRef.current;
      if (scrollElement) recordScrollWrite("virtualizerScrollToIndex", scrollElement);
      virtualizer.scrollToIndex(unitIndex, { align: "start", behavior });
    },
    [clearUserScrollIntent, commitFollowing, liveUnitIndex, syncTurnNavigatorViewport, virtualizer],
  );

  useConversationTimelineFind({
    rootRef: scrollRef,
    renderUnits,
    rows,
    mountedRowsKey,
    canLoadOlder,
    loadingOlder,
    onLoadOlder,
    sessionPhase,
    conversationFindQuery,
    conversationFindActiveIndex,
    conversationFindNavigationRequestId,
    onConversationFindMatchStateChange,
    searchResultHighlightRequest,
    onSearchResultHighlightDone,
    scrollToUnit,
  });

  const saveCurrentScrollMemoryRef = useRef(saveCurrentScrollMemory);
  saveCurrentScrollMemoryRef.current = saveCurrentScrollMemory;

  useLayoutEffect(() => {
    return () => {
      // 真正卸载时 DOM 尚在；scope 更新则由 before-mutation capture 读取旧 DOM。
      saveCurrentScrollMemoryRef.current();
    };
  }, []);

  const rowCount = renderUnits.length;
  const rowWindowKey = `${rows.length}:${rows[0]?.rowId ?? "none"}:${rows[rows.length - 1]?.rowId ?? "none"}`;
  const pendingGuideKey = pendingGuides.map((item) => item.queueItemId).join(":");

  // V4 迁移删除旧 ChatView 滚动 hook 后，sessionKey effect 仍固定滚到底部，
  // 导致残留的 renderer-local 记忆模块彻底断线。这里在清测高并重新 measure 后按 scope
  // 恢复；首个 layout 立即写入防闪动，下一帧再校正异步测高，但必须把滚动权让给用户。
  useLayoutEffect(() => {
    clearUserScrollIntent();
    heightCacheRef.current?.clear();
    // prepend 锚定基线一并重置：rowId 跨会话可重复，禁止拿旧会话首行比较。
    prependAnchorRef.current = { firstRowId: null, totalSize: 0 };
    pendingPrependVirtualAnchorRef.current = null;
    // draft 默认吸底会留下旧 virtualizer.scrollOffset；在恢复写入派发 scroll 事件前，
    // 测高若继续按旧 offset 校正，会把刚恢复的历史位置重新推回 draft 的落点。
    suppressVirtualizerAdjustmentDuringRestoreRef.current = true;
    virtualizer.measure();
    userAdjustedScrollSinceRestoreRef.current = false;

    const restoredState = readChatSessionScrollMemoryState(scrollMemoryKey);
    const pendingRestoreWait = resolvePendingScrollMemoryRestoreWait(
      restoredState,
      scrollRef.current,
      unitsRef.current.length > 0,
    );
    pendingDetachedScrollRestoreRef.current =
      scrollMemoryKey && restoredState && pendingRestoreWait
        ? {
            key: scrollMemoryKey,
            rowWindowKey,
            state: restoredState,
            waitFor: pendingRestoreWait,
          }
        : null;
    const restore = () => {
      if (!restoredState || restoredState.wasPinnedToBottom === true) {
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
        followingRef.current = initialFollowing();
        setBackToBottomVisible(false);
        scrollToBottom();
        return;
      }
      restoreScrollMemory(restoredState);
    };

    restore();
    let releaseGuardFrame: number | null = null;
    const correctionFrame = window.requestAnimationFrame(() => {
      if (!userAdjustedScrollSinceRestoreRef.current) {
        restore();
      }
      releaseGuardFrame = window.requestAnimationFrame(() => {
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(correctionFrame);
      if (releaseGuardFrame !== null) {
        window.cancelAnimationFrame(releaseGuardFrame);
      }
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    };
  }, [
    clearUserScrollIntent,
    restoreScrollMemory,
    scrollMemoryKey,
    scrollToBottom,
    sessionKey,
    virtualizer,
  ]);

  // 冷恢复先展示末尾窗口，再补齐同一 turnId 的正文；稳定 ref 不会重新测高，
  // 只等 ResizeObserver 会先画出新正文和旧坐标，造成一帧重叠。提交后批量读取
  // 已挂载轮次，在 layout 阶段更新既有 virtualizer；下一次同步提交后再对账锚点。
  useLayoutEffect(() => {
    const renderedSizes = new Map(virtualRows.map((row) => [row.index, row.size]));
    const measurements = Array.from(
      virtualHistoryRef.current?.querySelectorAll(":scope > [data-index]") ?? [],
      (node) => ({
        index: Number(node.getAttribute("data-index")),
        height: measureElement(node, undefined),
      }),
    ).filter((item) => renderedSizes.get(item.index) !== item.height);
    contentMeasurementPendingRef.current = measurements.length > 0;
    if (measurements.length === 0) return;
    for (const item of measurements) virtualizer.resizeItem(item.index, item.height);
    // RO 可能已写入缓存但尚未提交 DOM；此时 resizeItem 无差量，也要提交坐标。
    commitMeasuredLayout((revision) => revision + 1);
  }, [measureElement, rowWindowKey, virtualRows, virtualizer]);

  useLayoutEffect(() => {
    if (contentMeasurementPendingRef.current) return;
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    if (rowCount === 0 || !pendingRestore || pendingRestore.key !== scrollMemoryKey) {
      return;
    }

    // session scope 往往先于 rows 订阅完成；只在 scope commit 和下一帧
    // 恢复会把历史 scrollTop 钳成 0。首批内容到达后重新落地，并再等一帧校正测高。
    suppressVirtualizerAdjustmentDuringRestoreRef.current = true;
    restoreScrollMemory(pendingRestore.state);
    let releaseGuardFrame: number | null = null;
    const correctionFrame = window.requestAnimationFrame(() => {
      if (
        pendingDetachedScrollRestoreRef.current === pendingRestore &&
        !userAdjustedScrollSinceRestoreRef.current
      ) {
        restoreScrollMemory(pendingRestore.state);
      }
      releaseGuardFrame = window.requestAnimationFrame(() => {
        if (
          pendingDetachedScrollRestoreRef.current === pendingRestore &&
          canReleasePendingScrollMemoryRestore(
            pendingRestore,
            scrollRef.current,
            rowCount,
            canLoadOlder || totalCount > rows.length,
            rowWindowKey,
          )
        ) {
          pendingDetachedScrollRestoreRef.current = null;
        }
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
      });
    });

    return () => {
      window.cancelAnimationFrame(correctionFrame);
      if (releaseGuardFrame !== null) {
        window.cancelAnimationFrame(releaseGuardFrame);
      }
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    };
  }, [
    canLoadOlder,
    restoreScrollMemory,
    rowCount,
    rowWindowKey,
    measuredLayoutRevision,
    scrollMemoryKey,
    totalCount,
    totalSize,
  ]);

  // prepend 锚定：loadOlder 前插历史行时平移 scrollTop，阅读位置不跳。
  // 既有 turn key=turnId 且测量缓存不失效 → 前插只把总高度撑高 delta，scrollTop += delta
  // 即恢复锚点（绘制前完成，无闪动）；本效应声明在会话切换效应之后，切换 commit 上
  // 先重置基线再对账，防跨会话 rowId 误判为前插。
  useLayoutEffect(() => {
    if (contentMeasurementPendingRef.current) return;
    const prev = prependAnchorRef.current;
    const nextFirstRowId = rowsRef.current[0]?.rowId ?? null;
    const nextTotalSize = virtualizer.getTotalSize();
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    const pendingRestoreOwnsAnchor = pendingRestore?.key === scrollMemoryKey;
    const didPrepend =
      prev.firstRowId !== null && nextFirstRowId !== null && nextFirstRowId < prev.firstRowId;
    let viewportAdjustment: number | null = null;
    if (didPrepend && !pendingRestoreOwnsAnchor && scrollRef.current) {
      const previousVirtualAnchor = pendingPrependVirtualAnchorRef.current;
      const nextAnchorMeasurement = previousVirtualAnchor
        ? virtualizer.measurementsCache.find(
            (measurement) => measurement.key === previousVirtualAnchor.key,
          )
        : undefined;
      if (previousVirtualAnchor && nextAnchorMeasurement) {
        viewportAdjustment = prependVirtualAnchorAdjustment(
          previousVirtualAnchor,
          {
            key: previousVirtualAnchor.key,
            offsetTop: previousVirtualAnchor.offsetTop,
            start: nextAnchorMeasurement.start,
          },
          scrollRef.current.scrollTop,
        );
      }
    }
    if (didPrepend) pendingPrependVirtualAnchorRef.current = null;
    const adjustment = pendingRestoreOwnsAnchor
      ? null
      : (viewportAdjustment ??
        prependScrollAdjustment({
          prevFirstRowId: prev.firstRowId,
          nextFirstRowId,
          prevTotalSize: prev.totalSize,
          nextTotalSize,
        }));
    if (adjustment !== null && scrollRef.current) {
      const element = scrollRef.current;
      markLayoutScrollGuard();
      recordScrollWrite("prependAnchorAdjust", element);
      element.scrollTop += adjustment;
      // 程序化平移同样入账，避免被下方贴底对账误读为「未观察滚动」。
      lastObservedScrollTopRef.current = element.scrollTop;
      syncTurnNavigatorViewport(element);
      cacheCurrentScrollMemoryState(element);
      // 一次前插数千行时，measurement cache 与 scrollTop 会在同一 commit
      // 更新，Chromium 可能合并掉原生 scroll 通知，virtualizer 仍按旧 offset 挂载首屏，
      // 形成“滚动条在底部、正文却空白”。commit 后按最终落点补发只读通知；若同帧存在
      // 用户 wheel/pointer 意图，handleScroll 仍会优先识别为 user，不夺回滚动权。
      notifyScrollObserversAfterCommit(element);
    }
    // 待恢复的离底记忆拥有当前 commit 的坐标系；不能让 prepend 把临时 clamp 值再次
    // 平移。恢复 effect 会在同一 commit 的下一帧按最终内容高度重放原始位置。
    prependAnchorRef.current = {
      firstRowId: nextFirstRowId,
      totalSize: nextTotalSize,
    };
  });

  // 底部锚定：内容变化（新行 / 流式 delta / 动态测高修正 → totalSize 变化）时，
  // 跟随中贴底，解除跟随保持阅读位置。useLayoutEffect 在绘制前完成贴底，避免闪动。
  // terminal 会同时迁移 live tail、自动折叠历史并
  // 触发 virtualizer 多阶段测高；这些 scrollTop 回退属于布局，必须保持 following。
  // 若同帧有用户向上滚动，capture handler 会先登记 awayFromBottom，本 effect 必须让位。
  //
  // 依赖用 rowWindowKey（窗缘 rowId）+ totalSize，禁止绑 rows 数组引用：
  // 投影每帧都是新 window 数组，layout 里再 setState（following / viewport）会与
  // 侧栏开合 / 切会话叠成 React #185（Maximum update depth）。流式长高靠 totalSize。
  // measuredLayoutRevision：批测高提交后再贴底，避免中间估高帧抢吸底。
  useLayoutEffect(() => {
    if (contentMeasurementPendingRef.current) return;
    const element = scrollRef.current;
    markLayoutScrollGuard();
    if (element) {
      const following = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics: {
          scrollTop: element.scrollTop,
          viewportHeight: element.clientHeight,
          contentHeight: element.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
      });
      commitFollowing(following);
    }
    if (
      anchorActionAfterContentChange(followingRef.current, isContentWidthChanging()) ===
      "stickToBottom"
    ) {
      scrollToBottom();
    }
  }, [
    getActiveUserScrollIntent,
    isContentWidthChanging,
    markLayoutScrollGuard,
    commitFollowing,
    headerSlotHeight,
    measuredLayoutRevision,
    pendingGuideKey,
    rowCount,
    rowWindowKey,
    scrollToBottom,
    totalSize,
  ]);

  useLayoutEffect(() => {
    if (scrollRef.current) {
      syncTurnNavigatorViewport(scrollRef.current);
    }
  }, [pendingGuideKey, rowCount, syncTurnNavigatorViewport, totalSize]);

  // 行清空（如 editUserQuery 大范围 rewind）：重置为跟随并收起按钮，
  // 后续重新出现的行走上面的锚定 effect 贴底。
  useEffect(() => {
    if (rowCount === 0) {
      if (pendingDetachedScrollRestoreRef.current?.key === scrollMemoryKey) {
        return;
      }
      followingRef.current = initialFollowing();
      if (backToBottomVisible) {
        setBackToBottomVisible(false);
      }
    }
  }, [rowCount, backToBottomVisible, scrollMemoryKey]);

  useEffect(() => {
    return () => {
      if (programmaticScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(programmaticScrollFrameRef.current);
        programmaticScrollFrameRef.current = null;
      }
    };
  }, []);

  // raw projection row 与按 turn 合并后的 render unit 不是同一计量单位；
  // 分开暴露才能让恢复/分页验证不再把可见 unit 误当成持久 row。
  return (
    <div ref={timelineRootRef} className="relative flex min-h-0 flex-1 flex-col">
      {selectionActions ? (
        <ConversationSelectionTooltip
          rootRef={scrollRef}
          rows={rows}
          sourceSessionId={sessionKey}
          enabled={selectionActions.enabled}
          sideActionDisabled={selectionActions.sideActionDisabled}
          onAddToCurrentTask={selectionActions.onAddToCurrentTask}
          onAskInSideChat={selectionActions.onAskInSideChat}
        />
      ) : null}
      <ConversationScrollMemoryScopeCapture
        scopeKey={scrollMemoryKey}
        capture={captureScrollMemoryBeforeScopeMutation}
        commit={commitCapturedScrollMemory}
      />
      {/* 分享选择流程无论面板展开还是收起，左 rail 都由分享面板或 reopen 按钮独占，
          必须隐藏对话轮导航，避免两个绝对定位控件互相覆盖。退出分享选择后自动恢复。 */}
      {hideTurnNavigator ? null : (
        <ConversationTurnNavigator
          renderUnits={renderUnits}
          isHydratingDirectory={loadingOlder}
          scrollOffsetPx={virtualizer.scrollOffset ?? turnNavigatorViewport.scrollOffsetPx}
          viewportHeightPx={
            virtualizer.scrollRect?.height ?? turnNavigatorViewport.viewportHeightPx
          }
          virtualItems={turnNavigatorVirtualItems}
          activeQueryRowId={turnNavigatorViewport.activeQueryRowId}
          onJumpToQuery={scrollToQuery}
        />
      )}
      <div
        ref={scrollRef}
        data-testid={TID_V4_TIMELINE}
        data-v4-timeline-scroll="true"
        data-v4-timeline-scroll-locked={backgroundScrollLocked ? "true" : "false"}
        data-markdown-table-layout-root="true"
        data-row-count={rows.length}
        data-window-row-count={rows.length}
        data-render-unit-count={renderUnits.length}
        data-total-row-count={totalCount}
        data-following={backToBottomVisible ? "false" : "true"}
        data-loading-older={loadingOlder ? "true" : "false"}
        onKeyDownCapture={handleKeyDownCapture}
        onPointerCancelCapture={handlePointerEndCapture}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerUpCapture={handlePointerEndCapture}
        onScroll={handleScroll}
        onTouchCancelCapture={handleTouchEndCapture}
        onTouchEndCapture={handleTouchEndCapture}
        onTouchMoveCapture={handleTouchMoveCapture}
        onTouchStartCapture={handleTouchStartCapture}
        onWheelCapture={handleWheelCapture}
        // 必须在滚动端口自身关 overflow-anchor：仅关内容子树时，Chrome 仍会把
        // sticky composer / 虚拟行换入换出当成锚点，上滚停住后把 scrollTop 单向拽回底部
        //（diag 里表现为全 src=browser/native、往复 0、累计数百 px）。
        style={{ overflowAnchor: "none" }}
        className={cn(
          // 原生滚动条按内容高度动态出现时会缩窄会话视口，导致消息与 composer
          // 横向跳动；稳定预留 gutter，让桌面与手机 Web 共用的滚动区宽度保持不变。
          // 只声明 overflow-y-auto 会让浏览器把横轴计算为 auto，宽内容会把
          // 整条 Conversation 撑出横向滚动；表格和代码块应由各自内部容器滚动。
          "min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] overscroll-behavior-y-contain [--markdown-table-layout-left-inset:16px] [--markdown-table-layout-right-inset:16px] max-md:[--markdown-table-layout-left-inset:8px] max-md:[--markdown-table-layout-right-inset:8px]",
          // 分享选择面板展开时改为 overflow-hidden：scrollTop 与 scrollbar-gutter 都保持不变，
          // 但原生滚动条、滚轮和键盘翻页都不再能移动背景，勾选目标不会漂走。
          backgroundScrollLocked && "!overflow-y-hidden",
          // Conversation turn map 覆盖 timeline 左侧 48px；表格增强滚动如果仍按
          // 普通 16px 边距借位，会有 32px 落到 turn map 下方，必须把完整占用计入左边界。
          turnNavigatorQueryRowIds.size >= 2 &&
            "@min-[864px]/conversation:[--markdown-table-layout-left-inset:48px]",
        )}
      >
        <div
          className={cn(
            // 固定高度断点会在窗口跨过临界值时让问候语与 composer 整组跳动。
            // 顶部留白按视口高度伸缩，输入框的位置不再受下方推荐列表高度影响；
            // 空间不足时顶部可收缩到底线，底部继续随内容自然排布。
            responsiveCenteredEmptyLayout
              ? // 动态修改原生窗口下限会把内容换行反馈到窗口拖动，产生阻尼；
                // 容器保留固有最小高度，由外层 timeline 统一承接受限高度下的溢出内容。
                "flex min-h-full flex-col items-center px-4 before:block before:min-h-[52px] before:w-full before:shrink before:basis-[29dvh] before:content-[''] after:block after:min-h-4 after:w-full after:flex-1 after:content-['']"
              : centeredEmptyLayout
                ? "flex min-h-full flex-col items-center justify-center gap-4 px-4"
                : "flex min-h-full flex-col",
          )}
          // session 切到 draft 时内容高度骤降，Chrome 会把子树里的
          // sticky composer 选作原生 scroll anchor，并在切回后覆盖 layout/RAF 恢复值。
          // V4 已自管 prepend、吸底和记忆锚点；和其它虚拟列表一致，应从内容子树禁用锚点候选。
          style={{ overflowAnchor: "none" }}
        >
          {renderUnits.length === 0 && !headerSlot ? (
            <div
              className={cn(
                centeredEmptyLayout
                  ? "flex w-full max-w-2xl shrink-0 items-center justify-center"
                  : "min-h-0 flex-1",
                !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
              )}
            >
              {emptyState}
            </div>
          ) : (
            <div
              ref={messageLayerRef}
              data-v4-timeline-message-layer="true"
              className="relative w-full flex-1 [mask-repeat:no-repeat] [-webkit-mask-repeat:no-repeat]"
            >
              {/*
               * headerSlot 必须落在被 mask 的消息层内、并套用与实时消息列相同的宽度类：
               * 放在消息层之外会既比正文宽、又从 sticky composer 下方透出来。
               */}
              {headerSlot ? (
                <div
                  ref={headerSlotRef}
                  data-v4-timeline-header-slot="true"
                  data-v4-timeline-content-column="true"
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  {headerSlot}
                </div>
              ) : null}
              <div
                ref={virtualHistoryRef}
                data-v4-timeline-virtual-history="true"
                data-v4-timeline-content-column="true"
                className={cn(
                  // 默认（< 1280px）过渡 width/max-width/transform，让 w-full ↔ max-w-4xl
                  // 的中等宽度切换平滑；≥1280px 触发的面板让位（max-w-6xl + 168px 左移）
                  // 用 @min-[1280px] 降级为只过渡 transform，避免大范围跳变叠加位移抖动。
                  "relative mx-auto w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                  contentWidthClassName,
                  summaryPanelInlineOffsetClassName,
                )}
                style={{ height: totalSize }}
              >
                {virtualRows.map((virtualRow) => {
                  const unit = virtualizedUnits[virtualRow.index];
                  if (!unit) return null;
                  return (
                    <div
                      key={`${virtualRow.key}:${rowContext.logEpoch ?? ""}`}
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      data-v4-turn-unit="true"
                      data-turn-id={unit.turnId}
                      // virtual history 的子项通过 absolute 定位，父级 padding 不会缩小
                      // 它们的 containing block；正文响应式内边距必须落在 turn wrapper 自身。
                      className="absolute left-0 top-0 w-full"
                      style={{
                        transform: `translateY(${virtualRow.start - headerSlotHeight}px)`,
                        overflowAnchor: "none",
                      }}
                    >
                      <ConversationTurnGroup
                        unit={unit}
                        apiRetry={null}
                        context={rowContext}
                        onFork={onFork}
                        onRetry={onRetry}
                        onFeedbackChange={onFeedbackChange}
                        onEdit={onEdit}
                        shareSelection={shareSelection}
                      />
                    </div>
                  );
                })}
              </div>
              {liveUnit !== null && liveUnitIndex !== null ? (
                <div
                  key={`${liveUnit.key}:${rowContext.logEpoch ?? ""}`}
                  ref={liveTailRef}
                  data-index={liveUnitIndex}
                  data-v4-running-live-tail="true"
                  data-v4-turn-unit="true"
                  data-turn-id={liveUnit.turnId}
                  data-v4-timeline-content-column="true"
                  style={{ overflowAnchor: "none" }}
                  className={cn(
                    // ≥1280px 面板让位时降级为只过渡 transform，避免大范围跳变叠加位移抖动。
                    "relative mx-auto w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  <ConversationTurnGroup
                    unit={liveUnit}
                    apiRetry={apiRetry}
                    context={rowContext}
                    onFork={onFork}
                    onRetry={onRetry}
                    onFeedbackChange={onFeedbackChange}
                    onEdit={onEdit}
                    shareSelection={shareSelection}
                  />
                </div>
              ) : null}
              {pendingGuides.length > 0 ? (
                <div
                  data-v4-timeline-content-column="true"
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  <ConversationPendingGuideList
                    context={rowContext}
                    items={pendingGuides}
                    turnId={
                      liveUnit?.turnId ??
                      rows.at(-1)?.productTurnId ??
                      rows.at(-1)?.turnId ??
                      "pending-guide"
                    }
                  />
                </div>
              ) : null}
            </div>
          )}
          {bottomDock ? (
            <div
              ref={composerDockRef}
              data-v4-composer-dock="true"
              // sticky 底栏极易被 Chrome 选作 scroll anchor；禁止参与锚定。
              style={{ overflowAnchor: "none" }}
              className={cn(
                // sticky dock 是 z-20 的全宽透明层，过去会盖住 z-10 rail
                // 在 composer 左侧留白内的按钮。外壳不接事件，只让实际内容列恢复命中。
                "pointer-events-none z-20 flex w-full justify-center",
                responsiveCenteredEmptyLayout
                  ? "mt-3 shrink-0"
                  : centeredEmptyLayout
                    ? "shrink-0"
                    : // mt-auto：内容被估高压短时仍把 dock 推到 min-h-full 底部，
                      // 避免 sticky 落在短文档流末尾 → 输入框「飘到最上」。
                      "mt-auto sticky bottom-0",
              )}
            >
              <div
                data-v4-composer-dock-content="true"
                className={cn(
                  // 同 virtual history/live tail，恢复宽度过渡避免硬跳。
                  // ≥1280px 面板让位时降级为只过渡 transform，避免大范围跳变叠加位移抖动。
                  "pointer-events-auto relative z-10 w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                  contentWidthClassName,
                  !centeredEmptyLayout && "px-4 pb-4",
                  !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
                )}
              >
                <div data-v4-back-to-bottom-anchor="composer-dock" className="relative">
                  {backToBottomVisible ? (
                    <ConversationBackToBottomButton
                      // 分屏下 composer 属于滚动视口内的 sticky dock；按钮若挂在
                      // timeline 外层 absolute bottom，会相对整个 pane 落到 input 下方。
                      //
                      // 圆钮采用自己的居中定位；`pointer-events-auto` 保留：
                      // 它是"按钮点得动"唯一可断言的契约。
                      className="pointer-events-auto absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 shadow-sm"
                      label={intl.formatMessage({ id: "chat.scrollToBottom" })}
                      onClick={handleBackToBottom}
                    />
                  ) : null}
                  {bottomDock}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {backToBottomVisible && !bottomDock ? (
        <ConversationBackToBottomButton
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
          label={intl.formatMessage({ id: "chat.scrollToBottom" })}
          onClick={handleBackToBottom}
        />
      ) : null}
    </div>
  );
}

export const ConversationTimeline = memo(ConversationTimelineImpl);

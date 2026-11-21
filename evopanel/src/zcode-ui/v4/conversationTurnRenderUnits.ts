import type {
  AssistantTextRow,
  ConversationRow,
  ConversationRowsPartition,
  HookInvocationRow,
  SessionPhase,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
  WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import {
  isWorkflowLaunchUserInputRow,
  resolveWorkflowLaunchMeta,
} from "@/v4/workflowLaunchTurn.js";
import {
  buildConversationTurnWorkSegments,
  resolveConversationTurnWorkDurationMs,
  resolveConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";
import type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";

export type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
export type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";

export interface ConversationTurnRenderUnit {
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  visibleUserInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  /**
   * 所有 visual work segment 的历史行聚合，仅供复制、预览和旧调用兼容。
   * 实际折叠边界读取 workSegments，且各段内部必须保持 CLI row 全序。
   */
  assistantHistoryRows: AssistantWorkRow[];
  /** 操作正文锚点之后、真正轮尾 marker 之前的 row；保持 CLI 全序原位渲染。 */
  assistantFollowingRows: AssistantWorkRow[];
  assistantTailRows: AssistantWorkRow[];
  /** 轮尾媒体（Browser/CUA 截图、platform 生图视频）：完成态在 file diff 摘要之后、操作栏之前。 */
  browserTurnEndRows: AssistantWorkRow[];
  /** turn-local Hook product rows；不进入 assistant work/折叠，只供轮尾详情 action。 */
  hookInvocations: HookInvocationRow[];
  /** 整轮全部 assistant text 段，用于复制/预览聚合，不代表渲染位置。 */
  assistantTextRows: AssistantTextRow[];
  /** 轻边界（modelChange）：渲染在 user 输入之前的轮顶分隔。 */
  leadingBoundaryRows: TimelineMarkerRow[];
  /** 完成态轮尾最终正文；fork/retry/action/preview 只挂这一段。 */
  latestAssistantTextRow?: AssistantTextRow;
  /** 同一 product turn 内 user/assistant 的可见交错顺序；相邻工作行保持成组。 */
  flowItems: ConversationTurnFlowItem[];
  /** 原始输入与每条 accepted guide 分别对应一个独立视觉工作段。 */
  workSegments?: ConversationTurnWorkSegment[];
  renderRows: ConversationRow[];
  isLastTurn: boolean;
  isRunning: boolean;
  assistantHistoryDefaultOpen: boolean;
  timelineOnly: boolean;
  /** turn 级聚合工作状态，仅供旧调用兼容；新组件消费 workSegments[].workStatus。 */
  workStatus?: ConversationTurnWorkStatus;
  startedAt?: number;
  /** 中枢直接启动轮的启动元数据（规则见 `workflowLaunchTurn.ts`）；在场时轮由 run 卡呈现、无用户气泡。 */
  workflowLaunch?: WorkflowLaunchMeta;
}

interface BuildConversationTurnRenderUnitsOptions {
  nowMs?: number;
  sessionPhase?: SessionPhase;
  /**
   * 与右下角停止按钮同源（EvoFlow selectedTurnBusy / V4 control.canStop）。
   * 旁观飞书时 turnHeader 可能已是 completed，但会话仍 busy——末轮须跟停止按钮一致亮齿轮。
   */
  sessionBusy?: boolean;
}

interface DraftTurnRenderUnit {
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  userInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  hookInvocations: HookInvocationRow[];
  orderedRows: ConversationRow[];
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isTurnHeaderRow(row: ConversationRow): row is TurnHeaderRow {
  return row.kind === "turnHeader";
}

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

/** 后台任务唤醒 / 上下文压缩摘要：给模型看，不进时间线用户气泡。 */
function isHiddenProviderContextUserInput(row: UserInputRow): boolean {
  const text = String(row.text || "").trimStart();
  if (!text) return false;
  if (text.startsWith("<task-notification>") || text.startsWith("<subagent-notification>")) {
    return true;
  }
  const lower = text.toLowerCase();
  if (lower.startsWith("[context compaction")) return true;
  if (lower.startsWith("here is a summary of the conversation to date")) return true;
  if (lower.startsWith("here's a summary of the conversation to date")) return true;
  if (
    text.startsWith("[上下文摘要") ||
    text.startsWith("[深度压缩摘要") ||
    text.startsWith("[tool:history]") ||
    text.startsWith("[tool:summary]")
  ) {
    return true;
  }
  const entityId = String(row.entityId || "").trim();
  return (
    entityId.startsWith("bash-task-notification:") ||
    entityId.startsWith("subagent-task-notification:")
  );
}

function isTimelineMarkerRow(row: ConversationRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker";
}

function isHookInvocationRow(row: ConversationRow): row is HookInvocationRow {
  return row.kind === "hookInvocation";
}

function isVisibleAssistantWorkRow(row: AssistantWorkRow): boolean {
  if (row.kind === "reasoning" && row.text.trim().length === 0) {
    // 完成态空壳裁掉；流式空正文仍要可见（「正在思考」），否则 START 后首 token 前空白。
    if (row.state !== "streaming") {
      return false;
    }
  }
  // EnterPlanMode 只是内部模式切换边界，把它当普通工具放进“已工作”，
  // 会显示一条没有用户价值的“工具调用已执行”。只在 render unit 过滤，不改写协议投影，
  // 以保留 desktop continuous / web remote replayable 共用的运行态与恢复语义。
  return row.kind !== "toolCall" || row.toolName !== "EnterPlanMode";
}

function isVisibleConversationRow(row: ConversationRow): boolean {
  if (isUserInputRow(row)) return !isHiddenProviderContextUserInput(row);
  if (isTurnHeaderRow(row)) return false;
  if (isHookInvocationRow(row)) return false;
  return isVisibleAssistantWorkRow(row);
}

/**
 * 同一 turnId 下 tool/正文 rowId &lt; realUser.rowId = 历史工具被错误挂靠（mirror
 * 迟到 RESULT 用新 turnId 覆盖旧行；钉尾后又排到用户气泡后面）。
 * 丢掉这些错挂行，只保留轻边界 + 用户及 rowId ≥ 用户的本轮产物。
 */
export function normalizeOrderedRowsUserFirst(
  rows: readonly ConversationRow[],
): ConversationRow[] {
  if (!Array.isArray(rows) || rows.length < 2) {
    return Array.isArray(rows) ? [...rows] : [];
  }
  let firstUser: UserInputRow | null = null;
  for (const row of rows) {
    if (!isUserInputRow(row) || isHiddenProviderContextUserInput(row)) continue;
    if (row.origin !== "realUser") continue;
    if (!String(row.text || "").trim()) continue;
    firstUser = row;
    break;
  }
  if (!firstUser) return [...rows];

  const userRowId = Number(firstUser.rowId) || 0;
  const leadingBoundaries: ConversationRow[] = [];
  const kept: ConversationRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (
      row.kind === "timelineMarker" &&
      (row as TimelineMarkerRow).lane === "lightBoundary"
    ) {
      leadingBoundaries.push(row);
      continue;
    }
    if (
      row.rowId !== firstUser.rowId &&
      !isUserInputRow(row) &&
      !isTurnHeaderRow(row) &&
      (Number(row.rowId) || 0) < userRowId
    ) {
      dropped += 1;
      continue;
    }
    kept.push(row);
  }
  if (dropped === 0 && leadingBoundaries.length === 0) {
    return [...rows];
  }
  return [...leadingBoundaries, ...kept];
}

// 落位语义（lane）由 CLI 投影裁决下发（UI 不得按 marker type 自行推断）。
// lane 缺省（不应发生）按 assistantWork 兜底——降级进折叠组，不丢行。
function isTurnEndingTimelineMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "turnTailBoundary";
}

/**
 * artifact 行是分享投影追加到轮尾的产出物（insertDiscoveredArtifacts 插在该
 * productTurn 最后一行之后），但它同样属于 AssistantWorkRow，会成为 flow 的最后一行。
 * 于是折叠锚点的兜底条件「最后一行是 assistantText」失效——公开投影禁止 actions，
 * 分享页只有这条兜底——最终答复被卷进「已工作」并整轮默认展开。
 *
 * 它是追加的产出物、不属于对话流，按轮尾处理即可；与 browserTurnEndRows 摘轮尾截图同理。
 * 注意不能改成「取 flow 里最后一条 assistantText」：那会把 CUA 响应中途的正文
 * 提升成最终答复，拆散同一个 assistantResponseId 的分组。
 */
function isTurnTrailingArtifactRow(row: AssistantWorkRow): boolean {
  return row.kind === "artifact";
}

function splitTurnTailRows(rows: readonly AssistantWorkRow[]): {
  flowRows: AssistantWorkRow[];
  tailRows: AssistantWorkRow[];
} {
  let tailStart = rows.length;
  while (
    tailStart > 0 &&
    (isTurnEndingTimelineMarkerRow(rows[tailStart - 1]!) ||
      isTurnTrailingArtifactRow(rows[tailStart - 1]!))
  ) {
    tailStart -= 1;
  }
  return {
    flowRows: rows.slice(0, tailStart),
    tailRows: rows.slice(tailStart),
  };
}

function readToolCallVisualDisplay(row: Extract<AssistantWorkRow, { kind: "toolCall" }>) {
  // 协议双通道：顶层 display（旧 Node REPL / browser_turn_end）与
  // output.display（EvoFlow CUA / 文件 diff 等 canonical 位置）。
  return row.display ?? row.output?.display;
}

function isBrowserTurnEndRow(row: AssistantWorkRow): boolean {
  // 自动截图以完成态 tool row 持久化在最终正文之后，旧分组只把
  // timeline boundary 识别为轮尾，导致截图被搬进上方“已工作”折叠区而不可见。
  if (row.kind !== "toolCall") return false;
  const display = readToolCallVisualDisplay(row);
  if (
    display?.kind === "node_repl_images" &&
    display.source === "browser_turn_end"
  ) {
    return true;
  }
  // EvoFlow CUA：带 media 的截图卡若留在「已工作」里，回合结束后折叠就看不见。
  // 提到轮尾（最终答复之后、操作栏之前），与 browser_turn_end 同理。
  // 绑渠道扫码不整卡上提：工具行留原位，仅由轮尾 BindChannelTurnCards 挂码。
  if (
    display?.kind === "cua" &&
    Array.isArray(display.media) &&
    display.media.length > 0
  ) {
    return true;
  }
  // platform media.* 生图/视频：同理提到轮尾，否则只在工具卡下可见、折进「已工作」后丢失。
  return (
    display?.kind === "platform_ui" &&
    Array.isArray(display.media) &&
    display.media.length > 0
  );
}

function isLightBoundaryMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "lightBoundary";
}

function isCompletionBlockingWorkRowRunning(row: AssistantWorkRow): boolean {
  switch (row.kind) {
    case "assistantText":
    case "reasoning":
      return row.state === "streaming";
    case "toolCall":
      return (
        row.backgrounded !== true &&
        (row.status === "inputStreaming" ||
          row.status === "pendingApproval" ||
          row.status === "running")
      );
    case "subagent":
      return row.backgrounded !== true && row.status === "running";
    case "timelineMarker":
      return "status" in row.marker && row.marker.status === "running";
    default:
      return false;
  }
}

/**
 * 轮次已终态（!isRunning）时，把仍 streaming/running 的孤儿行改成完成态展示。
 * 后端 seal 漏扫 / remint 清 map 后，phase=idle 仍会「正在思考/正在执行」（f2fdc69c）。
 * 只影响渲染副本，不写回 store。
 */
export function sealZombieInflightRowForSettledTurn(
  row: ConversationRow,
  settled: boolean,
): ConversationRow {
  if (!settled) return row;
  if (row.kind === "reasoning" && row.state === "streaming") {
    const startedAt = Number(row.startedAt || row.createdAt || 0);
    const endedAt = Number(row.endedAt || 0) || Date.now();
    const durationMs =
      row.durationMs ??
      (startedAt > 0 ? Math.max(0, endedAt - startedAt) : undefined);
    return {
      ...row,
      state: "complete",
      endedAt: row.endedAt ?? endedAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
  if (row.kind === "assistantText" && row.state === "streaming") {
    return { ...row, state: "complete", endedAt: row.endedAt ?? Date.now() };
  }
  if (row.kind === "toolCall") {
    const status = String(row.status || "");
    if (
      status === "inputStreaming" ||
      status === "running" ||
      status === "in_progress"
    ) {
      return { ...row, status: "cancelled", endedAt: row.endedAt ?? Date.now() };
    }
  }
  if (row.kind === "subagent" && row.status === "running" && row.backgrounded !== true) {
    return { ...row, status: "cancelled" };
  }
  return row;
}

function resolveTurnRunning(
  draft: DraftTurnRenderUnit,
  options: BuildConversationTurnRenderUnitsOptions,
  isLastTurn: boolean,
): boolean {
  if (draft.header?.executionKind === "controlOnly") return false;

  // 末轮以宿主停止按钮（sessionBusy）为权威，避免：
  // - 停按钮灭了、turnHeader 仍 running → 左下角齿轮空转
  // - 停按钮亮着、缺 header / header 仍 running → 齿轮熄灭
  // 注意：不要把已 sealed 的末轮（completedSuccess）重新推成 running——
  // 用户刚发送下一句时 sessionBusy 会先亮，若仍用旧 header.startedAt 算「已工作」，
  // 计时会接着上一轮继续走，而不是从 0 起。
  if (isLastTurn && options.sessionBusy === false) {
    return false;
  }
  if (isLastTurn && options.sessionBusy === true) {
    const headerState = draft.header?.state;
    if (headerState === "failed" || headerState === "completedInterrupted") {
      return false;
    }
    if (!draft.header || headerState === "running") {
      return true;
    }
    return false;
  }

  if (draft.header) {
    // turnHeader 是 projection 的权威轮次边界；已终态主轮不能被
    // 同轮仍在运行的 background tool/subagent 行重新推成 running。
    return draft.header.state === "running";
  }
  if (
    options.sessionPhase === "completedSuccess" ||
    options.sessionPhase === "completedInterrupted" ||
    options.sessionPhase === "error"
  ) {
    // cold snapshot 只保留尾窗时可能裁掉 turnHeader；旧 fallback 会把
    // 孤立的 inputStreaming/running tool row 重新推成 thinking，终态 control 必须优先。
    return false;
  }
  // 仅兼容缺少 turnHeader 的旧投影；background-only work 不阻塞主轮完成。
  return draft.assistantWorkRows.some(isCompletionBlockingWorkRowRunning);
}

function shouldForceOpenAbnormalHistory(
  header: TurnHeaderRow | undefined,
  sessionPhase: SessionPhase | undefined,
): boolean {
  if (header) {
    return header.state === "completedInterrupted" || header.state === "failed";
  }
  return sessionPhase === "completedInterrupted" || sessionPhase === "error";
}

/** 与 gateway EMPTY_RUN_NOTICE_TEXT 同文案（仅识别/测试；勿在渲染层再注入）。 */
export const EMPTY_RUN_NOTICE_TEXT =
  "本轮未产出可见回复（空流或过早收尾）。若随后仍有模型输出，会继续挂在本轮；也可再发一条重试。";

function isEmptyRunAssistantRow(row: ConversationRow): boolean {
  if (row.kind !== "assistantText") return false;
  const eid = String(row.entityId || "");
  return eid.startsWith("empty-run-") && !eid.startsWith("empty-run-cleared-");
}

function draftHasRealAssistantWork(draft: DraftTurnRenderUnit): boolean {
  return draft.assistantWorkRows.some((row) => {
    if (isEmptyRunAssistantRow(row)) return false;
    if (row.kind === "assistantText") return Boolean(String(row.text || "").trim());
    return row.kind === "reasoning" || row.kind === "toolCall" || row.kind === "subagent";
  });
}

/** 过早 FINISHED→占位→迟到正文：占位落盘后数秒内先不展示，避免闪一下。 */
const EMPTY_RUN_UI_HIDE_MS = 3_000;

function shouldHideEmptyRunRow(row: ConversationRow, nowMs: number): boolean {
  if (!isEmptyRunAssistantRow(row)) return false;
  const created = Number((row as AssistantTextRow).createdAt) || 0;
  if (created > 0 && nowMs - created < EMPTY_RUN_UI_HIDE_MS) return true;
  return false;
}

/**
 * 重启/过早 FINISHED 常先落下 empty-run，随后对话续上——占位还挂着像「假空跑」。
 * - 后方已有真实助手产出 → 撤掉前方空跑
 * - 占位刚写入 <3s → 先藏住（真回复常在这窗口内到达）
 */
function stripStaleEmptyRunNotices(
  drafts: readonly DraftTurnRenderUnit[],
  nowMs: number,
  // 选择器分区化后，历史段与尾段分开成组；原始实现按「历史 ++ 尾轮」整窗反向扫描，
  // 尾轮的真实产出会撤掉更早轮的空跑占位。历史段扫描以尾段扫描的最终状态作种子，语义不变。
  seedLaterHasReal = false,
): DraftTurnRenderUnit[] {
  let laterHasReal = seedLaterHasReal;
  const out: DraftTurnRenderUnit[] = new Array(drafts.length);
  for (let i = drafts.length - 1; i >= 0; i -= 1) {
    const draft = drafts[i]!;
    const drop = (row: ConversationRow) =>
      isEmptyRunAssistantRow(row) &&
      (laterHasReal || shouldHideEmptyRunRow(row, nowMs));
    const keptWork = draft.assistantWorkRows.filter((row) => !drop(row));
    const keptOrdered = draft.orderedRows.filter((row) => !drop(row));
    if (
      keptWork.length !== draft.assistantWorkRows.length ||
      keptOrdered.length !== draft.orderedRows.length
    ) {
      out[i] = {
        ...draft,
        assistantWorkRows: keptWork,
        orderedRows: keptOrdered,
      };
    } else {
      out[i] = draft;
    }
    if (draftHasRealAssistantWork(out[i]!)) laterHasReal = true;
  }
  return out;
}

function materializeDraftUnit(
  draft: DraftTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const workflowLaunch = resolveWorkflowLaunchMeta(draft.header, draft.userInputs);
  // 启动轮的用户行由 run 卡代言，不进可见输入也不进流。
  const renderedRows =
    workflowLaunch === undefined
      ? draft.orderedRows
      : draft.orderedRows.filter((row) => !isWorkflowLaunchUserInputRow(row));
  const visibleUserInputs = renderedRows.filter(
    (row): row is UserInputRow => isUserInputRow(row) && !isHiddenProviderContextUserInput(row),
  );
  const firstRealUserRowId =
    visibleUserInputs.find(
      (row) => row.origin === "realUser" && String(row.text || "").trim(),
    )?.rowId ?? 0;
  // 与 normalizeOrderedRowsUserFirst 同语义：丢掉 rowId < 用户气泡的错挂历史工具。
  const visibleAssistantWorkRows = draft.assistantWorkRows.filter((row) => {
    if (!isVisibleAssistantWorkRow(row)) return false;
    if (!firstRealUserRowId) return true;
    return (Number(row.rowId) || 0) >= Number(firstRealUserRowId);
  });
  const visibleOrderedRows = renderedRows.filter(isVisibleConversationRow);
  const timelineOnly =
    visibleUserInputs.length === 0 &&
    visibleAssistantWorkRows.length > 0 &&
    visibleAssistantWorkRows.every(isTimelineMarkerRow);

  // modelChange 是轮顶轻边界，渲染在 user 输入之前，不进工作流。
  const leadingBoundaryRows = timelineOnly
    ? []
    : visibleAssistantWorkRows.filter(isLightBoundaryMarkerRow);
  const leadingBoundaryRowIds = new Set(leadingBoundaryRows.map((row) => row.rowId));
  const bodyRows = timelineOnly
    ? visibleAssistantWorkRows
    : visibleAssistantWorkRows.filter((row) => !isLightBoundaryMarkerRow(row));
  // Browser 自动截图要越过 file diff 摘要成为最后内容块，因此先单独抽取；
  // 其余 row 仍按 CLI 全序处理，只有连续的真实轮尾 marker 后缀可从 flow 拆出。
  const browserTurnEndRows: AssistantWorkRow[] = [];
  const nonBrowserRows: AssistantWorkRow[] = [];
  if (!timelineOnly) {
    for (const row of bodyRows) {
      if (isBrowserTurnEndRow(row)) {
        browserTurnEndRows.push(row);
      } else {
        nonBrowserRows.push(row);
      }
    }
  }
  // 不能用 filter 抽取所有 turnTailBoundary，并把 ExitPlanMode 也强行归入 tail，
  // 会把计划和中间 marker 从原 tool row 搬到轮底。其余 row 必须留在 flow 中。
  const { flowRows, tailRows: assistantTailRows } = timelineOnly
    ? { flowRows: [], tailRows: [] }
    : splitTurnTailRows(nonBrowserRows);

  const isLastTurn = index === total - 1;
  const isRunning = resolveTurnRunning(draft, options, isLastTurn);
  const isInterrupted = draft.header
    ? draft.header.state === "completedInterrupted"
    : options.sessionPhase === "completedInterrupted";
  // 旧展开规则只看 running 和最终正文，异常终态一旦保留 partial assistant text
  // 就会被当作正常完成而收起，隐藏中断/失败上下文。终态必须以 header 为权威；冷恢复
  // 尾窗缺 header 时才回退 session phase，desktop continuous 与 mobile replayable 共用此边界。
  const forceOpenHistory = shouldForceOpenAbnormalHistory(draft.header, options.sessionPhase);

  // 终态轮：展示层收口僵尸 streaming/running，避免「正在思考」钉死。
  const settledDisplay = !isRunning;
  const bodyRowsSealed = settledDisplay
    ? bodyRows.map((row) => sealZombieInflightRowForSettledTurn(row, true) as AssistantWorkRow)
    : bodyRows;
  const flowRowsSealed = settledDisplay
    ? flowRows.map((row) => sealZombieInflightRowForSettledTurn(row, true) as AssistantWorkRow)
    : flowRows;
  const browserTurnEndRowsSealed = settledDisplay
    ? browserTurnEndRows.map(
        (row) => sealZombieInflightRowForSettledTurn(row, true) as AssistantWorkRow,
      )
    : browserTurnEndRows;
  const assistantTailRowsSealed = settledDisplay
    ? assistantTailRows.map(
        (row) => sealZombieInflightRowForSettledTurn(row, true) as AssistantWorkRow,
      )
    : assistantTailRows;

  // 折叠边界以「段/轮末正文」为准；fork/retry 只挂在真正带 actions 的那条上，
  // 但绝不能让中间带 canFork 的答复冒充 latest，否则后续工具会掉到折叠外。
  const assistantTextRows = flowRowsSealed.filter(isAssistantTextRow);
  const actionAssistantTextRow = assistantTextRows.find(
    (row) => row.actions?.canFork === true || row.actions?.canRetry === true,
  );
  const lastAssistantTextRow = assistantTextRows.at(-1);
  const latestAssistantTextRow = lastAssistantTextRow ?? actionAssistantTextRow;
  const fallbackStartedAt =
    draft.header?.startedAt ??
    draft.userInputs[0]?.createdAt ??
    visibleOrderedRows.find(isUserInputRow)?.createdAt;
  const workDurationMs = resolveConversationTurnWorkDurationMs(
    draft.header,
    { nowMs: options.nowMs, ...(fallbackStartedAt !== undefined ? { fallbackStartedAt } : {}) },
    isRunning,
  );
  const workStatus = resolveConversationTurnWorkStatus(
    draft.header,
    bodyRowsSealed,
    isRunning,
    workDurationMs,
    isInterrupted,
  );
  const browserTurnEndRowIds = new Set(browserTurnEndRowsSealed.map((row) => row.rowId));
  const visibleOrderedSealed = settledDisplay
    ? visibleOrderedRows.map((row) => sealZombieInflightRowForSettledTurn(row, true))
    : visibleOrderedRows;
  const orderedBodyRows = normalizeOrderedRowsUserFirst(
    visibleOrderedSealed.filter(
      // main 的 workSegments 会从 orderedRows 重建 flow；如果这里只从
      // bodyRows 抽取截图，它仍会被塞回正文流并在轮尾再次渲染，造成重复和顺序错乱。
      (row) => !leadingBoundaryRowIds.has(row.rowId) && !browserTurnEndRowIds.has(row.rowId),
    ),
  );
  const workSegments = buildConversationTurnWorkSegments({
    key: draft.key,
    header: draft.header,
    orderedRows: orderedBodyRows,
    assistantTailRows: assistantTailRowsSealed,
    latestAssistantTextRow,
    isRunning,
    isLastTurn,
    isInterrupted,
    forceOpenHistory,
    timelineOnly,
    nowMs: options.nowMs,
    ...(fallbackStartedAt !== undefined ? { fallbackStartedAt } : {}),
  });
  const orderedAssistantHistoryRows = workSegments.flatMap(
    (segment) => segment.assistantHistoryRows,
  );
  const assistantFollowingRows = workSegments.flatMap((segment) => segment.assistantFollowingRows);
  const flowItems = workSegments.flatMap((segment) => segment.flowItems);
  const mustOpenHistory = workSegments.at(-1)?.assistantHistoryDefaultOpen ?? false;
  return {
    key: draft.key,
    turnId: draft.turnId,
    ...(draft.header ? { header: draft.header } : {}),
    visibleUserInputs,
    // 轻边界已经由 leadingBoundaryRows 独立承载，不能再算作 assistant work。
    assistantWorkRows: bodyRowsSealed,
    assistantHistoryRows: orderedAssistantHistoryRows,
    assistantFollowingRows,
    assistantTailRows: assistantTailRowsSealed,
    browserTurnEndRows: browserTurnEndRowsSealed,
    hookInvocations: draft.hookInvocations,
    assistantTextRows,
    leadingBoundaryRows,
    ...(latestAssistantTextRow ? { latestAssistantTextRow } : {}),
    flowItems,
    workSegments,
    // renderRows 是查找/诊断用的平面视图，也必须服从 CLI row 全序。
    renderRows: visibleOrderedSealed,
    isLastTurn,
    isRunning,
    assistantHistoryDefaultOpen: mustOpenHistory,
    timelineOnly,
    ...(workStatus ? { workStatus } : {}),
    ...(draft.header ? { startedAt: draft.header.startedAt } : {}),
    ...(workflowLaunch ? { workflowLaunch } : {}),
  };
}

function createDraftUnit(turnId: string): DraftTurnRenderUnit {
  return {
    // cold snapshot 可能从同一 turn 的 assistant/tool 行中间截断，补到
    // turnHeader 后首个可见 rowId 会变化。虚拟列表 key 必须只依赖协议稳定的 turnId，
    // 否则补页会把原 turn 当成新节点重挂，丢失测高缓存和视口锚点。
    key: turnId,
    turnId,
    userInputs: [],
    assistantWorkRows: [],
    hookInvocations: [],
    orderedRows: [],
  };
}

function shouldKeepRenderUnit(unit: ConversationTurnRenderUnit): boolean {
  // 隐形行清零后（投影不再产不可渲染 marker），任何工作行都可渲染；
  // 「哪些 marker 可渲染」不再是 UI 的判断。
  return (
    unit.visibleUserInputs.length > 0 ||
    unit.assistantWorkRows.length > 0 ||
    unit.hookInvocations.some((row) => row.executions.some((execution) => execution.didExecute)) ||
    unit.leadingBoundaryRows.length > 0 ||
    // 直接启动轮：用户行不可见、无助手内容，轮由 run 卡呈现——它当然要留下。
    unit.workflowLaunch !== undefined ||
    unit.isRunning
  );
}

function normalizeRenderUnitPosition(
  unit: ConversationTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const isLastTurn = index === total - 1;
  const forceOpenHistory = shouldForceOpenAbnormalHistory(unit.header, options.sessionPhase);
  const assistantHistoryDefaultOpen =
    unit.workSegments && unit.workSegments.length > 0
      ? !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workSegments.at(-1)?.workStatus?.state === "running") ||
          (unit.workSegments.length === 1 &&
            unit.latestAssistantTextRow === undefined &&
            unit.assistantWorkRows.length > 0))
      : !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workStatus?.state === "running") ||
          (unit.latestAssistantTextRow === undefined && unit.assistantWorkRows.length > 0));
  const lastSegment = unit.workSegments?.at(-1);
  const lastSegmentDefaultOpen = lastSegment
    ? !unit.timelineOnly &&
      (forceOpenHistory ||
        (isLastTurn && lastSegment.workStatus?.state === "running") ||
        (unit.workSegments?.length === 1 &&
          unit.latestAssistantTextRow === undefined &&
          lastSegment.assistantWorkRows.length > 0))
    : undefined;
  if (
    unit.isLastTurn === isLastTurn &&
    unit.assistantHistoryDefaultOpen === assistantHistoryDefaultOpen &&
    lastSegmentDefaultOpen === lastSegment?.assistantHistoryDefaultOpen
  ) {
    return unit;
  }
  // 旧实现在判定未变化之前就复制所有轮的 segment；长历史每帧会产生大量随后丢弃的对象。
  const workSegments = unit.workSegments?.map((segment) =>
    segment === lastSegment && segment.assistantHistoryDefaultOpen !== lastSegmentDefaultOpen
      ? { ...segment, assistantHistoryDefaultOpen: lastSegmentDefaultOpen === true }
      : segment,
  );
  return {
    ...unit,
    isLastTurn,
    assistantHistoryDefaultOpen,
    ...(workSegments ? { workSegments } : {}),
  };
}

export function buildConversationTurnRenderUnits(
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions = {},
): ConversationTurnRenderUnit[] {
  return buildRenderUnits(rows, options);
}

// Bug 根因：整窗 builder 每帧都对全部 rows 分组并逐轮 materialize，unit 身份每帧全变，
// 下游所有按 unit 引用比较的 memo 全部失效；长会话流式输出明显卡顿（上游 2026-10 同根因修复）。
// 复用只需要逐项引用比较，因此不分配对象。
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** 与 rows 分区对应的 render unit（分区见 conversationProjectionStore.getConversationRowsPartition）。 */
export interface ConversationTurnRenderUnitsPartition {
  /** 历史段的 unit；只在历史派生结果变化时更换引用。 */
  readonly history: readonly ConversationTurnRenderUnit[];
  /** 尾轮的 unit（通常 0–1 个）。 */
  readonly tail: readonly ConversationTurnRenderUnit[];
}

function groupRenderDrafts(rows: readonly ConversationRow[]): DraftTurnRenderUnit[] {
  const units: DraftTurnRenderUnit[] = [];
  const unitByTurnId = new Map<string, DraftTurnRenderUnit>();

  const getOrCreateUnit = (turnId: string) => {
    const existing = unitByTurnId.get(turnId);
    if (existing) {
      return existing;
    }
    const unit = createDraftUnit(turnId);
    units.push(unit);
    unitByTurnId.set(turnId, unit);
    return unit;
  };

  for (const row of rows) {
    const unit = getOrCreateUnit(row.turnId);
    if (isTurnHeaderRow(row)) {
      unit.header = row;
      continue;
    }
    unit.orderedRows.push(row);
    if (isUserInputRow(row)) {
      unit.userInputs.push(row);
      continue;
    }
    if (isHookInvocationRow(row)) {
      unit.hookInvocations.push(row);
      continue;
    }
    unit.assistantWorkRows.push(row);
  }
  return units;
}

function buildRenderUnits(
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit[] {
  const drafts = stripStaleEmptyRunNotices(
    groupRenderDrafts(rows),
    options.nowMs ?? Date.now(),
  );
  const materializedUnits = drafts.map((unit, index) =>
    materializeDraftUnit(unit, index, drafts.length, options),
  );
  const keptUnits = materializedUnits.filter(shouldKeepRenderUnit);
  return keptUnits.map((unit, index) =>
    normalizeRenderUnitPosition(unit, index, keptUnits.length, options),
  );
}

/**
 * 输出与对 history ++ tail 整窗构建逐项相等，但每帧只 materialize 尾轮。
 *
 * 历史段结果按 history rows 数组引用缓存；只有历史中存在无 header 的轮次（读 phase）、
 * 仍在运行的轮次（读时钟）、会话忙闲翻转（读 sessionBusy）或存在空跑占位（读尾轮产出/
 * 3s 隐藏窗口）时，缓存键才额外带上对应输入。跨段规则在合并时处理：
 * - 尾轮 unit 被过滤掉时，历史末项按最后一轮重新归一化（tailDropped）；
 * - 尾轮给历史段提供 empty-run 撤销种子（stripStaleEmptyRunNotices 的 seed）。
 * EvoFlow 相对上游的语义差异（sessionBusy 末轮权威、隐藏 provider context、错挂行丢弃、
 * CUA/platform 媒体轮尾上提、empty-run 占位）都在 materializeDraftUnit/resolveTurnRunning/
 * strip 内部消化，选择器只负责「哪一段需要重算」。
 */
export function createConversationTurnRenderUnitsSelector() {
  type Entry = {
    draft: DraftTurnRenderUnit;
    isLast: boolean;
    phase: SessionPhase | undefined;
    clock: number | undefined;
    unit: ConversationTurnRenderUnit;
  };
  type HistoryCache = {
    rows: readonly ConversationRow[];
    draftCount: number;
    phaseDependent: boolean;
    phase: SessionPhase | undefined;
    clockDependent: boolean;
    clock: number;
    // sessionBusy 只影响 isLastTurn 轮；历史段多数时候与它无关，但缓存按引用复用时
    // 必须把 busy 翻转当作失效信号（轮次开始/结束各一帧，代价可忽略）。
    busy: boolean | undefined;
    // 历史段含空跑占位时，strip 结果依赖「尾轮是否有真实产出」与 3s 隐藏窗口。
    stripSeedRelevant: boolean;
    stripSeed: boolean;
    hidePendingUntil: number | null;
    // 已过滤并按“后面还有一个尾轮”归一化。
    units: ConversationTurnRenderUnit[];
    /**
     * 尾轮 unit 全部被过滤时，历史末项按最后一轮重新归一化后的历史数组。
     * 归一化只读 unit 与 session phase，所以按 phase 缓存即可。
     */
    tailDropped?: { phase: SessionPhase | undefined; units: readonly ConversationTurnRenderUnit[] };
  };
  // materialize 复用表按 turn key 分历史段与尾段；轮次在两段之间迁移时两边都查。
  let historyEntries = new Map<string, Entry>();
  let tailEntries = new Map<string, Entry>();
  let history: HistoryCache | null = null;

  const materializeReusing = (
    draft: DraftTurnRenderUnit,
    index: number,
    total: number,
    options: BuildConversationTurnRenderUnitsOptions & { nowMs: number },
    lookup: (key: string) => Entry | undefined,
    next: Map<string, Entry>,
  ): Entry => {
    const old = lookup(draft.key);
    const isLast = index === total - 1;
    const phase = draft.header ? undefined : options.sessionPhase;
    const clock = resolveTurnRunning(draft, options, isLast) ? options.nowMs : undefined;
    const unchanged =
      old &&
      old.draft.header === draft.header &&
      sameItems(old.draft.orderedRows, draft.orderedRows) &&
      old.isLast === isLast &&
      old.phase === phase &&
      old.clock === clock;
    const entry: Entry = {
      draft,
      isLast,
      phase,
      clock,
      unit: unchanged ? old.unit : materializeDraftUnit(draft, index, total, options),
    };
    next.set(draft.key, entry);
    return entry;
  };

  const isHistoryReusable = (
    cache: HistoryCache | null,
    rows: readonly ConversationRow[],
    options: BuildConversationTurnRenderUnitsOptions & { nowMs: number },
    tailHasReal: boolean,
  ): cache is HistoryCache =>
    cache !== null &&
    cache.rows === rows &&
    (!cache.phaseDependent || cache.phase === options.sessionPhase) &&
    (!cache.clockDependent || cache.clock === options.nowMs) &&
    cache.busy === options.sessionBusy &&
    (!cache.stripSeedRelevant ||
      (cache.stripSeed === tailHasReal &&
        (cache.hidePendingUntil === null || options.nowMs < cache.hidePendingUntil)));

  /** 历史段 strip 结果的时间依赖：仍有占位处于 3s 隐藏窗口时，窗口到期必须重算。 */
  const resolveHidePendingUntil = (
    drafts: readonly DraftTurnRenderUnit[],
    nowMs: number,
  ): number | null => {
    let pending: number | null = null;
    for (const draft of drafts) {
      for (const row of draft.orderedRows) {
        if (!isEmptyRunAssistantRow(row) || !shouldHideEmptyRunRow(row, nowMs)) continue;
        const created = Number((row as AssistantTextRow).createdAt) || 0;
        pending = Math.max(pending ?? 0, created + EMPTY_RUN_UI_HIDE_MS);
      }
    }
    return pending;
  };

  return (
    partition: ConversationRowsPartition,
    options: BuildConversationTurnRenderUnitsOptions = {},
  ): ConversationTurnRenderUnitsPartition => {
    const currentOptions = { ...options, nowMs: options.nowMs ?? Date.now() };
    const previousHistoryEntries = historyEntries;
    const previousTailEntries = tailEntries;
    // 尾段先成组并 strip（seed=false，与整窗反向扫描在尾段内的状态一致）；
    // 尾段的真实产出作为历史段 empty-run 撤销的种子。
    const tailDrafts = stripStaleEmptyRunNotices(
      groupRenderDrafts(partition.tail),
      currentOptions.nowMs,
    );
    const tailHasReal = tailDrafts.some(draftHasRealAssistantWork);

    // 历史段缓存判定：显式产出局部变量而非依赖谓词收窄（嵌套闭包的 let 上收窄不可靠）。
    let currentHistory: HistoryCache;
    if (
      history !== null &&
      isHistoryReusable(history, partition.history, currentOptions, tailHasReal)
    ) {
      currentHistory = history;
    } else {
      const drafts = stripStaleEmptyRunNotices(
        groupRenderDrafts(partition.history),
        currentOptions.nowMs,
        tailHasReal,
      );
      // 尾轮非空时历史 draft 都不是最后一个；窗口为空时两段都为空。
      const total = drafts.length + tailDrafts.length;
      const next = new Map<string, Entry>();
      let clockDependent = false;
      const materialized = drafts.map((draft, index) => {
        const entry = materializeReusing(
          draft,
          index,
          total,
          currentOptions,
          (key) => previousHistoryEntries.get(key) ?? previousTailEntries.get(key),
          next,
        );
        if (entry.clock !== undefined) clockDependent = true;
        return entry.unit;
      });
      historyEntries = next;
      const kept = materialized.filter(shouldKeepRenderUnit);
      // 先按“后面还有一个尾轮 unit”归一化；尾轮被过滤掉的情况在下面合并时处理。
      const units = kept.map((unit, index) =>
        normalizeRenderUnitPosition(unit, index, kept.length + 1, currentOptions),
      );
      const stripSeedRelevant = drafts.some((draft) =>
        draft.orderedRows.some(isEmptyRunAssistantRow),
      );
      currentHistory = {
        rows: partition.history,
        draftCount: drafts.length,
        phaseDependent: drafts.some((draft) => !draft.header),
        phase: currentOptions.sessionPhase,
        clockDependent,
        clock: currentOptions.nowMs,
        busy: currentOptions.sessionBusy,
        stripSeedRelevant,
        stripSeed: tailHasReal,
        hidePendingUntil: stripSeedRelevant
          ? resolveHidePendingUntil(drafts, currentOptions.nowMs)
          : null,
        units,
      };
      history = currentHistory;
    }

    const historyDraftCount = currentHistory.draftCount;
    const tailNext = new Map<string, Entry>();
    const tailKept = tailDrafts
      .map(
        (draft, index) =>
          materializeReusing(
            draft,
            historyDraftCount + index,
            historyDraftCount + tailDrafts.length,
            currentOptions,
            (key) => previousTailEntries.get(key) ?? previousHistoryEntries.get(key),
            tailNext,
          ).unit,
      )
      .filter(shouldKeepRenderUnit);
    tailEntries = tailNext;
    const historyCount = currentHistory.units.length;
    const tailUnits = tailKept.map((unit, index) =>
      normalizeRenderUnitPosition(
        unit,
        historyCount + index,
        historyCount + tailKept.length,
        currentOptions,
      ),
    );

    let historyUnits: readonly ConversationTurnRenderUnit[] = currentHistory.units;
    const lastIndex = historyCount - 1;
    if (tailUnits.length === 0 && lastIndex >= 0) {
      if (
        !currentHistory.tailDropped ||
        currentHistory.tailDropped.phase !== currentOptions.sessionPhase
      ) {
        // 归一化只改 isLastTurn 与默认展开，且只读其他字段，所以对已归一化的 unit 再做一次即可。
        const last = normalizeRenderUnitPosition(
          currentHistory.units[lastIndex]!,
          lastIndex,
          historyCount,
          currentOptions,
        );
        currentHistory.tailDropped = {
          phase: currentOptions.sessionPhase,
          units:
            last === currentHistory.units[lastIndex]
              ? currentHistory.units
              : [...currentHistory.units.slice(0, -1), last],
        };
      }
      historyUnits = currentHistory.tailDropped.units;
    }
    return { history: historyUnits, tail: tailUnits };
  };
}

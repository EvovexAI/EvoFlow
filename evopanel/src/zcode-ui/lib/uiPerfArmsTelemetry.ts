import {
  sanitizeTelemetryModelValue,
  type ArmsCustomEventPayload,
  type IPlatformService,
  type LaunchMarks,
} from "@zcode/shared";
import { logger } from "@/logger.js";

const UI_PERF_ARMS_GROUP = "ui_perf";

const UI_PERF_EVENT_LAUNCH_TO_INPUT = "perf_ui_launch_to_input";
const UI_PERF_EVENT_LAUNCH_ELECTRON_INIT = "perf_ui_launch_electron_init_ms";
const UI_PERF_EVENT_LAUNCH_APP_READY = "perf_ui_launch_app_ready_ms";
const UI_PERF_EVENT_LAUNCH_WINDOW = "perf_ui_launch_window_ms";
const UI_PERF_EVENT_LAUNCH_RENDERER_LOAD = "perf_ui_launch_renderer_load_ms";
const UI_PERF_EVENT_LAUNCH_REACT_COMMIT = "perf_ui_launch_react_commit_ms";
const UI_PERF_EVENT_LAUNCH_STARTUP_GATE = "perf_ui_launch_startup_gate_ms";

// 总时长超过该值视为时钟异常/挂起，整批丢弃，避免污染分布。
const LAUNCH_TO_INPUT_SANITY_MAX_MS = 300000;

const UI_PERF_EVENT_FIRST_TOKEN = "perf_ui_first_token";
const UI_PERF_EVENT_MESSAGE_COMPLETE = "perf_ui_message_complete";
const UI_PERF_EVENT_TURN_BREAKDOWN = "perf_ui_turn_breakdown";
const UI_PERF_EVENT_TOOL_CALL_DETAIL = "perf_ui_tool_call_detail";
const UI_PERF_EVENT_STREAM_STALL = "perf_ui_stream_stall";

// 超过该间隔(ms)未收到新 chunk 视为停顿并上报;value 仍为真实间隔。可据线上分布收紧。
// 工具调用(tool_call/tool_call_update)期间不计入:工具事件会 clearStreamStallTracking,
// 工具后第一个正文 chunk 视为首个,不与工具前的 chunk 比较,避免把工具执行误判为停顿。
const STREAM_STALL_REPORT_THRESHOLD_MS = 3000;

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

let armsReporter: ArmsReporter | null = null;

export function setUiPerfArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}

/**
 * `model` 在本组事件里来自 `detail.model_name`，自定义 provider 下是用户命名的编码值。
 * 在唯一出口统一归一，避免每个 report 函数各自处理后漏掉新增事件；归一只影响上报值，
 * 不改变调用方拿到的模型选择和本地日志。
 */
function sanitizeModelProperty(
  properties: ArmsCustomEventPayload["properties"],
): ArmsCustomEventPayload["properties"] {
  if (!properties || typeof properties.model !== "string") {
    return properties;
  }
  const model = sanitizeTelemetryModelValue(properties.model);
  return { ...properties, model: model || undefined };
}

// 原因:ARMS 属观测链路,UI 主流程(启动/发送/渲染)不得因埋点失败而中断。
function emit(payload: ArmsCustomEventPayload): void {
  if (!armsReporter) {
    return;
  }
  const sanitized: ArmsCustomEventPayload = {
    ...payload,
    properties: sanitizeModelProperty(payload.properties),
  };
  try {
    void Promise.resolve(armsReporter.reportArmsCustomEvent(sanitized)).catch((error) => {
      logger.warn("[ui-perf] ARMS 上报失败", { name: payload.name, error });
    });
  } catch (error) {
    logger.warn("[ui-perf] ARMS 上报异常", { name: payload.name, error });
  }
}

interface LaunchToInputTimings {
  marks: LaunchMarks;
  /** renderer/src/main.tsx 模块顶部 Date.now()（T4） */
  rendererStart: number;
  /** zcode-react-startup-ready 触发时 Date.now()（T5） */
  reactCommit: number;
  /** 启动门禁清除、输入框可用时 Date.now()（T6） */
  inputReady: number;
  /** 同一次启动的关联键 */
  sessionId: string;
}

function clampMs(ms: number): number {
  return Math.max(0, Math.round(ms));
}

function optionalRoundedNumber(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : undefined;
}

export function reportUiLaunchToInput(timings: LaunchToInputTimings): void {
  const { marks, rendererStart, reactCommit, inputReady, sessionId } = timings;
  const total = inputReady - marks.createdAt;
  // 6 段原始时长(未钳)。在发送前全部算出,以便整批校验。
  const stageMs = {
    electronInit: marks.mainStart - marks.createdAt,
    appReady: marks.appReady - marks.mainStart,
    window: marks.loadUrl - marks.appReady,
    rendererLoad: rendererStart - marks.loadUrl,
    reactCommit: reactCommit - rendererStart,
    startupGate: inputReady - reactCommit,
  };
  // 哨兵:异常总时长(时钟跳变/进程挂起)整批丢弃。
  if (total < 0 || total > LAUNCH_TO_INPUT_SANITY_MAX_MS) {
    logger.warn("[ui-perf] launch_to_input 总时长异常,丢弃", { total });
    return;
  }
  // 任一段为负(主进程 T0–T3 与渲染进程 T4–T6 间跨进程时钟偏移)则整批丢弃,
  // 否则 sum(6 段) != total,破坏看板依赖的恒等式。与总时长哨兵保持全有或全无。
  const negativeStage = Object.entries(stageMs).find(([, ms]) => ms < 0);
  if (negativeStage) {
    logger.warn("[ui-perf] launch_to_input 某段为负(跨进程时钟偏移/回拨),整批丢弃", {
      stage: negativeStage[0],
      ms: negativeStage[1],
    });
    return;
  }
  const properties = { session_id: sessionId };
  // 至此各段保证 >= 0,clampMs 的 max(0,...) 为冗余保险,仅用于一致的 Math.round 取整。
  const stages: { name: string; ms: number }[] = [
    { name: UI_PERF_EVENT_LAUNCH_TO_INPUT, ms: total },
    { name: UI_PERF_EVENT_LAUNCH_ELECTRON_INIT, ms: stageMs.electronInit },
    { name: UI_PERF_EVENT_LAUNCH_APP_READY, ms: stageMs.appReady },
    { name: UI_PERF_EVENT_LAUNCH_WINDOW, ms: stageMs.window },
    { name: UI_PERF_EVENT_LAUNCH_RENDERER_LOAD, ms: stageMs.rendererLoad },
    { name: UI_PERF_EVENT_LAUNCH_REACT_COMMIT, ms: stageMs.reactCommit },
    { name: UI_PERF_EVENT_LAUNCH_STARTUP_GATE, ms: stageMs.startupGate },
  ];
  for (const stage of stages) {
    emit({
      name: stage.name,
      group: UI_PERF_ARMS_GROUP,
      value: clampMs(stage.ms),
      properties,
    });
  }
}

export function reportUiFirstToken(params: {
  ttftMs: number;
  model?: string;
  talkId?: string;
  messageId?: string;
}): void {
  emit({
    name: UI_PERF_EVENT_FIRST_TOKEN,
    group: UI_PERF_ARMS_GROUP,
    value: Math.max(0, Math.round(params.ttftMs)),
    properties: {
      model: params.model,
      talk_id: params.talkId,
      message_id: params.messageId,
    },
  });
}

export function reportUiMessageComplete(params: {
  durationMs: number;
  result: string;
  model?: string;
  talkId?: string;
  messageId?: string;
}): void {
  emit({
    name: UI_PERF_EVENT_MESSAGE_COMPLETE,
    group: UI_PERF_ARMS_GROUP,
    value: Math.max(0, Math.round(params.durationMs)),
    properties: {
      result: params.result,
      model: params.model,
      talk_id: params.talkId,
      message_id: params.messageId,
    },
  });
}

export function reportUiTurnBreakdown(params: {
  durationMs: number;
  result: string;
  model?: string;
  talkId?: string;
  messageId?: string;
  ttftMs?: number;
  waitingMs?: number;
  toolCallTotal?: number;
  toolCallFailed?: number;
  agentStepCount?: number;
  retryCount?: number;
  fileChangeCount?: number;
  generatedCodeLines?: number;
}): void {
  const durationMs = Math.max(0, Math.round(params.durationMs));
  emit({
    name: UI_PERF_EVENT_TURN_BREAKDOWN,
    group: UI_PERF_ARMS_GROUP,
    value: durationMs,
    properties: {
      result: params.result,
      model: params.model,
      talk_id: params.talkId,
      message_id: params.messageId,
      duration_ms: durationMs,
      ttft_ms: optionalRoundedNumber(params.ttftMs),
      waiting_ms: optionalRoundedNumber(params.waitingMs),
      tool_call_total: optionalRoundedNumber(params.toolCallTotal),
      tool_call_failed: optionalRoundedNumber(params.toolCallFailed),
      agent_step_cnt: optionalRoundedNumber(params.agentStepCount),
      retry_cnt: optionalRoundedNumber(params.retryCount),
      file_change_cnt: optionalRoundedNumber(params.fileChangeCount),
      generated_code_lines: optionalRoundedNumber(params.generatedCodeLines),
    },
  });
}

export function reportUiToolCallDetail(params: {
  toolName?: string;
  status: string;
  talkId?: string;
  messageId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  childToolCallId?: string;
  childSessionId?: string;
  agentId?: string;
  agentType?: string;
  totalMs?: number;
  permissionWaitMs?: number;
  commandRunMs?: number;
  firstOutputMs?: number;
  noOutputMs?: number;
  exitCode?: number;
  timedOut?: boolean;
  outputBytes?: number;
  commandCategory?: string;
  commandName?: string;
  commandCount?: number;
  commandStatus?: string;
  fsReadMs?: number;
  fsWriteMs?: number;
  patchMatchMs?: number;
  fileCount?: number;
  totalBytes?: number;
  maxFileBytes?: number;
  hunkCount?: number;
  matchAttempts?: number;
  workspaceKind?: string;
}): void {
  const totalMs = optionalRoundedNumber(params.totalMs);
  const value =
    totalMs ??
    optionalRoundedNumber(params.commandRunMs) ??
    optionalRoundedNumber(params.fsWriteMs) ??
    optionalRoundedNumber(params.fsReadMs) ??
    0;
  emit({
    name: UI_PERF_EVENT_TOOL_CALL_DETAIL,
    group: UI_PERF_ARMS_GROUP,
    value,
    properties: {
      tool_name: params.toolName,
      status: params.status,
      talk_id: params.talkId,
      message_id: params.messageId,
      tool_call_id: params.toolCallId,
      parent_tool_call_id: params.parentToolCallId,
      child_tool_call_id: params.childToolCallId,
      child_session_id: params.childSessionId,
      agent_id: params.agentId,
      agent_type: params.agentType,
      total_ms: totalMs,
      permission_wait_ms: optionalRoundedNumber(params.permissionWaitMs),
      command_run_ms: optionalRoundedNumber(params.commandRunMs),
      first_output_ms: optionalRoundedNumber(params.firstOutputMs),
      no_output_ms: optionalRoundedNumber(params.noOutputMs),
      exit_code:
        typeof params.exitCode === "number" && Number.isFinite(params.exitCode)
          ? Math.round(params.exitCode)
          : undefined,
      timed_out: params.timedOut,
      output_bytes: optionalRoundedNumber(params.outputBytes),
      command_category: params.commandCategory,
      command_name: params.commandName,
      command_count: optionalRoundedNumber(params.commandCount),
      command_status: params.commandStatus,
      fs_read_ms: optionalRoundedNumber(params.fsReadMs),
      fs_write_ms: optionalRoundedNumber(params.fsWriteMs),
      patch_match_ms: optionalRoundedNumber(params.patchMatchMs),
      file_count: optionalRoundedNumber(params.fileCount),
      total_bytes: optionalRoundedNumber(params.totalBytes),
      max_file_bytes: optionalRoundedNumber(params.maxFileBytes),
      hunk_count: optionalRoundedNumber(params.hunkCount),
      match_attempts: optionalRoundedNumber(params.matchAttempts),
      workspace_kind: params.workspaceKind,
    },
  });
}

// 流式停顿:per-task 记录上一个正文 chunk 到达时刻,间隔超阈值则上报真实间隔。
const lastChunkAtByTask = new Map<string, number>();

export function recordStreamChunkArrival(
  taskId: string,
  options?: {
    waitingTool?: boolean;
    /** tracker 可用 workspace-scoped 内部 key；上报仍保持真实 talk_id。 */
    talkId?: string;
    messageId?: string;
    model?: string;
    chunkType?: "message" | "thought" | "unknown";
    now?: number;
  },
): void {
  const now = options?.now ?? Date.now();
  const last = lastChunkAtByTask.get(taskId);
  lastChunkAtByTask.set(taskId, now);
  if (last === undefined) {
    return;
  }
  const gapMs = now - last;
  if (gapMs <= STREAM_STALL_REPORT_THRESHOLD_MS) {
    return;
  }
  emit({
    name: UI_PERF_EVENT_STREAM_STALL,
    group: UI_PERF_ARMS_GROUP,
    value: Math.round(gapMs),
    properties: {
      stall_ms: Math.round(gapMs),
      waiting_tool: options?.waitingTool ?? false,
      model: options?.model,
      chunk_type: options?.chunkType,
      talk_id: options?.talkId ?? taskId,
      // 停顿结束时那个 chunk 的 messageId;正文/思考 chunk 常不带,取不到留空(与其它字段口径一致)。
      message_id: options?.messageId,
    },
  });
}

export function clearStreamStallTracking(taskId: string): void {
  lastChunkAtByTask.delete(taskId);
}

// 输入框卡顿:在 Lexical update listener 内测「单次输入处理耗时」(getEditorMarkdown+onChange 同步段)。
// 与 stream_stall(输出侧)区分:此为输入侧。只上报超阈卡点,事件量最小。
const UI_PERF_EVENT_INPUT_LAG = "perf_ui_input_lag";

// 保守起点:只抓最严重卡顿。可据线上分布往下收紧。
const INPUT_LAG_REPORT_THRESHOLD_MS = 500;
// 超此值大概率是断点调试/标签页挂起/设备休眠唤醒,丢弃避免污染分布。
const INPUT_LAG_SANITY_MAX_MS = 5000;

// 判定抽成纯函数便于单测:程序化改写(粘贴/setText/mention/历史回填)与 IME 组合态
// 都不算打字卡顿,即使耗时超阈也跳过。
function shouldReportInputLag(args: {
  lagMs: number;
  isProgrammatic: boolean;
  isComposing: boolean;
}): boolean {
  if (args.isProgrammatic || args.isComposing) {
    return false;
  }
  return args.lagMs > INPUT_LAG_REPORT_THRESHOLD_MS && args.lagMs <= INPUT_LAG_SANITY_MAX_MS;
}

export function recordInputLag(params: {
  lagMs: number;
  textLength: number;
  isProgrammatic: boolean;
  isComposing: boolean;
  taskId?: string;
}): void {
  if (
    !shouldReportInputLag({
      lagMs: params.lagMs,
      isProgrammatic: params.isProgrammatic,
      isComposing: params.isComposing,
    })
  ) {
    return;
  }
  const lagMs = Math.round(params.lagMs);
  emit({
    name: UI_PERF_EVENT_INPUT_LAG,
    group: UI_PERF_ARMS_GROUP,
    value: lagMs,
    properties: {
      lag_ms: lagMs,
      text_length: params.textLength,
      // 草稿态无 taskId,留空与其它 ui_perf 事件口径一致。
      task_id: params.taskId,
    },
  });
}

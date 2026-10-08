import {
  LOCAL_TTFT_CLOCK_TTL_MS,
  LOCAL_TTFT_MAX_DETAILS,
  type LocalTtftContext,
  type LocalTtftCalibration,
  type LocalTtftFacts,
  type LocalTtftRecord,
  type LocalTtftOutputKind,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
export interface LocalTtftPending {
  context: LocalTtftContext;
  workspace: string;
  start: number;
  wallStart: number;
  clockInvalid?: boolean;
  closed?: boolean;
  outcome?: LocalTtftRecord["outcome"];
  textClosed?: boolean;
  firstAt?: number;
  checkpointRevision: number;
  checkpointSignature?: string;
  dispatch?: number;
  commandId?: string;
  sessionId?: string;
  facts?: LocalTtftFacts;
  first?: LocalTtftOutputKind;
  lastSeq: number;
  sendMode: "idle" | "queued" | "guided";
  visibility: "foreground" | "background" | "background_returned";
  visibilityChanges: { at: number; foreground: boolean }[];
  confirmationStart?: number;
  confirmations: NonNullable<LocalTtftRecord["details"]>;
  rows: Map<number, { turnId: string; kind: ConversationRow["kind"] }>;
}

export function buildLocalTtftRecord(
  pending: LocalTtftPending,
  kind: LocalTtftRecord["kind"],
  outcome: LocalTtftRecord["outcome"],
  current: number,
  wall: number,
  calibration?: LocalTtftCalibration,
): LocalTtftRecord {
  pending.clockInvalid ||= Math.abs(wall - pending.wallStart - (current - pending.start)) > 100;
  const end = kind === "checkpoint" && pending.firstAt !== undefined ? pending.firstAt : current;
  const facts = pending.facts;
  const aligned =
    calibration &&
    facts?.instanceId === calibration.instanceId &&
    end >= calibration.measuredAt &&
    end - calibration.measuredAt <= LOCAL_TTFT_CLOCK_TTL_MS &&
    !pending.clockInvalid &&
    !facts.clockInvalid;
  const offset = aligned ? calibration.offsetMs : 0;
  const intervals: LocalTtftRecord["intervals"] = [];
  let invalid = pending.clockInvalid === true || facts?.clockInvalid === true;
  const interval = (
    stage: LocalTtftRecord["intervals"][number]["stage"],
    start: number | undefined,
    stop: number | undefined,
    source: "renderer" | "cli" | "aligned",
  ) => {
    if (start === undefined || stop === undefined) return;
    if (stop < start || !Number.isFinite(stop - start)) {
      invalid = true;
      return;
    }
    intervals.push({ stage, start, end: stop, source });
  };
  interval("renderer_prepare", pending.start, pending.dispatch, "renderer");
  if (facts) {
    const at = (value: number | undefined) => (value === undefined ? undefined : value + offset);
    if (aligned) interval("command_admission", pending.dispatch, at(facts.admittedAt), "aligned");
    interval("execution_wait", at(facts.admittedAt), at(facts.executionAt), "cli");
    interval("request_prepare", at(facts.executionAt), at(facts.requestAt), "cli");
    interval("model_request", at(facts.requestAt), at(facts.outputAt), "cli");
    if (aligned && pending.firstAt !== undefined)
      interval("output_return", at(facts.outputAt), pending.firstAt, "aligned");
  }
  return {
    version: 1,
    observationId: pending.context.observationId,
    commandId: pending.commandId,
    sessionId: facts?.sessionId,
    turnId: facts?.turnId,
    productTurnId: facts?.productTurnId,
    queryId: facts?.queryId,
    logicalCallId: facts?.logicalCallId,
    cliVersion: facts?.cliVersion,
    requestId: facts?.requestId,
    cliInstanceId: facts?.instanceId,
    kind,
    ...(kind === "checkpoint"
      ? { checkpointId: `checkpoint:${pending.checkpointRevision++}` }
      : {}),
    outcome,
    start: pending.start,
    end,
    firstOutputKind: pending.first,
    sendMode: facts?.sendMode ?? pending.sendMode,
    visibility: pending.visibility,
    visibilityChanges: [...pending.visibilityChanges],
    userWaitMs: pending.confirmations.reduce(
      (sum, detail) => sum + (detail.end! - detail.start),
      0,
    ),
    details: [
      ...pending.confirmations,
      ...(facts?.details ?? []).map((detail) => ({
        ...detail,
        start: detail.start + offset,
        ...(detail.end === undefined ? {} : { end: detail.end + offset }),
      })),
    ].slice(0, LOCAL_TTFT_MAX_DETAILS),
    truncated:
      facts?.truncated ||
      (facts?.details?.length ?? 0) + pending.confirmations.length > LOCAL_TTFT_MAX_DETAILS,
    timingReliable: !pending.clockInvalid,
    cliTimingReliable: facts?.clockInvalid !== true,
    ...(aligned && facts?.executionAt !== undefined && end >= facts.executionAt + offset
      ? { executionMs: end - facts.executionAt - offset }
      : {}),
    // Bug 原因：此前只要未对齐就标 clock_invalid，把“校准缺失/过期”与真实时钟异常混为一类，
    // 可靠的排队样本被默认看板当作坏时钟过滤。未对齐只意味着跨进程阶段缺失，按 missing 记。
    quality: invalid ? "clock_invalid" : intervals.length === 6 ? "complete" : "missing",
    ...(calibration ? { clockErrorMs: calibration.errorMs } : {}),
    intervals,
    model: facts?.model,
    provider: facts?.provider,
  };
}

import type {
  InputId,
  QueryId,
  TraceId,
  ZCodeStreamEvent,
  ZCodeTaskNetworkDebugStatusType,
} from "./zcode-task-types-core.js";

const MODEL_NETWORK_STATUS_TYPES = new Set<ZCodeTaskNetworkDebugStatusType>([
  "model_request_started",
  "model_request_completed",
  "model_request_failed",
  "model_retry_scheduled",
  "model_stream_stalled",
]);

export function zcodeTaskNetworkDebugStatusFromPayload(params: {
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  eventId?: string;
  payload: Record<string, unknown>;
}): Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }> | null {
  const statusType = networkStatusTypeValue(params.payload.type);
  if (!statusType) {
    return null;
  }

  const requestHeaders = stringRecordValue(params.payload.requestHeaders);
  const responseHeaders = stringRecordValue(params.payload.responseHeaders);
  const model = asRecord(params.payload.model);
  const requestId = stringValue(params.payload.requestId);
  const queryId = stringValue(params.payload.queryId) as QueryId | undefined;
  const resolvedQueryId = params.queryId ?? queryId;
  const attempt = positiveIntegerValue(params.payload.attempt);
  const timestamp = stringValue(params.payload.timestamp);
  const eventKey =
    params.eventId ??
    [
      params.traceId,
      params.inputId ?? "no-input",
      statusType,
      requestId ?? "no-request",
      attempt ?? "no-attempt",
      timestamp ?? "no-time",
    ].join(":");

  return {
    type: "task_network_debug_status",
    taskId: params.taskId,
    traceId: params.traceId,
    ...(params.inputId ? { inputId: params.inputId } : {}),
    ...(resolvedQueryId ? { queryId: resolvedQueryId } : {}),
    eventKey,
    ...(params.eventId ? { eventId: params.eventId } : {}),
    statusType,
    ...(requestId ? { requestId } : {}),
    ...(stringValue(model.providerId) ? { providerId: stringValue(model.providerId) } : {}),
    ...(stringValue(model.modelId) ? { modelId: stringValue(model.modelId) } : {}),
    ...(stringValue(params.payload.providerKind)
      ? { providerKind: stringValue(params.payload.providerKind) }
      : {}),
    ...(stringValue(params.payload.transport)
      ? { transport: stringValue(params.payload.transport) }
      : {}),
    ...(stringValue(params.payload.baseURL)
      ? { baseURL: stringValue(params.payload.baseURL) }
      : {}),
    ...(stringValue(params.payload.querySource)
      ? { querySource: stringValue(params.payload.querySource) }
      : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(positiveIntegerValue(params.payload.maxAttempts) !== undefined
      ? { maxAttempts: positiveIntegerValue(params.payload.maxAttempts) }
      : {}),
    ...(positiveIntegerValue(params.payload.nextAttempt) !== undefined
      ? { nextAttempt: positiveIntegerValue(params.payload.nextAttempt) }
      : {}),
    ...(booleanValue(params.payload.retryable) !== undefined
      ? { retryable: booleanValue(params.payload.retryable) }
      : {}),
    ...(nonNegativeIntegerValue(params.payload.statusCode) !== undefined
      ? { statusCode: nonNegativeIntegerValue(params.payload.statusCode) }
      : {}),
    ...(nonNegativeNumberValue(params.payload.durationMs) !== undefined
      ? { durationMs: nonNegativeNumberValue(params.payload.durationMs) }
      : {}),
    ...(nonNegativeNumberValue(params.payload.delayMs) !== undefined
      ? { delayMs: nonNegativeNumberValue(params.payload.delayMs) }
      : {}),
    ...(nonNegativeNumberValue(params.payload.idleMs) !== undefined
      ? { idleMs: nonNegativeNumberValue(params.payload.idleMs) }
      : {}),
    ...(nonNegativeNumberValue(params.payload.timeoutMs) !== undefined
      ? { timeoutMs: nonNegativeNumberValue(params.payload.timeoutMs) }
      : {}),
    ...(stringValue(params.payload.reason) ? { reason: stringValue(params.payload.reason) } : {}),
    ...(stringValue(params.payload.message)
      ? { message: stringValue(params.payload.message) }
      : {}),
    ...(timestamp ? { timestamp } : {}),
    requestHeaders,
    responseHeaders,
    requestHeaderCount:
      nonNegativeIntegerValue(params.payload.requestHeaderCount) ??
      Object.keys(requestHeaders).length,
    responseHeaderCount:
      nonNegativeIntegerValue(params.payload.responseHeaderCount) ??
      Object.keys(responseHeaders).length,
  };
}

function networkStatusTypeValue(value: unknown): ZCodeTaskNetworkDebugStatusType | undefined {
  return typeof value === "string" && MODEL_NETWORK_STATUS_TYPES.has(value as never)
    ? (value as ZCodeTaskNetworkDebugStatusType)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringRecordValue(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, entryValue]) => [key, entryValue]),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function nonNegativeNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

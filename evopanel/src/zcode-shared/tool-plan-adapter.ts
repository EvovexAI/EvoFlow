import type { ZCodePlanStep } from "./zcode-task-types-core.js";

const TODO_TOOL_NAME_PATTERN =
  /(?:^|[_\s-])(?:todo[_\s-]*(?:read|write)|update[_\s-]*plan)(?:$|[_\s-])/i;
const PLAN_COLLECTION_KEYS = ["todos", "plan", "steps", "items"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizePlanStatus(value: unknown): ZCodePlanStep["status"] | null {
  const status = readString(value)?.replace(/-/g, "_").toLowerCase();
  if (status === "pending" || status === "in_progress" || status === "completed") {
    return status;
  }
  return null;
}

function parsePlanStep(value: unknown, index: number): ZCodePlanStep | null {
  if (typeof value === "string") {
    const title = value.trim();
    return title ? { id: title, title, status: index === 0 ? "in_progress" : "pending" } : null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const title =
    readString(value.content) ??
    readString(value.step) ??
    readString(value.title) ??
    readString(value.text) ??
    readString(value.activeForm);
  const status = normalizePlanStatus(value.status);
  if (!title || !status) {
    return null;
  }

  return {
    id: readString(value.id) ?? title,
    title,
    status,
  };
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readPlanCollection(input: unknown): unknown[] | null {
  const value = typeof input === "string" ? parseJsonValue(input) : input;
  if (!isRecord(value)) {
    return null;
  }
  for (const key of PLAN_COLLECTION_KEYS) {
    const collection = value[key];
    if (Array.isArray(collection)) {
      return collection;
    }
  }
  return null;
}

function extractPlanStepsFromValue(value: unknown): ZCodePlanStep[] | null {
  const collection = readPlanCollection(value);
  if (!collection || collection.length === 0) {
    return null;
  }

  const steps = collection
    .map((item, index) => parsePlanStep(item, index))
    .filter((step): step is ZCodePlanStep => step !== null);

  return steps.length === collection.length ? steps : null;
}

function collectOutputCandidates(output: unknown): unknown[] {
  const candidates: unknown[] = [output];
  const parsedOutput = typeof output === "string" ? parseJsonValue(output) : undefined;
  if (parsedOutput !== undefined) {
    candidates.push(parsedOutput);
  }

  if (isRecord(output)) {
    for (const key of ["content", "output", "result"] as const) {
      const value = output[key];
      candidates.push(value);
      if (typeof value === "string") {
        const parsedValue = parseJsonValue(value);
        if (parsedValue !== undefined) {
          candidates.push(parsedValue);
        }
      }
    }
  }

  return candidates;
}

export function isTodoPlanToolName(value: string | null | undefined): boolean {
  return typeof value === "string" && TODO_TOOL_NAME_PATTERN.test(value.trim());
}

export function isMainAgentToolProjectionSource(...candidates: unknown[]): boolean {
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    // subagent / workflow 会把子工具镜像进父 session；这些 TodoWrite
    // 只属于对应父工具树，不能覆盖主任务顶部 todo 摘要。
    if (readString(candidate.source) === "subagent") {
      return false;
    }
    if (readString(candidate.parentToolCallId) || readString(candidate.parentToolUseId)) {
      return false;
    }
  }
  return true;
}

export function extractPlanStepsFromToolInput(params: {
  title?: string;
  kind?: string;
  input: unknown;
}): ZCodePlanStep[] | null {
  const fingerprint = [params.title, params.kind].filter(Boolean).join(" ");
  if (!isTodoPlanToolName(fingerprint)) {
    return null;
  }

  return extractPlanStepsFromValue(params.input);
}

export function extractPlanStepsFromToolOutput(params: {
  title?: string;
  kind?: string;
  output: unknown;
}): ZCodePlanStep[] | null {
  const fingerprint = [params.title, params.kind].filter(Boolean).join(" ");
  if (!isTodoPlanToolName(fingerprint)) {
    return null;
  }

  for (const candidate of collectOutputCandidates(params.output)) {
    const steps = extractPlanStepsFromValue(candidate);
    if (steps) {
      return steps;
    }
  }

  return null;
}

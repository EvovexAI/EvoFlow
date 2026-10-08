import {
  getZCodeToolFamilyForName,
  isTodoPlanToolName,
  isZCodeFileContentWriteToolName,
  normalizeZCodeToolName,
  type ZCodeKnownToolName,
  type ZCodeToolFamily,
} from "@zcode/shared";
import { normalizeAskUserQuestionInput, readAskUserQuestionInput } from "@/lib/askUserQuestion.js";

export type ToolCallPresentationFamily =
  | ZCodeToolFamily
  | "plan-guidance"
  | "switch-mode"
  | "explore"
  | "unknown";

export type ToolCallIdentitySource =
  | "toolName"
  | "kind"
  | "title"
  | "raw"
  | "raw-zcode-meta"
  | "legacy-kind"
  | "legacy-title"
  | "legacy-payload"
  | "unknown";

export interface ToolCallIdentity {
  toolName: ZCodeKnownToolName | string | null;
  family: ToolCallPresentationFamily;
  source: ToolCallIdentitySource;
  isLegacy: boolean;
}

interface ToolIdentityLike {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  input?: unknown;
  raw?: unknown;
}

const UNKNOWN_TOOL_IDENTITY: ToolCallIdentity = {
  toolName: null,
  family: "unknown",
  source: "unknown",
  isLegacy: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return readString(current);
}

function normalizeLegacyToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_") ?? ""
  );
}

function identityFromKnownToolName(
  value: string | null | undefined,
  source: ToolCallIdentitySource,
): ToolCallIdentity | null {
  const toolName = normalizeZCodeToolName(value);
  if (!toolName) {
    return null;
  }
  const family = getZCodeToolFamilyForName(toolName);
  if (!family) {
    return null;
  }
  return {
    toolName,
    family,
    source,
    isLegacy: false,
  };
}

function identityFromLegacyFamily(
  toolName: string | null,
  family: ToolCallPresentationFamily,
  source: ToolCallIdentitySource,
): ToolCallIdentity {
  return {
    toolName,
    family,
    source,
    isLegacy: true,
  };
}

function readRawToolNameCandidates(raw: unknown) {
  return {
    direct:
      readNestedString(raw, ["toolName"]) ??
      readNestedString(raw, ["tool_name"]) ??
      readNestedString(raw, ["name"]),
    zcode: readNestedString(raw, ["_meta", "zcode", "toolName"]),
    rawKind: readNestedString(raw, ["kind"]),
    rawTitle: readNestedString(raw, ["title"]),
  };
}

function isLegacyAgentTool(
  toolCall: ToolIdentityLike,
  rawNames: ReturnType<typeof readRawToolNameCandidates>,
) {
  const kind = normalizeLegacyToken(toolCall.kind);
  const title = normalizeLegacyToken(toolCall.title);
  const rawDirect = normalizeLegacyToken(rawNames.direct);
  const rawZCode = normalizeLegacyToken(rawNames.zcode);

  return (
    rawZCode === "agent" ||
    rawDirect === "agent" ||
    kind === "agent" ||
    (kind === "think" && (title === "agent" || title === "task")) ||
    (kind === "think" &&
      isRecord(toolCall.input) &&
      typeof toolCall.input.subagent_type === "string")
  );
}

function isLegacySkillTool(toolCall: ToolIdentityLike) {
  const kind = normalizeLegacyToken(toolCall.kind);
  const title = normalizeLegacyToken(toolCall.title);
  return (
    title === "skill" ||
    kind === "skill" ||
    (kind === "other" && isRecord(toolCall.input) && typeof toolCall.input.skill === "string")
  );
}

function hasAskUserQuestionPayload(toolCall: ToolIdentityLike): boolean {
  return normalizeAskUserQuestionInput(readAskUserQuestionInput(toolCall)).questions.length > 0;
}

function isLegacyGoalToolToken(value: string): boolean {
  return value === "goalcreate" || value === "goalupdate";
}

function resolveLegacyKindFamily(kind: string): ToolCallPresentationFamily | null {
  if (/^(?:read|view|open|cat|head|tail|read_file)(?:_|$)/i.test(kind)) {
    return "file-read";
  }
  if (
    /(?:^|_)(?:edit|patch|replace|multi_edit|multiedit|write|create|save|apply_patch)(?:_|$)/i.test(
      kind,
    )
  ) {
    return "file-write";
  }
  if (/^(?:execute|run|exec|bash|shell|command|terminal)(?:_|$)/i.test(kind)) {
    return "shell";
  }
  if (
    /^(?:search|grep|find|fetch|web_search|web_fetch|webfetch|query|lookup|glob|list|ls|dir|tree)(?:_|$)/i.test(
      kind,
    )
  ) {
    return "search";
  }
  if (/^(?:explore|inspect)(?:_|$)/i.test(kind)) {
    return "explore";
  }
  return null;
}

function isPlanModeExitToken(value: string): boolean {
  return (
    value === "switch_mode" ||
    value === "switchmode" ||
    value === "exited_plan_mode" ||
    value === "exitedplanmode" ||
    value === "exit_plan_mode" ||
    value === "exitplanmode"
  );
}

export function resolveToolCallIdentity(toolCall: ToolIdentityLike): ToolCallIdentity {
  const rawNames = readRawToolNameCandidates(toolCall.raw);
  const normalizedKind = normalizeLegacyToken(toolCall.kind);
  const normalizedTitle = normalizeLegacyToken(toolCall.title);

  if (normalizedKind === "explore") {
    return identityFromLegacyFamily("Explore", "explore", "legacy-kind");
  }

  for (const candidate of [
    { value: toolCall.toolName, source: "toolName" as const },
    { value: toolCall.kind, source: "kind" as const },
    { value: rawNames.direct, source: "raw" as const },
    { value: rawNames.zcode, source: "raw-zcode-meta" as const },
  ]) {
    const identity = identityFromKnownToolName(candidate.value, candidate.source);
    if (identity) {
      return identity;
    }
  }

  if (isLegacyAgentTool(toolCall, rawNames)) {
    return identityFromLegacyFamily(
      rawNames.direct ?? rawNames.zcode ?? "Agent",
      "agent",
      "legacy-payload",
    );
  }

  // `Task` 现在是现役 Claude 兼容工具名，但历史 ZCode Agent 投影会用
  // kind="think" + title="Task" 表示子 agent 活动。title 只是展示名，必须放在
  // legacy payload 判断之后，避免把旧会话误升级成非 legacy 工具身份。
  const titleIdentity = identityFromKnownToolName(toolCall.title, "title");
  if (titleIdentity) {
    return titleIdentity;
  }

  if (
    [
      toolCall.toolName,
      toolCall.kind,
      toolCall.title,
      rawNames.direct,
      rawNames.rawKind,
      rawNames.rawTitle,
    ]
      .filter((value): value is string => typeof value === "string")
      .some(isTodoPlanToolName)
  ) {
    return identityFromLegacyFamily("TodoWrite", "todo", "legacy-title");
  }

  if (
    // GoalCreate/GoalUpdate 已不再是现役模型工具，但历史 session 仍可能有这些
    // tool call；这里作为 legacy goal 渲染，避免重新把它们放回 shared known tool list。
    [
      toolCall.toolName,
      toolCall.kind,
      toolCall.title,
      rawNames.direct,
      rawNames.rawKind,
      rawNames.rawTitle,
    ]
      .filter((value): value is string => typeof value === "string")
      .map(normalizeLegacyToken)
      .some(isLegacyGoalToolToken)
  ) {
    return identityFromLegacyFamily(
      toolCall.toolName?.trim() ?? toolCall.kind?.trim() ?? "GoalUpdate",
      "goal",
      "legacy-title",
    );
  }

  if (normalizedTitle === "enterplanmode") {
    return identityFromLegacyFamily("EnterPlanMode", "plan-guidance", "legacy-title");
  }

  if (
    // 当前 ZCode Agent 传给 app 的 plan mode 退出工具是 ExitPlanMode，
    // normalize 后没有下划线；旧兼容只认 switch_mode / Exited Plan Mode，导致计划卡片走 fallback。
    [
      toolCall.toolName,
      toolCall.kind,
      toolCall.title,
      rawNames.direct,
      rawNames.zcode,
      rawNames.rawKind,
      rawNames.rawTitle,
    ]
      .filter((value): value is string => typeof value === "string")
      .map(normalizeLegacyToken)
      .some(isPlanModeExitToken)
  ) {
    return identityFromLegacyFamily("switch_mode", "switch-mode", "legacy-kind");
  }

  if (isLegacySkillTool(toolCall)) {
    return identityFromLegacyFamily("Skill", "skill", "legacy-payload");
  }

  if (
    normalizedKind === "ask_question" ||
    normalizedTitle === "askuserquestion" ||
    hasAskUserQuestionPayload(toolCall)
  ) {
    return identityFromLegacyFamily("AskUserQuestion", "ask-user-question", "legacy-payload");
  }

  const legacyKindFamily = resolveLegacyKindFamily(normalizedKind);
  if (legacyKindFamily) {
    return identityFromLegacyFamily(toolCall.kind?.trim() ?? null, legacyKindFamily, "legacy-kind");
  }

  const titlePrefixFamily = resolveLegacyKindFamily(
    normalizeLegacyToken(toolCall.title).split("_")[0] ?? "",
  );
  if (titlePrefixFamily === "file-read") {
    return identityFromLegacyFamily(toolCall.title?.trim() ?? null, "file-read", "legacy-title");
  }

  return UNKNOWN_TOOL_IDENTITY;
}

export function isFileContentWriteToolCall(
  toolCall: ToolIdentityLike,
  identity = resolveToolCallIdentity(toolCall),
): boolean {
  if (identity.family !== "file-write") {
    return false;
  }
  if (isZCodeFileContentWriteToolName(identity.toolName)) {
    return true;
  }
  const legacyKind = normalizeLegacyToken(toolCall.kind);
  return /^(?:write|create|save)(?:_|$)/i.test(legacyKind);
}

export function isFileDiffToolCall(
  toolCall: ToolIdentityLike,
  identity = resolveToolCallIdentity(toolCall),
): boolean {
  return identity.family === "file-write" && !isFileContentWriteToolCall(toolCall, identity);
}

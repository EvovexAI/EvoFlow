export const ZCODE_E2E_FS_FAULTS_ENV = "ZCODE_E2E_FS_FAULTS";
export const ZCODE_E2E_FS_FAULTS_ALLOW_ENV = "ZCODE_E2E_FS_FAULTS_ALLOW";

export type FsFaultOperation =
  | "any"
  | "appendFile"
  | "createWriteStream"
  | "mkdir"
  | "open"
  | "readFile"
  | "readdir"
  | "rename"
  | "rm"
  | "sqliteOpen"
  | "sqliteRun"
  | "stat"
  | "writeFile";

export interface FsFaultRuleConfig {
  id: string;
  code: string;
  operations?: readonly FsFaultOperation[];
  pathIncludes?: string;
  pathEndsWith?: string;
  pathRegex?: string;
  maxMatches?: number;
  message?: string;
}

export interface FsFaultCheckInput {
  operation: FsFaultOperation;
  path: string;
}

export interface FsFaultHit {
  id: string;
  code: string;
  operation: FsFaultOperation;
  path: string;
  matchIndex: number;
  matchedAt: string;
}

export interface InjectedFsFaultError extends NodeJS.ErrnoException {
  zcodeFsFaultId: string;
}

export interface FsFaultInjector {
  isEnabled(): boolean;
  maybeThrow(input: FsFaultCheckInput): void;
  getHits(): readonly FsFaultHit[];
  reset(): void;
}

interface NormalizedFsFaultRule {
  code: string;
  id: string;
  maxMatches: number;
  message?: string;
  operations: ReadonlySet<FsFaultOperation>;
  pathEndsWith?: string;
  pathIncludes?: string;
  pathRegex?: RegExp;
  matchedCount: number;
}

const SUPPORTED_OPERATIONS = new Set<FsFaultOperation>([
  "any",
  "appendFile",
  "createWriteStream",
  "mkdir",
  "open",
  "readFile",
  "readdir",
  "rename",
  "rm",
  "sqliteOpen",
  "sqliteRun",
  "stat",
  "writeFile",
]);

function normalizePathForFaultMatch(path: string): string {
  return path.replace(/\\/g, "/");
}

function normalizePathPattern(pattern: string | undefined): string | undefined {
  return pattern === undefined ? undefined : normalizePathForFaultMatch(pattern);
}

function assertNonEmptyString(value: unknown, field: string, ruleIndex: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Invalid fs fault rule at index ${ruleIndex}: ${field} must be a non-empty string`,
    );
  }
  return value.trim();
}

function parseOperations(value: unknown, ruleIndex: number): readonly FsFaultOperation[] {
  if (value === undefined) {
    return ["any"];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `Invalid fs fault rule at index ${ruleIndex}: operations must be a non-empty array`,
    );
  }
  return value.map((operation) => {
    if (typeof operation !== "string" || !SUPPORTED_OPERATIONS.has(operation as FsFaultOperation)) {
      throw new Error(
        `Invalid fs fault rule at index ${ruleIndex}: unsupported operation ${String(operation)}`,
      );
    }
    return operation as FsFaultOperation;
  });
}

function parseMaxMatches(value: unknown, ruleIndex: number): number {
  if (value === undefined) {
    return 1;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `Invalid fs fault rule at index ${ruleIndex}: maxMatches must be a non-negative integer`,
    );
  }
  return value;
}

function parseOptionalString(value: unknown, field: string, ruleIndex: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid fs fault rule at index ${ruleIndex}: ${field} must be a string`);
  }
  return value;
}

function normalizeRule(input: FsFaultRuleConfig, ruleIndex: number): NormalizedFsFaultRule {
  const record = input as unknown as Record<string, unknown>;
  const id = assertNonEmptyString(record.id, "id", ruleIndex);
  const code = assertNonEmptyString(record.code, "code", ruleIndex);
  const operations = new Set(parseOperations(record.operations, ruleIndex));
  const maxMatches = parseMaxMatches(record.maxMatches, ruleIndex);
  const pathIncludes = normalizePathPattern(
    parseOptionalString(record.pathIncludes, "pathIncludes", ruleIndex),
  );
  const pathEndsWith = normalizePathPattern(
    parseOptionalString(record.pathEndsWith, "pathEndsWith", ruleIndex),
  );
  const pathRegexRaw = parseOptionalString(record.pathRegex, "pathRegex", ruleIndex);
  const message = parseOptionalString(record.message, "message", ruleIndex);

  let pathRegex: RegExp | undefined;
  if (pathRegexRaw !== undefined) {
    try {
      pathRegex = new RegExp(pathRegexRaw);
    } catch (error) {
      throw new Error(
        `Invalid fs fault rule at index ${ruleIndex}: pathRegex is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    code,
    id,
    matchedCount: 0,
    maxMatches,
    message,
    operations,
    pathEndsWith,
    pathIncludes,
    pathRegex,
  };
}

function operationMatches(rule: NormalizedFsFaultRule, operation: FsFaultOperation): boolean {
  return rule.operations.has("any") || rule.operations.has(operation);
}

function pathMatches(rule: NormalizedFsFaultRule, path: string): boolean {
  const normalizedPath = normalizePathForFaultMatch(path);
  if (rule.pathIncludes !== undefined && !normalizedPath.includes(rule.pathIncludes)) {
    return false;
  }
  if (rule.pathEndsWith !== undefined && !normalizedPath.endsWith(rule.pathEndsWith)) {
    return false;
  }
  if (rule.pathRegex !== undefined && !rule.pathRegex.test(normalizedPath)) {
    return false;
  }
  return true;
}

function hasRemainingMatches(rule: NormalizedFsFaultRule): boolean {
  return rule.maxMatches === 0 || rule.matchedCount < rule.maxMatches;
}

function createInjectedFsFaultError(input: {
  code: string;
  id: string;
  message?: string;
  operation: FsFaultOperation;
  path: string;
}): InjectedFsFaultError {
  const error = new Error(
    input.message ?? `Injected fs fault ${input.code} for ${input.operation}: ${input.path}`,
  ) as InjectedFsFaultError;
  error.code = input.code;
  error.path = input.path;
  error.syscall = input.operation;
  error.zcodeFsFaultId = input.id;
  return error;
}

export function isInjectedFsFaultError(error: unknown): error is InjectedFsFaultError {
  return (
    typeof error === "object" &&
    error !== null &&
    "zcodeFsFaultId" in error &&
    typeof (error as { zcodeFsFaultId?: unknown }).zcodeFsFaultId === "string"
  );
}

export function createFsFaultInjector(rules: readonly FsFaultRuleConfig[] = []): FsFaultInjector {
  const normalizedRules = rules.map((rule, index) => normalizeRule(rule, index));
  const hits: FsFaultHit[] = [];

  return {
    isEnabled(): boolean {
      return normalizedRules.length > 0;
    },

    maybeThrow(input: FsFaultCheckInput): void {
      for (const rule of normalizedRules) {
        if (
          !hasRemainingMatches(rule) ||
          !operationMatches(rule, input.operation) ||
          !pathMatches(rule, input.path)
        ) {
          continue;
        }

        rule.matchedCount += 1;
        hits.push({
          code: rule.code,
          id: rule.id,
          matchIndex: rule.matchedCount,
          matchedAt: new Date().toISOString(),
          operation: input.operation,
          path: input.path,
        });
        throw createInjectedFsFaultError({
          code: rule.code,
          id: rule.id,
          message: rule.message,
          operation: input.operation,
          path: input.path,
        });
      }
    },

    getHits(): readonly FsFaultHit[] {
      return [...hits];
    },

    reset(): void {
      hits.length = 0;
      for (const rule of normalizedRules) {
        rule.matchedCount = 0;
      }
    },
  };
}

export function parseFsFaultRulesFromEnvValue(rawValue: string): FsFaultRuleConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(
      `Invalid ${ZCODE_E2E_FS_FAULTS_ENV}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid ${ZCODE_E2E_FS_FAULTS_ENV}: expected a JSON array`);
  }
  return parsed.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Invalid fs fault rule at index ${index}: rule must be an object`);
    }
    return value as FsFaultRuleConfig;
  });
}

function createFsFaultInjectorFromEnv(
  env: Record<string, string | undefined> = process.env,
): FsFaultInjector {
  const rawValue = env[ZCODE_E2E_FS_FAULTS_ENV]?.trim();
  if (!rawValue) {
    return createFsFaultInjector();
  }

  // 测试故障注入必须默认被生产环境隔离，避免用户机器残留环境变量后误伤真实配置和会话落盘。
  if (env.ZCODE_ENV !== "test" && env[ZCODE_E2E_FS_FAULTS_ALLOW_ENV] !== "1") {
    return createFsFaultInjector();
  }

  return createFsFaultInjector(parseFsFaultRulesFromEnvValue(rawValue));
}

let processEnvFaultInjector: FsFaultInjector | null = null;
let injectedFsFaultInjectorForTests: FsFaultInjector | null = null;

export function getProcessFsFaultInjector(): FsFaultInjector {
  if (injectedFsFaultInjectorForTests) {
    return injectedFsFaultInjectorForTests;
  }
  processEnvFaultInjector ??= createFsFaultInjectorFromEnv();
  return processEnvFaultInjector;
}

export function maybeThrowInjectedFsFault(input: FsFaultCheckInput): void {
  getProcessFsFaultInjector().maybeThrow(input);
}

export function setFsFaultInjectorForTests(injector: FsFaultInjector | null): void {
  injectedFsFaultInjectorForTests = injector;
}

export function resetProcessFsFaultInjectorForTests(): void {
  processEnvFaultInjector = null;
  injectedFsFaultInjectorForTests = null;
}

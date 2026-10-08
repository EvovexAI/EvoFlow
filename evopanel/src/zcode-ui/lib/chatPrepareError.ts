import {
  normalizeUnknownError,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  type ZCodeProvider,
  type ZCodeError,
} from "@zcode/shared";
import { normalizeZCodeUiError } from "@/lib/zcodeUiError.js";

export const MODEL_CONFIG_MISSING_UI_ERROR_CODE = "model_config_missing";

export type ModelConfigMissingUiError = ZCodeError & {
  code: typeof MODEL_CONFIG_MISSING_UI_ERROR_CODE;
};

export function buildModelConfigMissingUiError(): ModelConfigMissingUiError {
  // provider_not_ready 是进程启动门禁的内部等待原因，直接展示会被当成
  // Agent 故障。草稿首页统一投影成已有 modelConfigMissing banner 的稳定 code。
  return {
    code: MODEL_CONFIG_MISSING_UI_ERROR_CODE,
    message: "No usable model provider is configured.",
  };
}

export function isProviderNotReadyError(error: unknown): boolean {
  return normalizeUnknownError(error).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
}

interface WorkspacePrepareErrorContext {
  workspacePath: string;
  provider: ZCodeProvider;
  reason:
    | "mount"
    | "retry"
    | "first-send"
    | "select-provider"
    | "reload-session"
    | "sync-model-config";
  attempt: number;
  maxAttempts: number;
  taskId?: string;
  displayMessage?: string;
}

function buildWorkspacePrepareDetail(context: WorkspacePrepareErrorContext): string {
  return (
    `workspace=${context.workspacePath} ` +
    `provider=${context.provider} ` +
    `reason=${context.reason} ` +
    `attempt=${context.attempt}/${context.maxAttempts}`
  );
}

function stringifyUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // 部分错误对象会带循环引用，序列化失败时回退到 String，避免二次抛错覆盖原始错误。
  }

  return String(value);
}

export function getChatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || String(err);
  }

  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    const normalizedMessage = stringifyUnknownValue(message);
    if (normalizedMessage !== "undefined" && normalizedMessage.length > 0) {
      return normalizedMessage;
    }
  }

  return stringifyUnknownValue(err);
}

function buildDisplayErrorInput(err: unknown, displayMessage: string | undefined): unknown {
  if (!displayMessage) {
    return err;
  }

  const displayError = new Error(displayMessage) as Error & Record<string, unknown>;
  if (err instanceof Error) {
    displayError.name = err.name;
    displayError.stack = err.stack;
  }

  if (typeof err === "object" && err !== null) {
    const errorRecord = err as Record<string, unknown>;
    for (const key of [
      "code",
      "data",
      "detail",
      "details",
      "providerCode",
      "taskId",
      "traceId",
      "attribution",
    ] as const) {
      const value = errorRecord[key];
      if (value !== undefined) {
        displayError[key] = value;
      }
    }
  }

  return displayError;
}

export function buildWorkspacePrepareUiError(
  err: unknown,
  context: WorkspacePrepareErrorContext,
): ZCodeError & { detail?: string } {
  const normalizedError = normalizeZCodeUiError(
    buildDisplayErrorInput(err, context.displayMessage),
    {
      fallbackCode: "WORKSPACE_PREPARE_FAILED",
      taskId: context.taskId,
    },
  );
  if (normalizedError.detail) {
    return normalizedError;
  }

  return {
    ...normalizedError,
    detail: buildWorkspacePrepareDetail(context),
  };
}

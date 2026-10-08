import type { ZCodeProvider, ZCodeError } from "@zcode/shared";
import { buildWorkspacePrepareUiError } from "@/lib/chatPrepareError.js";

const WORKSPACE_SESSION_RELOAD_DEBOUNCE_MS = 1200;

interface WorkspaceSessionReloadDraftErrorContext {
  workspacePath: string;
  provider: ZCodeProvider;
}

export function buildWorkspaceSessionReloadDraftError(
  err: unknown,
  context: WorkspaceSessionReloadDraftErrorContext,
): ZCodeError & { detail?: string } {
  return buildWorkspacePrepareUiError(err, {
    workspacePath: context.workspacePath,
    provider: context.provider,
    reason: "reload-session",
    attempt: 1,
    maxAttempts: 1,
  });
}

export function shouldDebounceWorkspaceSessionReload(
  lastTriggeredAt: number | null,
  now: number,
  debounceWindowMs: number = WORKSPACE_SESSION_RELOAD_DEBOUNCE_MS,
): boolean {
  if (lastTriggeredAt === null) {
    return false;
  }

  return now - lastTriggeredAt < debounceWindowMs;
}

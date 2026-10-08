import type { ZCodeSessionStateSnapshot } from "@zcode/shared";
import type {
  ZCodeSessionWorkspaceTarget,
  ZCodeTaskTarget,
} from "#src/zcode-session/zcodeSession.js";

function getWorkspaceKey(target: ZCodeSessionWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function getSessionScopedKey(target: ZCodeTaskTarget): string {
  return `${getWorkspaceKey(target)}\0${target.sessionId}`;
}

export function createZCodeDeferredDraftRegistry() {
  const sessionKeys = new Set<string>();

  return {
    remember(params: ZCodeSessionWorkspaceTarget, snapshot: ZCodeSessionStateSnapshot): void {
      sessionKeys.add(
        getSessionScopedKey({
          workspacePath: snapshot.session.workspace.workspacePath,
          workspaceIdentity:
            snapshot.session.workspace.workspaceIdentity ?? params.workspaceIdentity,
          sessionId: snapshot.session.sessionId,
        }),
      );
    },

    has(target: ZCodeTaskTarget): boolean {
      return sessionKeys.has(getSessionScopedKey(target));
    },

    forget(target: ZCodeTaskTarget): void {
      sessionKeys.delete(getSessionScopedKey(target));
    },
  };
}

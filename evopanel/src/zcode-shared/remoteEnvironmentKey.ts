import type { RemoteTarget } from "./remoteTarget.js";
import { buildSshRemoteHostKey } from "./remoteSshHostKey.js";

/**
 * Provider Provisioning 等 Environment 级状态的稳定身份；不得混用 workspace/session 身份。
 */
export function buildRemoteEnvironmentKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${target.distro?.trim() || "<default>"}\0${target.user?.trim() || "<default>"}`;
    case "docker":
      return `docker:${target.container.trim()}`;
  }
}

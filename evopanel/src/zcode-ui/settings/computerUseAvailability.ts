import type { RemoteTarget } from "@zcode/shared";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";

type ComputerUseAvailabilityKind =
  | "local-macos"
  | "local-windows"
  | "local-linux"
  | "remote-ssh"
  | "remote-wsl"
  | "remote-docker"
  | "remote-server"
  | "web";

interface ComputerUseAvailability {
  kind: ComputerUseAvailabilityKind;
  supported: boolean;
}

interface ComputerUseAvailabilityInput {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  workspaceIdentity?: string | null;
}

export function resolveComputerUseAvailability({
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  remoteSessionId,
  remoteTarget,
  workspaceIdentity,
}: ComputerUseAvailabilityInput = {}): ComputerUseAvailability {
  const isRemote = Boolean(
    remoteSessionId ||
    remoteTarget ||
    (workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim())),
  );
  if (isRemote) {
    const remoteKind: ComputerUseAvailabilityKind =
      remoteTarget?.kind === "ssh"
        ? "remote-ssh"
        : remoteTarget?.kind === "wsl"
          ? "remote-wsl"
          : remoteTarget?.kind === "docker"
            ? "remote-docker"
            : "remote-server";
    return {
      kind: remoteKind,
      supported: false,
    };
  }
  if (!isDesktop) return { kind: "web", supported: false };
  if (isMacDesktop) return { kind: "local-macos", supported: true };
  if (isWindowsDesktop) return { kind: "local-windows", supported: true };
  return { kind: "local-linux", supported: false };
}

const COMPUTER_USE_SEARCH_TERMS = ["电脑控制", "computer use", "zcode-cua", "cua"];

export function matchesComputerUseSearch(query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return COMPUTER_USE_SEARCH_TERMS.some((term) => term.includes(normalized));
}

export function isComputerUseRemoteOrLinux(availability: ComputerUseAvailability): boolean {
  return !availability.supported && availability.kind !== "web";
}

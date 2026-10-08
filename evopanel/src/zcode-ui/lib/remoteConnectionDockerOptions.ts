import type { DockerContainerInfo, IPlatformService } from "@zcode/shared";

type DockerOptionsPlatform = Pick<IPlatformService, "isDockerAvailable" | "listDockerContainers">;

interface RemoteConnectionDockerOptionsResult {
  dockerAvailable: boolean | null;
  dockerContainers: DockerContainerInfo[];
  error: string;
}

export async function loadRemoteConnectionDockerOptions(
  platform: DockerOptionsPlatform,
): Promise<RemoteConnectionDockerOptionsResult> {
  try {
    const dockerAvailable = await platform.isDockerAvailable();
    if (!dockerAvailable) {
      return {
        dockerAvailable: false,
        dockerContainers: [],
        error: "",
      };
    }

    const dockerContainers = await platform.listDockerContainers();
    return {
      dockerAvailable: true,
      dockerContainers,
      error: "",
    };
  } catch (runtimeError) {
    return {
      dockerAvailable: null,
      dockerContainers: [],
      error: String(runtimeError),
    };
  }
}

export function resolveDockerContainerSelectionAfterRefresh({
  currentContainer,
  dockerContainers,
}: {
  currentContainer: string;
  dockerContainers: DockerContainerInfo[];
}): string {
  const selectedContainer = currentContainer.trim();
  if (!selectedContainer) {
    return "";
  }

  const selectedContainerStillRunning = dockerContainers.some(
    (container) => container.name === selectedContainer || container.id === selectedContainer,
  );

  return selectedContainerStillRunning ? selectedContainer : "";
}

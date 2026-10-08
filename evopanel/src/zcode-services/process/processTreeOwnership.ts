import type { ChildProcess } from "node:child_process";
import {
  captureProcessTreeSnapshot,
  filterCurrentProcessIdentities,
} from "#src/process/processTreeSnapshot.js";
import {
  captureProcessTreeSnapshotAsync,
  filterCurrentProcessIdentitiesAsync,
} from "#src/process/processTreeSnapshotAsync.js";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function mergeIdentities(...groups: readonly (readonly ProcessIdentity[])[]): ProcessIdentity[] {
  const identitiesByPid = new Map<number, ProcessIdentity>();
  for (const identities of groups) {
    for (const identity of identities) {
      identitiesByPid.set(identity.pid, identity);
    }
  }
  return [...identitiesByPid.values()];
}

function captureLiveIdentities(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): ProcessIdentity[] {
  if (hasChildExited(child)) {
    return [];
  }
  return [...(captureProcessTreeSnapshot(child, options)?.identities ?? [])];
}

function isSameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return (
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.processGroupId === right.processGroupId
  );
}

export function resolveCurrentOwnedIdentities(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
  allowRootDiscovery = true,
): ProcessTreeOwnershipResolution {
  const rootPid = child.pid!;
  const knownRootIdentity = knownIdentities.find((identity) => identity.pid === rootPid);
  const childHasNotExited = !hasChildExited(child);
  // root PID 在 exit 回调落到 JS 前也可能进入延迟回收窗口。
  // 没有固定 root 身份或生前身份已不匹配时，都禁止沿裸 PID 抓 fresh tree。
  if (!childHasNotExited) {
    return {
      childStillOwned: false,
      currentIdentities: filterCurrentProcessIdentities(knownIdentities, options),
      knownIdentities: [...knownIdentities],
    };
  }

  if (knownRootIdentity) {
    const rootIdentityStillCurrent =
      filterCurrentProcessIdentities([knownRootIdentity], options).length === 1;
    if (!rootIdentityStillCurrent) {
      return {
        childStillOwned: false,
        currentIdentities: filterCurrentProcessIdentities(knownIdentities, options),
        knownIdentities: [...knownIdentities],
      };
    }
  }

  if (!knownRootIdentity && !allowRootDiscovery) {
    // 首次查询失败后若在 force timer 中重新沿 rootPid 建立身份，
    // 原 PID 已复用时会把无关进程树认领成 runtime；本轮回收必须永久 fail closed。
    return {
      childStillOwned: false,
      currentIdentities: [],
      knownIdentities: [],
    };
  }

  const freshIdentities = captureLiveIdentities(child, options);
  const freshRootIdentity = freshIdentities.find((identity) => identity.pid === rootPid);
  if (!knownRootIdentity && !freshRootIdentity) {
    return {
      childStillOwned: false,
      currentIdentities: [],
      knownIdentities: [],
    };
  }
  if (
    knownRootIdentity &&
    freshRootIdentity &&
    !isSameProcessIdentity(knownRootIdentity, freshRootIdentity)
  ) {
    return {
      childStillOwned: false,
      currentIdentities: filterCurrentProcessIdentities(knownIdentities, options),
      knownIdentities: [...knownIdentities],
    };
  }
  const mergedIdentities = mergeIdentities(
    knownIdentities,
    freshRootIdentity ? freshIdentities : [],
  );
  const currentIdentities = filterCurrentProcessIdentities(mergedIdentities, options);
  return {
    // root 可能在前一次身份核对与 fresh capture 之间退出；只有最终
    // 复核集合仍包含 root，才能向 root PID/PGID 发信号，禁止信任过期布尔状态。
    childStillOwned: currentIdentities.some((identity) => identity.pid === rootPid),
    currentIdentities,
    knownIdentities: mergedIdentities,
  };
}

export async function resolveCurrentOwnedIdentitiesAsync(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
  allowRootDiscovery = true,
): Promise<ProcessTreeOwnershipResolution> {
  if (process.platform !== "win32") {
    return resolveCurrentOwnedIdentities(child, knownIdentities, options, allowRootDiscovery);
  }

  const rootPid = child.pid!;
  const knownRootIdentity = knownIdentities.find((identity) => identity.pid === rootPid);
  if (hasChildExited(child)) {
    if (!knownIdentities.some((identity) => isPidAlive(identity.pid))) {
      return {
        childStillOwned: false,
        currentIdentities: [],
        knownIdentities: [...knownIdentities],
      };
    }
    return {
      childStillOwned: false,
      currentIdentities: await filterCurrentProcessIdentitiesAsync(knownIdentities, options),
      knownIdentities: [...knownIdentities],
    };
  }
  if (knownRootIdentity) {
    const currentIdentities = await filterCurrentProcessIdentitiesAsync(knownIdentities, options);
    return {
      childStillOwned: currentIdentities.some((identity) => identity.pid === rootPid),
      currentIdentities,
      knownIdentities: [...knownIdentities],
    };
  }
  if (!allowRootDiscovery) {
    return {
      childStillOwned: false,
      currentIdentities: [],
      knownIdentities: [],
    };
  }

  const freshIdentities = [
    ...((await captureProcessTreeSnapshotAsync(child, options))?.identities ?? []),
  ];
  const freshRootIdentity = freshIdentities.find((identity) => identity.pid === rootPid);
  return {
    childStillOwned: Boolean(freshRootIdentity),
    currentIdentities: freshRootIdentity ? freshIdentities : [],
    knownIdentities: freshRootIdentity ? freshIdentities : [],
  };
}

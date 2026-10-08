/**
 * 卷探测：用 stat().dev 识别物理卷，向上遍历找到挂载点，再 statfs 取容量。
 * 任何一步失败都返回 null（UI 只展示占用、不展示容量），不抛错。
 */
import { stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import type { StorageVolume } from "@zcode/shared";
import type { VolumeProbePort } from "../app/ports.js";

async function probeStorageVolume(path: string): Promise<StorageVolume | null> {
  try {
    const deviceId = (await stat(path)).dev;
    let mountPoint = path;
    // 逐级向上：父目录仍在同一 dev 上就继续；到根或 dev 变化即为挂载点（Windows 会停在盘符根）。
    for (;;) {
      const parent = dirname(mountPoint);
      if (parent === mountPoint) break;
      let parentDev: number | bigint;
      try {
        parentDev = (await stat(parent)).dev;
      } catch {
        break;
      }
      if (parentDev !== deviceId) break;
      mountPoint = parent;
    }
    const fs = await statfs(mountPoint);
    return {
      deviceId: String(deviceId),
      mountPoint,
      totalBytes: Number(fs.blocks) * Number(fs.bsize),
      freeBytes: Number(fs.bavail) * Number(fs.bsize),
    };
  } catch {
    return null;
  }
}

export function createFsVolumeProbe(): VolumeProbePort {
  return { probe: probeStorageVolume };
}

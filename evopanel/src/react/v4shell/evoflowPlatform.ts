/**
 * EvoFlow v4 shell — ``IPlatformService`` 最小实现。
 *
 * ZCode 的 Desktop 平台经 Electron preload 提供原生对话；EvoFlow Tauri 的桥接
 * 留给 H3-C+，当前 selectDirectory/selectFile 返回 null（UI 层会以取消处理）。
 */

import { Event } from "@zcode/rpc";
import type { IPlatformService } from "@zcode/shared";

export const evoflowPlatform: IPlatformService = {
  canSelectFilePath: false,

  async selectDirectory(): Promise<string | null> {
    return null;
  },

  async selectFile(): Promise<string | null> {
    return null;
  },

  onRemoteConnectionLog(): () => void {
    return () => {};
  },
} as unknown as IPlatformService;

// 显式标注：Event.None 的使用方式与 zcode services 侧一致。
void Event.None;

import type { Event } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 文件系统监视服务
 *
 * 按路径粒度管理 watcher 实例。UI 展开目录时调用非递归 watch()，
 * Git 这类工作区级状态可调用递归 watch()。事件通过 onDynamicChange 以 RPC event 流式传输。
 */
export interface IFileWatcherService {
  /** 开始监视路径。返回 watcherId，用于 unwatch 和事件订阅 */
  watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }>;
  /** 停止监视。释放 watcher 和相关资源 */
  unwatch(params: { id: string }): Promise<void>;
  /** 停止全部监视。host 退出清理时用于统一释放底层 fs.watch 句柄 */
  disposeAll(): void;
  /** 按 watcherId 订阅变更事件（onDynamic* 模式，RPC 自动路由） */
  onDynamicChange(id: string): Event<FileWatchEvent>;
}

export const IFileWatcherService = createServiceDescriptor<IFileWatcherService>(
  ServiceChannels.FileWatcher,
);

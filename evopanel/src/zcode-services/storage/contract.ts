/**
 * storage 模块公开契约：资源管理器「存储」tab 使用的服务接口与类型再导出。
 * 只允许从这里 import；实现细节（Worker、fs、catalog 规则）都在模块内部。
 */
import type { Event } from "@zcode/rpc";
import type { StorageManagementApi, StorageUsageSnapshot } from "@zcode/shared";

// 数据类型的唯一事实源在 @zcode/shared（renderer 桥与 main 共用）；这里再导出方便 services 内部引用。
export type {
  StorageCategoryId,
  StorageCategoryUsage,
  StorageCleanRequest,
  StorageCleanResult,
  StorageCleanability,
  StorageEntryUsage,
  StorageManagementApi,
  StoragePathError,
  StorageRootId,
  StorageRootSpec,
  StorageRootUsage,
  StorageScanStatus,
  StorageUsageSnapshot,
  StorageVolume,
  StorageVolumeGroup,
} from "@zcode/shared";

/**
 * 存储服务实例接口。当前由 desktop main 持有一个实例（资源管理器窗口专用），
 * 不再作为 host RPC 服务注册；因此没有 ServiceDescriptor / channel。
 */
export interface IStorageService extends StorageManagementApi {
  onScanProgress: Event<StorageUsageSnapshot>;
  /** 取消进行中的扫描并释放事件源。 */
  dispose(): void;
}

/**
 * app 层端口：storageService 只依赖这些接口，IO 由 adapters 实现并在 desktop host 注入。
 */
import type { StorageCleanCandidate } from "../domain/cleanPlan.js";
import type { StorageCleanScope } from "../domain/storageCatalog.js";
import type {
  StoragePathError,
  StorageRootSpec,
  StorageRootUsage,
  StorageVolume,
} from "@zcode/shared";

export interface RootsResolverPort {
  resolveRoots(): Promise<StorageRootSpec[]>;
}

export interface StorageScanProgress {
  roots: StorageRootUsage[];
  errors: StoragePathError[];
}

export interface StorageScanRunRequest {
  roots: StorageRootSpec[];
  signal: AbortSignal;
  /** 运行方按自己的节奏上报；节流由 app 层的 job 负责。 */
  onProgress: (progress: StorageScanProgress) => void;
}

export interface ScanRunnerPort {
  /** 取消时以 AbortError（name === "AbortError"）拒绝。 */
  run(request: StorageScanRunRequest): Promise<StorageScanProgress>;
}

export interface VolumeProbePort {
  probe(path: string): Promise<StorageVolume | null>;
}

export interface StorageDeleteResult {
  deletedCount: number;
  freedBytes: number;
  failures: StoragePathError[];
}

export interface FsCleanerPort {
  listCandidates(rootPath: string, scopes: StorageCleanScope[]): Promise<StorageCleanCandidate[]>;
  deleteFiles(
    rootPath: string,
    targets: StorageCleanCandidate[],
    options: { keepDirectories: string[] },
  ): Promise<StorageDeleteResult>;
}

/**
 * storage 模块清单：设置页「存储管理」的磁盘占用扫描与清理。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外只暴露 contract.ts。
 */
export const storageModule = {
  id: "storage",
  requires: ["shared", "rpc", "services"],
  provides: ["storage-service"],
  publicEntrypoints: ["contract.ts"],
} as const;

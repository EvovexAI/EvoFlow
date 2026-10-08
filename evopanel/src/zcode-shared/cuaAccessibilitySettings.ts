export type CuaPermissionKind = "accessibility" | "screen_recording";

export interface OpenCuaPermissionOnboardingOptions {
  /** Renderer 为本次调用生成的不透明 id；关闭该权限 surface 时只取消这一 participant。 */
  operationId?: string;
  initialPermission?: CuaPermissionKind;
  /** 当前新鲜状态确认仍缺失的权限；main 会逐项打开对应设置页并等待应用返回。 */
  requiredPermissions?: CuaPermissionKind[];
}

export interface CuaAccessibilitySettingsResult {
  success: boolean;
  canceled?: boolean;
  /** main 级 onboarding 会话 id；同一 Helper identity 的并发窗口共享同一 id。 */
  sessionId?: string;
  /** 只有所有 staged 设置页都观察到任意 ZCode 窗口返回后才为 true。 */
  returnedFromSettings?: boolean;
  /**
   * 同一 main onboarding 会话可能被多个窗口加入。每个独立 renderer/host 只有一个调用拿到 true，负责
   * 重启该 host 的 Helper；同一 renderer 的重复调用拿到 false。不能全局只选一个窗口，因为每个窗口
   * 都有独立 host/Helper，授权前已启动的进程都需要各自恢复。
   * undefined 是旧 main 的兼容形状，按单窗口 owner 处理。
   */
  restartHelperAfterReturn?: boolean;
  error?: string;
}

/**
 * 拖拽预热结果（renderer 可见形状）。
 *
 * 注意 `helperBundleFingerprint` 故意**不在此声明**：它是 main 进程内存缓存的同步 TOCTOU 证据
 * （dragstart 前用它比对"自验签以来字节未变"），跨 IPC 暴露给 renderer 既无用又扩大攻击面。
 * main 侧另有 `PrepareCuaHelperPermissionDragMainResult` 携带该字段，IPC handler 返回前显式剥离。
 */
export interface PrepareCuaHelperPermissionDragResult {
  success: boolean;
  error?: string;
  helperAppPath?: string;
  helperDisplayName?: string;
  helperBundleId?: string;
}

interface SuccessfulPluginEnabledChangeOptions {
  submit: () => Promise<boolean>;
  isCurrent: () => boolean;
  onSuccess: () => void | Promise<void>;
}

/**
 * 只有当前这次插件启停已经由服务端确认成功，才允许继续授权引导或运行态刷新。
 *
 * 旧流程在启用 CUA 的 RPC 完成前就打开授权弹窗；RPC 失败或页面切换后响应迟到时，
 * 用户仍会看到一个可以继续授权的过期弹窗，造成“插件未启用但已授权”的分裂状态。
 */
export async function runAfterSuccessfulPluginEnabledChange({
  submit,
  isCurrent,
  onSuccess,
}: SuccessfulPluginEnabledChangeOptions): Promise<boolean> {
  const succeeded = await submit();
  if (!succeeded || !isCurrent()) {
    return false;
  }

  await onSuccess();
  return true;
}

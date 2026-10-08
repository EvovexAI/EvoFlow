let fallbackSequence = 0;

/** Renderer-local id：main 会再按 webContents 分区，取消时不会误伤其它窗口的 participant。 */
export function createCuaPermissionOnboardingOperationId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) {
    return `cua-onboarding-${randomId}`;
  }
  fallbackSequence += 1;
  return `cua-onboarding-${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
}

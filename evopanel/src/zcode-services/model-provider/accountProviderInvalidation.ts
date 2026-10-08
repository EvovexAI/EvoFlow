interface SettingUpdatedEvent {
  readonly keys: readonly string[];
}

interface AccountProviderInvalidationOptions {
  readonly onDidUpdateSetting: (listener: (event: SettingUpdatedEvent) => void) => () => void;
  readonly refresh: (reason: string) => Promise<unknown>;
}

const ACCOUNT_PROVIDER_SETTING_KEYS = new Set([
  "providerFamilyDomain",
  "providerFamilyConnectionSelections",
  "zcodeEndpointOrigin",
]);

/**
 * 把会改变账号连接选择的 Settings 变化收敛为 AccountProviderService 刷新。
 *
 * OAuth 登录、登出和购买完成由对应业务流程直接刷新 Account Source；这里不再
 * 订阅已退役旧 Registry 的事件，避免重新引入并行事实源。
 */
export function bindAccountProviderInvalidation(
  options: AccountProviderInvalidationOptions,
): () => void {
  const requestRefresh = (reason: string): void => {
    void options.refresh(reason).catch(() => {
      // AccountProviderService 通过 onDidRefreshError 统一记录失败并保留 last-known-good。
    });
  };
  const disposeSetting = options.onDidUpdateSetting((event) => {
    const keys = event.keys.filter((key) => ACCOUNT_PROVIDER_SETTING_KEYS.has(key));
    if (keys.length > 0) {
      requestRefresh(`settings:${keys.join(",")}`);
    }
  });

  return () => {
    disposeSetting();
  };
}

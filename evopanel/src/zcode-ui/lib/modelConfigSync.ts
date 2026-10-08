import {
  CUSTOM_SUPPLIER_KEY_PREFIX,
  GHOST_SUPPLIER_KEY_PREFIX,
  buildNativeSupplierKey,
  resolveSupplierKeyFromModelDisplayValue,
  type ZCodeConfigOption,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";

interface ModelConfigSyncScope {
  provider: ZCodeProvider;
  supplierKey: string;
}

interface ModelConfigSyncWorkspaceSnapshot {
  activeTaskId: string | null;
  selectedProvider: ZCodeProvider;
  selectedSupplierKey: string;
  configOptions: ZCodeConfigOption[] | null;
  optimisticTaskListByTaskId: Record<string, Pick<ZCodeTaskMeta, "provider">>;
  taskListCache: ZCodeTaskMeta[] | null;
}

export function parseCustomProviderIdFromSupplierKey(supplierKey: string): string | null {
  const normalizedSupplierKey = supplierKey.trim();
  if (normalizedSupplierKey.startsWith(CUSTOM_SUPPLIER_KEY_PREFIX)) {
    const providerId = normalizedSupplierKey.slice(CUSTOM_SUPPLIER_KEY_PREFIX.length).trim();
    return providerId || null;
  }

  if (!normalizedSupplierKey.startsWith(GHOST_SUPPLIER_KEY_PREFIX)) {
    return null;
  }

  const firstSeparatorIndex = normalizedSupplierKey.indexOf(":", GHOST_SUPPLIER_KEY_PREFIX.length);
  const secondSeparatorIndex =
    firstSeparatorIndex >= 0 ? normalizedSupplierKey.indexOf(":", firstSeparatorIndex + 1) : -1;
  if (secondSeparatorIndex < 0) {
    return null;
  }

  const encodedIdentity = normalizedSupplierKey.slice(secondSeparatorIndex + 1);
  let identity = encodedIdentity;
  try {
    identity = decodeURIComponent(encodedIdentity);
  } catch {
    identity = encodedIdentity;
  }

  // custom provider 配置被修改后，当前模型可能处在 ghost
  // supplier 状态，key 形如 ghost:glm:no-preference:provider=provider-demo...
  // 只识别 custom:* 会导致后续 provider registry 刷新无法定位自定义 provider。
  // 这里从 ghost identity 中恢复 provider 元数据，确保保存配置后能刷新对应配置。
  const providerSegment = identity
    .split(",")
    .map((segment) => segment.trim())
    .find((segment) => segment.startsWith("provider="));
  const providerId = providerSegment?.slice("provider=".length).trim();
  return providerId || null;
}

function isCustomSupplierKey(supplierKey: string): boolean {
  return parseCustomProviderIdFromSupplierKey(supplierKey) !== null;
}

function resolveModelSupplierKeyFromConfigOptions(
  configOptions: ZCodeConfigOption[] | null,
  provider: ZCodeProvider,
): string | null {
  const modelValue = resolveModelValueFromConfigOptions(configOptions);
  if (!modelValue) {
    return null;
  }

  return resolveSupplierKeyFromModelDisplayValue(provider, modelValue);
}

function resolveActiveTaskProvider(
  snapshot: ModelConfigSyncWorkspaceSnapshot,
): ZCodeProvider | null {
  const activeTaskId = snapshot.activeTaskId?.trim();
  if (!activeTaskId) {
    return null;
  }

  const taskProvider =
    snapshot.optimisticTaskListByTaskId[activeTaskId]?.provider ??
    snapshot.taskListCache?.find((task) => task.taskId === activeTaskId)?.provider ??
    null;

  return taskProvider ?? null;
}

export function resolveWorkspaceModelConfigSyncScope(
  snapshot: ModelConfigSyncWorkspaceSnapshot,
): ModelConfigSyncScope {
  const activeTaskProvider = resolveActiveTaskProvider(snapshot);
  if (!activeTaskProvider) {
    return {
      provider: snapshot.selectedProvider,
      supplierKey: snapshot.selectedSupplierKey,
    };
  }

  const modelSupplierKey = resolveModelSupplierKeyFromConfigOptions(
    snapshot.configOptions,
    activeTaskProvider,
  );
  if (modelSupplierKey && isCustomSupplierKey(modelSupplierKey)) {
    return {
      provider: activeTaskProvider,
      supplierKey: modelSupplierKey,
    };
  }

  if (activeTaskProvider === snapshot.selectedProvider) {
    // 自定义供应商运行中的 ZCode Agent 回包经常只带纯模型名（如 glm-5.1），
    // 直接按模型值推导会误判成 native supplier，导致设置页保存后刷新到错误的 scope。
    // 当前 provider 与 selectedProvider 一致时，纯模型名不能证明 supplier 已变化，所以继续沿用 selectedSupplierKey。
    return {
      provider: activeTaskProvider,
      supplierKey: snapshot.selectedSupplierKey,
    };
  }

  if (modelSupplierKey) {
    return {
      provider: activeTaskProvider,
      supplierKey: modelSupplierKey,
    };
  }

  return {
    provider: activeTaskProvider,
    supplierKey: buildNativeSupplierKey(activeTaskProvider),
  };
}

function resolveModelValueFromConfigOptions(
  configOptions: ZCodeConfigOption[] | null,
): string | null {
  const modelOption = configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );

  if (!modelOption) {
    return null;
  }

  const modelValue = modelOption.currentValue;
  const normalizedModelValue =
    typeof modelValue === "string" ? modelValue.trim() : String(modelValue ?? "").trim();

  return normalizedModelValue.length > 0 ? normalizedModelValue : null;
}

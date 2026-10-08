export const DEVELOPER_TOOLS_STORAGE_KEYS = [
  "zcode:developer-tools:enabled",
  "zcode:token-debug:enabled",
] as const;

const DISABLED_VALUES = new Set(["0", "false", "off", "no"]);

function isDeveloperToolsStorageValueEnabled(value: string | null): boolean {
  if (value === null) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return !DISABLED_VALUES.has(normalized);
}

export function readDeveloperToolsEnabled(storage: Storage | undefined = getLocalStorage()) {
  if (!storage) {
    return false;
  }
  return DEVELOPER_TOOLS_STORAGE_KEYS.some((key) => {
    try {
      return isDeveloperToolsStorageValueEnabled(storage.getItem(key));
    } catch {
      return false;
    }
  });
}

function getLocalStorage(): Storage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

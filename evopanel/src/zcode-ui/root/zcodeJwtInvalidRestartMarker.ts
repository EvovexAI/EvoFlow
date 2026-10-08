const ZCODE_JWT_INVALID_RESTART_MARKER_KEY = "zcode:auth:jwt-invalid-restart";

interface RestartMarkerStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

function resolveStorage(storage?: RestartMarkerStorage): RestartMarkerStorage | null {
  if (storage) {
    return storage;
  }
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function markZcodeJwtInvalidRestart(storage?: RestartMarkerStorage): void {
  resolveStorage(storage)?.setItem(ZCODE_JWT_INVALID_RESTART_MARKER_KEY, "1");
}

export function consumeZcodeJwtInvalidRestartMarker(storage?: RestartMarkerStorage): boolean {
  const resolved = resolveStorage(storage);
  if (!resolved || resolved.getItem(ZCODE_JWT_INVALID_RESTART_MARKER_KEY) !== "1") {
    return false;
  }
  // 该标记只服务于本次重启；如果不在读取时删除，后续正常启动仍会被强制带回登录页。
  resolved.removeItem(ZCODE_JWT_INVALID_RESTART_MARKER_KEY);
  return true;
}

type E2EStoreBridgeImportMetaEnv = {
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
};

function readE2EStoreBridgeImportMetaEnv(): E2EStoreBridgeImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: E2EStoreBridgeImportMetaEnv }).env ??
    {}) as E2EStoreBridgeImportMetaEnv;
}

export function shouldExposeE2EStoreBridge(
  env: E2EStoreBridgeImportMetaEnv = readE2EStoreBridgeImportMetaEnv(),
): boolean {
  return typeof window !== "undefined" && env.VITE_ZCODE_E2E_STORE_BRIDGE === "1";
}

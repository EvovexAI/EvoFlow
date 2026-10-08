export const DEFAULT_INTRANET_MACHINE_HOST = "";
type IntranetEnv = {
  INTRANET_MACHINE_HOST?: string;
  ZCODE_DEPS_BASE_URL?: string;
};

function readProcessEnv(): IntranetEnv {
  const maybeProcess = (globalThis as typeof globalThis & { process?: { env?: IntranetEnv } })
    .process;
  return maybeProcess?.env ?? {};
}

export function resolveIntranetMachineHost(env: IntranetEnv = readProcessEnv()) {
  // 自建镜像机器地址统一从 INTRANET_MACHINE_HOST 读取，避免多处硬编码漏改。
  return env.INTRANET_MACHINE_HOST?.trim() || DEFAULT_INTRANET_MACHINE_HOST;
}

export const INTRANET_MACHINE_HOST = resolveIntranetMachineHost();
export const INTRANET_ASSET_SERVICE_PORT = 12345;
export const INTRANET_ASSET_BASE_URL = INTRANET_MACHINE_HOST
  ? `http://${INTRANET_MACHINE_HOST}:${INTRANET_ASSET_SERVICE_PORT}/zcode`
  : "";
export const INTRANET_DEPS_BASE_URL = INTRANET_ASSET_BASE_URL
  ? `${INTRANET_ASSET_BASE_URL}/deps`
  : "";
export const INTRANET_PROBE_SERVICE_PORT = 3850;
export const INTRANET_PROBE_SERVICE_PATH = "/api/intranet/probe";
export const INTRANET_PROBE_SERVICE_URL = INTRANET_MACHINE_HOST
  ? `http://${INTRANET_MACHINE_HOST}:${INTRANET_PROBE_SERVICE_PORT}${INTRANET_PROBE_SERVICE_PATH}`
  : "";

export function resolveIntranetDepsBaseUrl(env: IntranetEnv = readProcessEnv()) {
  const depsBaseUrl = env.ZCODE_DEPS_BASE_URL?.trim();
  if (depsBaseUrl) {
    return depsBaseUrl.replace(/\/+$/, "");
  }

  const host = resolveIntranetMachineHost(env);
  if (!host)
    throw new Error(
      "Configure ZCODE_DEPS_BASE_URL or INTRANET_MACHINE_HOST in .env before downloading internal dependencies",
    );
  return `http://${host}:${INTRANET_ASSET_SERVICE_PORT}/zcode/deps`;
}

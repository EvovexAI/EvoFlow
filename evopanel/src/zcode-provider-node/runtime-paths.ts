export const ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";
export const ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV =
  "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";
export const ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";
export const PERSONAL_PROVIDER_CONFIG_FILE_NAME = "provider_config.json";

export interface NodeProviderRuntimePaths {
  readonly zcodeBuiltinFilePath: string;
  readonly personalFilePath: string;
}

export function createNodeProviderRuntimePathEnv(
  paths: NodeProviderRuntimePaths,
): Record<string, string> {
  return {
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: paths.zcodeBuiltinFilePath,
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: paths.personalFilePath,
  };
}

export function resolveNodeProviderRuntimePaths(
  env: Readonly<Record<string, string | undefined>>,
): NodeProviderRuntimePaths | null {
  const zcodeBuiltinFilePath = env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const personalFilePath = env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!zcodeBuiltinFilePath && !personalFilePath) return null;
  if (!zcodeBuiltinFilePath || !personalFilePath) {
    throw new Error("ZCode Built-in 与 Personal Provider Config 路径必须同时提供");
  }
  return Object.freeze({ zcodeBuiltinFilePath, personalFilePath });
}

export const SERVICE_AUTHORITY_MODE_ENV = "ZCODE_SERVICE_AUTHORITY_MODE";

export const serviceAuthorityModes = [
  "desktop-local",
  "desktop-attached-remote",
  "standalone-server",
] as const;

export type ServiceAuthorityMode = (typeof serviceAuthorityModes)[number];

export function isServiceAuthorityMode(value: unknown): value is ServiceAuthorityMode {
  return typeof value === "string" && serviceAuthorityModes.includes(value as ServiceAuthorityMode);
}

export function parseServiceAuthorityMode(env: Record<string, string | undefined>): {
  mode: ServiceAuthorityMode | undefined;
  invalidRawValue: string | undefined;
} {
  const rawValue = env[SERVICE_AUTHORITY_MODE_ENV]?.trim();
  if (!rawValue) {
    return {
      mode: undefined,
      invalidRawValue: undefined,
    };
  }

  if (isServiceAuthorityMode(rawValue)) {
    return {
      mode: rawValue,
      invalidRawValue: undefined,
    };
  }

  return {
    mode: undefined,
    invalidRawValue: rawValue,
  };
}

export function shouldUseProviderRegistrySourceForAuthorityMode(
  mode: ServiceAuthorityMode | undefined,
): boolean {
  return mode !== "desktop-attached-remote";
}

const RELEASE_TARGET_MAP: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const RELEASE_ARCH_MAP: Record<string, string> = {
  x64: "x86_64",
  arm64: "aarch64",
};

function readOverride(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function resolveReleaseTarget(platform: string = process.platform): string {
  const override = readOverride("ZCODE_TEST_RELEASE_TARGET");
  return override ?? RELEASE_TARGET_MAP[platform] ?? platform;
}

function resolveReleaseArch(arch: string = process.arch): string {
  const override = readOverride("ZCODE_TEST_RELEASE_ARCH");
  return override ?? RELEASE_ARCH_MAP[arch] ?? arch;
}

export function resolveClientConfigPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const override = readOverride("ZCODE_TEST_CLIENT_CONFIG_PLATFORM");
  return override ?? `${resolveReleaseTarget(platform)}-${resolveReleaseArch(arch)}`;
}

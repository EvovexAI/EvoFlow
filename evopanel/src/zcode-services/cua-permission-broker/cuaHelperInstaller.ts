import {
  createCuaHelperInstaller,
  defaultCuaHelperVerifierDependencies,
  type CuaHelperInstaller,
  type CuaHelperInstallerOptions,
} from "@zcode/zcode-cua/broker/server";

type CuaHelperInstallerFactory = (options: CuaHelperInstallerOptions) => CuaHelperInstaller;

/**
 * macOS `lipo -archs` 对 Intel 二进制返回 `x86_64`，而 Node 的运行时架构名是 `x64`。
 * 两者表示同一架构；如果直接比较字符串，合法的 Intel Helper 会被误判为不可用。
 */
export function normalizeCuaHelperArch(rawArch: string): string {
  switch (rawArch.trim().toLowerCase()) {
    case "amd64":
    case "x86_64":
    case "x64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return rawArch.trim();
  }
}

export function normalizeCuaHelperArchs(archs: readonly string[]): string[] {
  return [...new Set(archs.map(normalizeCuaHelperArch).filter(Boolean))];
}

export function canonicalizeCuaHelperInstallerOptions(
  options: CuaHelperInstallerOptions,
): CuaHelperInstallerOptions {
  const readExecutableArchs =
    options.dependencies?.readExecutableArchs ??
    defaultCuaHelperVerifierDependencies.readExecutableArchs;
  return {
    ...options,
    dependencies: {
      ...options.dependencies,
      readExecutableArchs: async (executablePath) =>
        normalizeCuaHelperArchs(await readExecutableArchs(executablePath)),
    },
  };
}

export function createCanonicalCuaHelperInstaller(
  options: CuaHelperInstallerOptions,
  createInstaller: CuaHelperInstallerFactory = createCuaHelperInstaller,
): CuaHelperInstaller {
  return createInstaller(canonicalizeCuaHelperInstallerOptions(options));
}

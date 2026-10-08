/* eslint-disable max-lines -- source/product 两种解析模式共享同一稳定错误契约与路径校验，拆开会引入循环依赖 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 as windowsPath } from "node:path";

const DEV_ROOT_ENV = "ZCODE_CUA_DEV_ROOT";
const EXPECTED_PACKAGE_NAME = "@zcode/zcode-cua";
const PACKAGE_JSON = "package.json";
const PRODUCT_RUNTIME_MANIFEST = "runtime-manifest.json";
const PRODUCT_RUNTIME_SEGMENTS = ["tools", "cua-helper"] as const;

export interface WindowsCuaRuntime {
  root: string;
  entryPath: string;
  addonPath: string;
  command: string;
  commandEnv: Record<string, string>;
}

interface WindowsCuaRuntimeFileSystem {
  stat(path: string): Promise<Pick<Stats, "isDirectory" | "isFile">>;
  lstat?(path: string): Promise<Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink">>;
  realpath?(path: string): Promise<string>;
  readFile(path: string, encoding?: "utf8"): Promise<string | Uint8Array>;
}

interface WindowsCuaRuntimeResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  arch?: NodeJS.Architecture;
  electronVersion?: string;
  fileSystem?: WindowsCuaRuntimeFileSystem;
  hashBytes?: (bytes: string | Uint8Array) => Promise<string>;
}

type WindowsCuaDevRuntimeResolutionReason =
  | "unsupported-platform"
  | "development-root-not-absolute"
  | "development-root-not-found"
  | "invalid-package"
  | "missing-helper-entry"
  | "missing-native-addon"
  | "missing-resources-path"
  | "resources-path-not-absolute"
  | "invalid-runtime-manifest"
  | "incompatible-runtime-manifest"
  | "invalid-artifact-path"
  | "artifact-integrity-mismatch";

export class WindowsCuaDevRuntimeResolutionError extends Error {
  constructor(
    readonly reason: WindowsCuaDevRuntimeResolutionReason,
    message: string,
    readonly artifact?: string,
  ) {
    super(message);
    this.name = "WindowsCuaDevRuntimeResolutionError";
  }
}

const defaultFileSystem: WindowsCuaRuntimeFileSystem = {
  stat: (path) => fs.stat(path),
  lstat: (path) => fs.lstat(path),
  realpath: (path) => fs.realpath(path),
  readFile: (path, encoding) =>
    encoding === "utf8" ? fs.readFile(path, encoding) : fs.readFile(path),
};
const defaultHashBytes = async (bytes: string | Uint8Array): Promise<string> =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Windows 产品运行时解析边界：
 * - 显式开发目录具有最高优先级，配置错误时 fail closed，不能悄悄改用安装资源；
 * - 产品模式只读取 resources/tools/cua-helper，不搜索源码目录或 node_modules。
 */
export async function resolveWindowsCuaRuntime(
  options: WindowsCuaRuntimeResolveOptions = {},
): Promise<WindowsCuaRuntime> {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new WindowsCuaDevRuntimeResolutionError(
      "unsupported-platform",
      "Windows CUA runtime is only available on win32.",
    );
  }

  const configuredRoot = (options.env ?? process.env)[DEV_ROOT_ENV]?.trim();
  if (configuredRoot) {
    return resolveDevelopmentRuntime(configuredRoot, options.fileSystem ?? defaultFileSystem);
  }

  return resolvePackagedRuntime(options, options.fileSystem ?? defaultFileSystem);
}

async function resolveDevelopmentRuntime(
  configuredRoot: string,
  fileSystem: WindowsCuaRuntimeFileSystem,
): Promise<WindowsCuaRuntime> {
  const isHostAbsolute = isAbsolute(configuredRoot);
  const isWindowsAbsolute = windowsPath.isAbsolute(configuredRoot);
  if (!isHostAbsolute && !isWindowsAbsolute) {
    throw new WindowsCuaDevRuntimeResolutionError(
      "development-root-not-absolute",
      `${DEV_ROOT_ENV} must be an absolute path.`,
    );
  }

  // 构建和测试会在非 Windows 主机校验 Windows runtime；宿主 path.isAbsolute
  // 不认识 C:\ 路径，不能在进入可注入文件系统前误判为相对路径。
  const root = isHostAbsolute ? resolve(configuredRoot) : windowsPath.normalize(configuredRoot);
  const rootRealPath = await requireDevelopmentRuntimeRoot(fileSystem, root);
  const producerContract = await requireExpectedPackage(
    fileSystem,
    join(root, PACKAGE_JSON),
    rootRealPath,
  );

  const entryPath = resolveManifestArtifact(root, producerContract.entry, "entry");
  await requireContainedRegularArtifact(
    fileSystem,
    rootRealPath,
    entryPath,
    producerContract.entry,
    "missing-helper-entry",
    "entry",
  );

  const addonPath = resolveManifestArtifact(root, producerContract.addon, "addon");
  await requireContainedRegularArtifact(
    fileSystem,
    rootRealPath,
    addonPath,
    producerContract.addon,
    "missing-native-addon",
    "addon",
  );

  return {
    root,
    entryPath,
    addonPath,
    command: process.execPath,
    commandEnv: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

interface RuntimeManifest {
  schemaVersion: 1;
  packageName: typeof EXPECTED_PACKAGE_NAME;
  packageVersion: string;
  platform: "win32";
  arch: NodeJS.Architecture;
  electronVersion: string;
  entry: string;
  addon: string;
  sha256: {
    entry: string;
    addon: string;
  };
}

async function resolvePackagedRuntime(
  options: WindowsCuaRuntimeResolveOptions,
  fileSystem: WindowsCuaRuntimeFileSystem,
): Promise<WindowsCuaRuntime> {
  const processResourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const resourcesPath = (options.resourcesPath ?? processResourcesPath)?.trim();
  if (!resourcesPath) {
    throw new WindowsCuaDevRuntimeResolutionError(
      "missing-resources-path",
      "Windows CUA packaged runtime requires resourcesPath.",
    );
  }
  if (!isAbsolute(resourcesPath)) {
    throw new WindowsCuaDevRuntimeResolutionError(
      "resources-path-not-absolute",
      "Windows CUA packaged runtime resourcesPath must be absolute.",
    );
  }

  const root = resolve(resourcesPath, ...PRODUCT_RUNTIME_SEGMENTS);
  const rootRealPath = await requirePackagedRuntimeRoot(fileSystem, root);
  const manifestPath = join(root, PRODUCT_RUNTIME_MANIFEST);
  const manifest = await readRuntimeManifest(fileSystem, manifestPath, rootRealPath);
  validateRuntimeManifest(manifest, {
    arch: options.arch ?? process.arch,
    electronVersion: options.electronVersion ?? process.versions.electron,
  });

  const entryPath = resolveManifestArtifact(root, manifest.entry, "entry");
  const addonPath = resolveManifestArtifact(root, manifest.addon, "addon");
  await Promise.all([
    requireContainedRegularArtifact(
      fileSystem,
      rootRealPath,
      entryPath,
      manifest.entry,
      "missing-helper-entry",
      "entry",
    ),
    requireContainedRegularArtifact(
      fileSystem,
      rootRealPath,
      addonPath,
      manifest.addon,
      "missing-native-addon",
      "addon",
    ),
  ]);
  const [entryBytes, addonBytes] = await Promise.all([
    readRequiredArtifact(fileSystem, entryPath, manifest.entry, "missing-helper-entry", "entry"),
    readRequiredArtifact(fileSystem, addonPath, manifest.addon, "missing-native-addon", "addon"),
  ]);
  const hashBytes = options.hashBytes ?? defaultHashBytes;
  const [entryHash, addonHash] = await Promise.all([hashBytes(entryBytes), hashBytes(addonBytes)]);
  requireArtifactHash(entryHash, manifest.sha256.entry, "entry");
  requireArtifactHash(addonHash, manifest.sha256.addon, "addon");

  return {
    root,
    entryPath,
    addonPath,
    command: process.execPath,
    commandEnv: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

async function readRuntimeManifest(
  fileSystem: WindowsCuaRuntimeFileSystem,
  manifestPath: string,
  rootRealPath: string,
): Promise<RuntimeManifest> {
  try {
    const stats = await lstatFile(fileSystem, manifestPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("manifest is not a regular file");
    }
    const manifestRealPath = await realpathFile(fileSystem, manifestPath);
    if (!isPathContainedBy(rootRealPath, manifestRealPath)) {
      throw new Error("manifest escapes runtime root");
    }
    const contents = await fileSystem.readFile(manifestPath, "utf8");
    if (typeof contents !== "string") throw new Error("manifest is not text");
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("manifest is not an object");
    }
    return value as RuntimeManifest;
  } catch {
    throw new WindowsCuaDevRuntimeResolutionError(
      "invalid-runtime-manifest",
      `Windows CUA packaged runtime has an invalid ${PRODUCT_RUNTIME_MANIFEST}.`,
      PRODUCT_RUNTIME_MANIFEST,
    );
  }
}

async function requirePackagedRuntimeRoot(
  fileSystem: WindowsCuaRuntimeFileSystem,
  root: string,
): Promise<string> {
  try {
    const stats = await lstatFile(fileSystem, root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("runtime root is not a regular directory");
    }
    const rootRealPath = await realpathFile(fileSystem, root);
    if (!samePhysicalPath(root, rootRealPath)) {
      throw new Error("runtime root resolves outside its packaged location");
    }
    return rootRealPath;
  } catch {
    throw new WindowsCuaDevRuntimeResolutionError(
      "invalid-runtime-manifest",
      `Windows CUA packaged runtime has an invalid ${PRODUCT_RUNTIME_MANIFEST}.`,
      PRODUCT_RUNTIME_MANIFEST,
    );
  }
}

function validateRuntimeManifest(
  manifest: RuntimeManifest,
  expected: { arch: NodeJS.Architecture; electronVersion?: string },
): void {
  const hashPattern = /^[0-9a-f]{64}$/u;
  const hasExactManifestKeys = hasExactKeys(manifest, [
    "schemaVersion",
    "packageName",
    "packageVersion",
    "platform",
    "arch",
    "electronVersion",
    "entry",
    "addon",
    "sha256",
  ]);
  const hasExactHashKeys =
    manifest.sha256 !== null &&
    typeof manifest.sha256 === "object" &&
    hasExactKeys(manifest.sha256, ["entry", "addon"]);
  const compatible =
    hasExactManifestKeys &&
    manifest.schemaVersion === 1 &&
    manifest.packageName === EXPECTED_PACKAGE_NAME &&
    isNonEmptyTrimmedString(manifest.packageVersion) &&
    manifest.platform === "win32" &&
    (manifest.arch === "x64" || manifest.arch === "arm64") &&
    manifest.arch === expected.arch &&
    typeof expected.electronVersion === "string" &&
    expected.electronVersion.length > 0 &&
    manifest.electronVersion === expected.electronVersion &&
    typeof manifest.entry === "string" &&
    typeof manifest.addon === "string" &&
    manifest.entry !== manifest.addon &&
    hasExactHashKeys &&
    hashPattern.test(manifest.sha256.entry) &&
    hashPattern.test(manifest.sha256.addon);
  if (compatible) return;
  throw new WindowsCuaDevRuntimeResolutionError(
    "incompatible-runtime-manifest",
    `Windows CUA packaged runtime ${PRODUCT_RUNTIME_MANIFEST} is incompatible with this runtime.`,
    PRODUCT_RUNTIME_MANIFEST,
  );
}

async function requireDevelopmentRuntimeRoot(
  fileSystem: WindowsCuaRuntimeFileSystem,
  root: string,
): Promise<string> {
  try {
    const stats = await lstatFile(fileSystem, root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("development root is not a regular directory");
    }
    const rootRealPath = await realpathFile(fileSystem, root);
    // 根因：stat 会跟随 symlink/junction；开发目录必须绑定到用户显式配置的物理根。
    if (!samePhysicalPath(root, rootRealPath)) {
      throw new Error("development root resolves outside its configured location");
    }
    return rootRealPath;
  } catch {
    throw new WindowsCuaDevRuntimeResolutionError(
      "development-root-not-found",
      `${DEV_ROOT_ENV} must reference an existing regular directory.`,
    );
  }
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function resolveManifestArtifact(root: string, artifact: string, field: "entry" | "addon"): string {
  // 测试和构建编排可能在非 Windows 主机上检查 Windows 清单；仅用宿主 path.isAbsolute
  // 会把 C:\... 误判成相对路径，因此同时按 Windows 路径语义 fail closed。
  if (!isCanonicalRelativeArtifactPath(artifact)) {
    throwInvalidArtifactPath(field);
  }
  const artifactPath =
    windowsPath.isAbsolute(root) && !isAbsolute(root)
      ? join(root, ...artifact.split("/"))
      : resolve(root, ...artifact.split("/"));
  const relativePath = relative(root, artifactPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throwInvalidArtifactPath(field);
  }
  return artifactPath;
}

function isCanonicalRelativeArtifactPath(artifact: unknown): artifact is string {
  if (
    typeof artifact !== "string" ||
    !artifact ||
    artifact.includes("\\") ||
    isAbsolute(artifact) ||
    windowsPath.isAbsolute(artifact) ||
    windowsPath.normalize(artifact).replaceAll("\\", "/") !== artifact
  ) {
    return false;
  }
  return !artifact
    .split("/")
    .some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        segment.includes("\0"),
    );
}

async function requireContainedRegularArtifact(
  fileSystem: WindowsCuaRuntimeFileSystem,
  rootRealPath: string,
  artifactPath: string,
  artifact: string,
  missingReason: "missing-helper-entry" | "missing-native-addon",
  artifactKind: "entry" | "addon",
): Promise<void> {
  let stats: Pick<Stats, "isFile" | "isSymbolicLink">;
  try {
    stats = await lstatFile(fileSystem, artifactPath);
  } catch {
    throwMissingArtifact(missingReason, artifact, artifactKind);
  }
  if (stats.isSymbolicLink()) {
    throwInvalidArtifactPath(artifactKind);
  }
  if (!stats.isFile()) {
    throwMissingArtifact(missingReason, artifact, artifactKind);
  }
  try {
    const artifactRealPath = await realpathFile(fileSystem, artifactPath);
    if (!isPathContainedBy(rootRealPath, artifactRealPath)) {
      throwInvalidArtifactPath(artifactKind);
    }
  } catch (error) {
    if (error instanceof WindowsCuaDevRuntimeResolutionError) throw error;
    throwMissingArtifact(missingReason, artifact, artifactKind);
  }
}

function throwMissingArtifact(
  reason: "missing-helper-entry" | "missing-native-addon",
  artifact: string,
  artifactKind: "entry" | "addon",
): never {
  throw new WindowsCuaDevRuntimeResolutionError(
    reason,
    `Windows CUA runtime is missing required ${artifactKind}: ${artifact}.`,
    artifact,
  );
}

function lstatFile(
  fileSystem: WindowsCuaRuntimeFileSystem,
  path: string,
): Promise<Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink">> {
  return (fileSystem.lstat ?? defaultFileSystem.lstat!)(path);
}

function realpathFile(fileSystem: WindowsCuaRuntimeFileSystem, path: string): Promise<string> {
  return (fileSystem.realpath ?? defaultFileSystem.realpath!)(path);
}

function isPathContainedBy(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function samePhysicalPath(expected: string, actual: string): boolean {
  const normalize = (path: string): string => {
    if (windowsPath.isAbsolute(path)) return windowsPath.normalize(path).toLowerCase();
    return resolve(path);
  };
  return normalize(expected) === normalize(actual);
}

async function readRequiredArtifact(
  fileSystem: WindowsCuaRuntimeFileSystem,
  artifactPath: string,
  artifact: string,
  reason: "missing-helper-entry" | "missing-native-addon",
  artifactKind: "entry" | "addon",
): Promise<string | Uint8Array> {
  try {
    return await fileSystem.readFile(artifactPath);
  } catch {
    // stat 与 read 之间文件仍可能被替换/删除；不能把宿主 I/O 细节泄漏成不稳定诊断。
    throw new WindowsCuaDevRuntimeResolutionError(
      reason,
      `Windows CUA runtime is missing required ${artifactKind}: ${artifact}.`,
      artifact,
    );
  }
}

function throwInvalidArtifactPath(field: "entry" | "addon"): never {
  throw new WindowsCuaDevRuntimeResolutionError(
    "invalid-artifact-path",
    `Windows CUA packaged runtime ${field} must be a contained relative artifact path.`,
    field,
  );
}

function requireArtifactHash(
  actualHash: string,
  expectedHash: string,
  artifact: "entry" | "addon",
): void {
  if (actualHash === expectedHash) return;
  throw new WindowsCuaDevRuntimeResolutionError(
    "artifact-integrity-mismatch",
    `Windows CUA packaged runtime ${artifact} failed SHA-256 verification.`,
    artifact,
  );
}

async function requireExpectedPackage(
  fileSystem: WindowsCuaRuntimeFileSystem,
  packagePath: string,
  rootRealPath: string,
): Promise<{ packageVersion: string; entry: string; addon: string }> {
  try {
    const stats = await lstatFile(fileSystem, packagePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("package.json is not a regular file");
    }
    const packageRealPath = await realpathFile(fileSystem, packagePath);
    if (!isPathContainedBy(rootRealPath, packageRealPath)) {
      throw new Error("package.json escapes development root");
    }
    const contents = await fileSystem.readFile(packagePath, "utf8");
    if (typeof contents !== "string") throw new Error("package.json is not text");
    const pkg: unknown = JSON.parse(contents);
    if (!isPlainRecord(pkg)) throw new Error("package.json is not an object");
    const contract = pkg.zcodeCuaRuntime;
    if (
      pkg.name !== EXPECTED_PACKAGE_NAME ||
      !isNonEmptyTrimmedString(pkg.version) ||
      !isPlainRecord(contract) ||
      !hasExactKeys(contract, ["schema", "windows"]) ||
      contract.schema !== 1 ||
      !isPlainRecord(contract.windows) ||
      !hasExactKeys(contract.windows, ["entry", "nativeAddon"]) ||
      !isCanonicalRelativeArtifactPath(contract.windows.entry) ||
      !isCanonicalRelativeArtifactPath(contract.windows.nativeAddon) ||
      contract.windows.entry === contract.windows.nativeAddon
    ) {
      throw new Error("package runtime contract is incompatible");
    }
    return {
      packageVersion: pkg.version,
      entry: contract.windows.entry,
      addon: contract.windows.nativeAddon,
    };
  } catch {
    // 解析和 I/O 失败共用稳定的 package 诊断，避免依赖底层错误文本。
  }
  throw new WindowsCuaDevRuntimeResolutionError(
    "invalid-package",
    `Windows CUA development root package.json must name ${EXPECTED_PACKAGE_NAME} and expose a valid zcodeCuaRuntime contract.`,
    PACKAGE_JSON,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

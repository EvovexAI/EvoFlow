/* eslint-disable max-lines -- plugin 同步需要集中维护候选扫描、归档安全、远端判重和配置写入，拆分会增加远端同步回归面。 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  PluginSyncCandidate,
  PluginSyncComponentType,
  PluginSyncImportResult,
  PluginSyncRemoteStatus,
} from "@zcode/shared";
import type { IPluginSyncService } from "./pluginSync.js";
import {
  createPluginSyncArchive,
  extractPluginSyncArchive,
  PLUGIN_SYNC_METADATA_ARCHIVE_PATH,
  type PluginSyncArchiveMetadata,
} from "./pluginSyncArchive.js";
import { normalizePluginSyncRelativePath, resolvePluginSyncPathWithin } from "./pluginSyncPath.js";
import { checkRemoteSyncDirectoriesWriteAccess } from "../remote-sync/remoteSyncWriteAccess.js";

interface PluginManifestInfo {
  name: string;
  pluginId: string;
  description?: string;
  version?: string;
  componentTypes: PluginSyncComponentType[];
}

interface UserPluginConfigState {
  dirs: string[];
  enabledOverrides: Map<string, boolean>;
}

interface MarketplaceManifestInfo {
  name: string;
  description?: string;
  pluginRoot?: string;
  plugins: MarketplacePluginEntryInfo[];
  raw: Record<string, unknown>;
}

interface MarketplacePluginEntryInfo {
  name: string;
  dependencies: string[];
  raw: Record<string, unknown>;
  source?: unknown;
}

interface MarketplaceSourceLoadResult {
  manifest: MarketplaceManifestInfo;
  sourceRoot?: string;
}

interface MarketplaceSourceMirrorEntry {
  entry: MarketplacePluginEntryInfo;
  mirroredSourcePath?: string;
  mirroredSourceRelativePath?: string;
}

const INLINE_PLUGIN_MARKETPLACE = "inline";
const DEFAULT_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const USER_CONFIG_FILE_MODE = 0o600;
const MARKETPLACE_SOURCE_ROOT_DIRECTORY = "marketplace-sources";
const MIRRORED_MARKETPLACE_PLUGIN_ROOT = "plugins";
const PLUGIN_MANIFEST_RELATIVE_PATHS = [
  [".zcode-plugin", "plugin.json"],
  [".claude-plugin", "plugin.json"],
  [".codex-plugin", "plugin.json"],
] as const;

export function createPluginSyncService(options?: {
  maxArchiveBytes?: number;
}): IPluginSyncService {
  const maxArchiveBytes = options?.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  return {
    async listLocalUserPluginCandidates() {
      return {
        candidates: await collectLocalUserPluginCandidates(),
        maxArchiveBytes,
      };
    },
    async listRemoteUserPluginStatuses(params) {
      const targetRoot = getUserZcodePluginRoot();
      const existingPluginPathById = await collectConfiguredInlinePluginPathById();
      return {
        statuses: params.plugins.map((plugin): PluginSyncRemoteStatus => {
          const directoryName = normalizePluginSyncRelativePath(plugin.directoryName);
          const pluginId = normalizePluginId(plugin.pluginId);
          const targetPath = resolvePluginSyncPathWithin(targetRoot, directoryName);
          if (existsSync(targetPath)) {
            return {
              pluginId,
              directoryName,
              exists: true,
              path: targetPath,
              reason: "targetExists",
            };
          }
          const existingPath = existingPluginPathById.get(normalizePluginIdKey(pluginId));
          return existingPath
            ? {
                pluginId,
                directoryName,
                exists: true,
                path: existingPath,
                reason: "samePluginId",
              }
            : { pluginId, directoryName, exists: false };
        }),
      };
    },
    async exportPluginsArchive(params) {
      const candidates = await collectLocalUserPluginCandidates();
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const selected = params.pluginIds.map((id) => {
        const candidate = candidateById.get(id);
        if (!candidate) {
          throw new Error(`plugin sync candidate not found: ${id}`);
        }
        return candidate;
      });
      const selectedBytes = selected.reduce((total, candidate) => total + candidate.sizeBytes, 0);
      if (selectedBytes > maxArchiveBytes) {
        throw new Error(`plugin sync archive exceeds limit: ${selectedBytes}/${maxArchiveBytes}`);
      }
      const archive = await createPluginSyncArchive({
        entries: await Promise.all(
          selected.map(async (candidate) => ({
            sourcePath: await realpath(candidate.path),
            archivePath: candidate.directoryName,
          })),
        ),
        metadata: {
          plugins: selected.map((candidate) => ({
            name: candidate.name,
            pluginId: candidate.pluginId,
            directoryName: candidate.directoryName,
            ...(candidate.enabledOverride !== undefined
              ? { enabled: candidate.enabledOverride }
              : {}),
          })),
        },
      });
      if (archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin sync archive exceeds limit: ${archive.byteLength}/${maxArchiveBytes}`,
        );
      }
      return {
        archive,
        archiveBytes: archive.byteLength,
        plugins: selected.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          pluginId: candidate.pluginId,
          directoryName: candidate.directoryName,
          ...(candidate.enabledOverride !== undefined
            ? { enabled: candidate.enabledOverride }
            : {}),
        })),
      };
    },
    async exportMarketplaceSourceArchive(params) {
      const result = await exportMarketplaceSourceArchiveInternal(params, maxArchiveBytes);
      if (result.archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin marketplace source archive exceeds limit: ${result.archive.byteLength}/${maxArchiveBytes}`,
        );
      }
      return result;
    },
    async importPluginsArchive(params) {
      if (params.overwrite) {
        throw new Error("plugin sync overwrite is not supported");
      }
      if (params.archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin sync archive exceeds limit: ${params.archive.byteLength}/${maxArchiveBytes}`,
        );
      }
      return await importPluginsArchive(params.archive, maxArchiveBytes);
    },
    async checkRemoteUserPluginWriteAccess() {
      return checkRemoteSyncDirectoriesWriteAccess([
        getUserZcodePluginRoot(),
        dirname(getUserZcodeConfigPath()),
      ]);
    },
    async importMarketplaceSourceArchive(params) {
      if (params.overwrite) {
        throw new Error("plugin marketplace source overwrite is not supported");
      }
      if (params.archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin marketplace source archive exceeds limit: ${params.archive.byteLength}/${maxArchiveBytes}`,
        );
      }
      return await importMarketplaceSourceArchiveInternal(params.archive, maxArchiveBytes);
    },
  };
}

function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

function getUserZcodeConfigPath(): string {
  return join(resolveUserHomeDir(), ".zcode", "cli", "config.json");
}

function getUserZcodePluginRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "plugins");
}

async function collectLocalUserPluginCandidates(): Promise<PluginSyncCandidate[]> {
  const config = await readUserPluginConfigState();
  const candidates: PluginSyncCandidate[] = [];
  const seenRealpaths = new Set<string>();
  const usedDirectoryNames = new Set<string>();

  for (const rawDir of config.dirs) {
    const pluginRoot = resolve(rawDir);
    const canonicalRoot = await realpath(pluginRoot).catch(() => pluginRoot);
    if (seenRealpaths.has(canonicalRoot)) {
      continue;
    }
    seenRealpaths.add(canonicalRoot);
    const manifest = await readPluginManifestInfo(canonicalRoot);
    if (!manifest) {
      continue;
    }
    const enabledOverride = config.enabledOverrides.get(normalizePluginIdKey(manifest.pluginId));
    const directoryName = createUniqueDirectoryName(
      basename(canonicalRoot),
      manifest.name,
      canonicalRoot,
      usedDirectoryNames,
    );
    candidates.push({
      id: createCandidateId(manifest.pluginId, canonicalRoot),
      name: manifest.name,
      pluginId: manifest.pluginId,
      directoryName,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.version ? { version: manifest.version } : {}),
      path: canonicalRoot,
      sizeBytes: await computeRecursiveSize(canonicalRoot),
      enabled: enabledOverride ?? true,
      ...(enabledOverride !== undefined ? { enabledOverride } : {}),
      componentTypes: manifest.componentTypes,
    });
  }

  return candidates.sort((left, right) => left.name.localeCompare(right.name));
}

async function exportMarketplaceSourceArchiveInternal(
  params: {
    marketplaceId: string;
    pluginNames: string[];
    source: Record<string, unknown>;
  },
  maxArchiveBytes: number,
) {
  const marketplaceId = normalizeMarketplaceId(params.marketplaceId);
  const pluginNames = Array.from(
    new Set(params.pluginNames.map((name) => readRequiredString(name, "plugin name"))),
  );
  if (pluginNames.length === 0) {
    throw new Error("missing marketplace plugin names");
  }
  const loaded = await loadMarketplaceSource(params.source);
  if (loaded.manifest.name !== marketplaceId) {
    throw new Error(`marketplace id mismatch: ${loaded.manifest.name} !== ${marketplaceId}`);
  }
  const closure = resolveMarketplacePluginClosure(loaded.manifest, marketplaceId, pluginNames);
  const mirrorEntries = await Promise.all(
    closure.map((entry) => buildMarketplaceSourceMirrorEntry(loaded, entry)),
  );
  const manifest = buildMirroredMarketplaceManifest(loaded.manifest, mirrorEntries);
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const selectedBytes =
    Buffer.byteLength(manifestContent, "utf-8") +
    (
      await Promise.all(
        mirrorEntries.map((entry) =>
          entry.mirroredSourcePath ? computeRecursiveSize(entry.mirroredSourcePath) : 0,
        ),
      )
    ).reduce((total, bytes) => total + bytes, 0);
  if (selectedBytes > maxArchiveBytes) {
    throw new Error(
      `plugin marketplace source archive exceeds limit: ${selectedBytes}/${maxArchiveBytes}`,
    );
  }
  const sourceFingerprints = await Promise.all(
    mirrorEntries.map((entry) =>
      entry.mirroredSourcePath
        ? computeRecursiveContentFingerprint(entry.mirroredSourcePath)
        : null,
    ),
  );
  const directoryName = createMarketplaceSourceDirectoryName(
    marketplaceId,
    manifestContent,
    sourceFingerprints,
  );
  const entries = [
    {
      archivePath: `${directoryName}/marketplace.json`,
      content: manifestContent,
    },
    ...mirrorEntries
      .filter(
        (
          entry,
        ): entry is MarketplaceSourceMirrorEntry & {
          mirroredSourcePath: string;
          mirroredSourceRelativePath: string;
        } => Boolean(entry.mirroredSourcePath && entry.mirroredSourceRelativePath),
      )
      .map((entry) => ({
        archivePath: `${directoryName}/${entry.mirroredSourceRelativePath}`,
        sourcePath: entry.mirroredSourcePath,
      })),
  ];
  const archive = await createPluginSyncArchive({
    entries,
    metadata: {
      plugins: [],
      marketplaceSources: [
        {
          marketplaceId,
          directoryName,
        },
      ],
    },
  });
  return {
    archive,
    archiveBytes: archive.byteLength,
    marketplaceId,
    pluginNames: closure.map((entry) => entry.name),
  };
}

async function importMarketplaceSourceArchiveInternal(
  archive: Uint8Array,
  maxArchiveBytes: number,
) {
  const tempRoot = join(tmpdir(), `zcode-plugin-marketplace-source-${randomUUID()}`);
  try {
    await extractPluginSyncArchive(archive, tempRoot, {
      maxExtractedBytes: maxArchiveBytes,
    });
    const metadata = await readMarketplaceSourceArchiveMetadata(tempRoot);
    const directoryName = normalizePluginSyncRelativePath(metadata.directoryName);
    const extractedPath = resolvePluginSyncPathWithin(tempRoot, directoryName);
    const manifest = await readMarketplaceManifest(join(extractedPath, "marketplace.json"));
    if (manifest.name !== metadata.marketplaceId) {
      throw new Error(
        `marketplace source archive id mismatch: ${manifest.name} !== ${metadata.marketplaceId}`,
      );
    }
    const targetRoot = join(getUserZcodePluginRoot(), MARKETPLACE_SOURCE_ROOT_DIRECTORY);
    const targetPath = resolvePluginSyncPathWithin(targetRoot, directoryName);
    if (existsSync(targetPath)) {
      return {
        marketplaceId: metadata.marketplaceId,
        path: targetPath,
        status: "skipped" as const,
      };
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(extractedPath, targetPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    return {
      marketplaceId: metadata.marketplaceId,
      path: targetPath,
      status: "synced" as const,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function readUserPluginConfigState(): Promise<UserPluginConfigState> {
  const parsed = await readJsonFileOrEmpty(getUserZcodeConfigPath());
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const enabledOverrides = new Map<string, boolean>();
  for (const [pluginId, enabled] of Object.entries(enabledPlugins)) {
    if (typeof enabled === "boolean") {
      enabledOverrides.set(normalizePluginIdKey(pluginId), enabled);
    }
  }
  return {
    dirs: readStringArray(plugins.dirs),
    enabledOverrides,
  };
}

async function collectConfiguredInlinePluginPathById(): Promise<Map<string, string>> {
  const config = await readUserPluginConfigState();
  const result = new Map<string, string>();
  for (const rawDir of config.dirs) {
    const pluginRoot = resolve(rawDir);
    const canonicalRoot = await realpath(pluginRoot).catch(() => pluginRoot);
    const manifest = await readPluginManifestInfo(canonicalRoot);
    if (!manifest) {
      continue;
    }
    const pluginIdKey = normalizePluginIdKey(manifest.pluginId);
    if (!result.has(pluginIdKey)) {
      result.set(pluginIdKey, canonicalRoot);
    }
  }
  return result;
}

async function importPluginsArchive(
  archive: Uint8Array,
  maxArchiveBytes: number,
): Promise<PluginSyncImportResult> {
  const tempRoot = join(tmpdir(), `zcode-plugin-sync-${randomUUID()}`);
  try {
    await extractPluginSyncArchive(archive, tempRoot, {
      maxExtractedBytes: maxArchiveBytes,
    });
    const metadata = await readArchiveMetadata(tempRoot);
    const targetRoot = getUserZcodePluginRoot();
    const existingPluginPathById = await collectConfiguredInlinePluginPathById();
    const results: PluginSyncImportResult["results"] = [];

    for (const plugin of metadata.plugins) {
      const directoryName = normalizePluginSyncRelativePath(plugin.directoryName);
      const pluginId = normalizePluginId(plugin.pluginId);
      const extractedPath = resolvePluginSyncPathWithin(tempRoot, directoryName);
      const targetPath = resolvePluginSyncPathWithin(targetRoot, directoryName);
      let stagingPath: string | undefined;
      try {
        const manifest = await readPluginManifestInfo(extractedPath);
        if (!manifest) {
          throw new Error(`plugin manifest not found: ${directoryName}`);
        }
        if (normalizePluginIdKey(manifest.pluginId) !== normalizePluginIdKey(pluginId)) {
          throw new Error(`plugin manifest id mismatch: ${manifest.pluginId} !== ${pluginId}`);
        }
        if (existsSync(targetPath)) {
          results.push({
            name: manifest.name,
            pluginId,
            directoryName,
            status: "skipped",
            path: targetPath,
          });
          continue;
        }
        const existingPath = existingPluginPathById.get(normalizePluginIdKey(pluginId));
        if (existingPath) {
          results.push({
            name: manifest.name,
            pluginId,
            directoryName,
            status: "skipped",
            path: existingPath,
          });
          continue;
        }
        await mkdir(dirname(targetPath), { recursive: true });
        stagingPath = resolvePluginSyncPathWithin(
          targetRoot,
          `.importing-${toSafeDirectoryName(directoryName)}-${randomUUID()}`,
        );
        await cp(extractedPath, stagingPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        if (existsSync(targetPath)) {
          throw new Error(`plugin target already exists: ${targetPath}`);
        }
        await rename(stagingPath, targetPath);
        stagingPath = undefined;
        // 远端 plugin 只有目录落盘还不会被 Agent runtime 发现；
        // 必须在同一个远端服务里追加远端绝对路径，避免写回本机 plugins.dirs。
        try {
          await addPluginDirToUserConfig(targetPath, pluginId, plugin.enabled);
        } catch (error) {
          // inline plugin 目录落盘但 config 写失败会形成半同步状态；
          // 重试会把目录误判为远端已有，所以必须回滚本次刚创建的目标目录。
          await rm(targetPath, { recursive: true, force: true });
          throw error;
        }
        existingPluginPathById.set(normalizePluginIdKey(pluginId), targetPath);
        results.push({
          name: manifest.name,
          pluginId,
          directoryName,
          status: "synced",
          path: targetPath,
        });
      } catch (error) {
        if (stagingPath) {
          await rm(stagingPath, { recursive: true, force: true });
        }
        results.push({
          name: plugin.name,
          pluginId,
          directoryName,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { results };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function readArchiveMetadata(tempRoot: string): Promise<PluginSyncArchiveMetadata> {
  const raw = await readFile(join(tempRoot, PLUGIN_SYNC_METADATA_ARCHIVE_PATH), "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    throw new Error("invalid plugin sync archive metadata");
  }
  const plugins: PluginSyncArchiveMetadata["plugins"] = [];
  for (const item of parsed.plugins) {
    if (!isRecord(item)) {
      throw new Error("invalid plugin sync archive plugin metadata");
    }
    const name = readRequiredString(item.name, "plugin metadata name");
    const pluginId = normalizePluginId(readRequiredString(item.pluginId, "plugin metadata id"));
    const directoryName = normalizePluginSyncRelativePath(
      readRequiredString(item.directoryName, "plugin metadata directory"),
    );
    plugins.push({
      name,
      pluginId,
      directoryName,
      ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
    });
  }
  return { plugins };
}

async function readMarketplaceSourceArchiveMetadata(tempRoot: string): Promise<{
  directoryName: string;
  marketplaceId: string;
}> {
  const raw = await readFile(join(tempRoot, PLUGIN_SYNC_METADATA_ARCHIVE_PATH), "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.marketplaceSources)) {
    throw new Error("invalid plugin marketplace source archive metadata");
  }
  if (parsed.marketplaceSources.length !== 1) {
    throw new Error("plugin marketplace source archive must contain one marketplace");
  }
  const item = parsed.marketplaceSources[0];
  if (!isRecord(item)) {
    throw new Error("invalid plugin marketplace source metadata");
  }
  return {
    marketplaceId: normalizeMarketplaceId(
      readRequiredString(item.marketplaceId, "marketplace source id"),
    ),
    directoryName: normalizePluginSyncRelativePath(
      readRequiredString(item.directoryName, "marketplace source directory"),
    ),
  };
}

async function loadMarketplaceSource(
  source: Record<string, unknown>,
): Promise<MarketplaceSourceLoadResult> {
  const sourceKind = typeof source.source === "string" ? source.source : "";
  if (sourceKind === "file") {
    const filePath = readRequiredString(source.path, "marketplace source file path");
    return {
      manifest: await readMarketplaceManifest(filePath),
      sourceRoot: dirname(filePath),
    };
  }
  if (sourceKind === "directory") {
    const sourceRoot = readRequiredString(source.path, "marketplace source directory path");
    const manifestPath = findMarketplaceManifestPath(sourceRoot);
    if (!manifestPath) {
      throw new Error(`marketplace manifest not found in directory: ${sourceRoot}`);
    }
    return {
      manifest: await readMarketplaceManifest(manifestPath),
      sourceRoot,
    };
  }
  if (sourceKind === "settings") {
    if (!isRecord(source.marketplace)) {
      throw new Error("settings marketplace source is missing marketplace manifest");
    }
    return {
      manifest: parseMarketplaceManifest(source.marketplace),
    };
  }
  throw new Error(`unsupported marketplace source for SSH sync: ${sourceKind || "unknown"}`);
}

async function readMarketplaceManifest(filePath: string): Promise<MarketplaceManifestInfo> {
  const parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
  return parseMarketplaceManifest(parsed);
}

function parseMarketplaceManifest(value: unknown): MarketplaceManifestInfo {
  if (!isRecord(value)) {
    throw new Error("marketplace manifest is invalid");
  }
  const name = readRequiredString(value.name, "marketplace name");
  const rawPlugins = value.plugins;
  const pluginValues = Array.isArray(rawPlugins)
    ? rawPlugins
    : isRecord(rawPlugins)
      ? Object.entries(rawPlugins).map(([pluginName, plugin]) =>
          isRecord(plugin) ? { name: pluginName, ...plugin } : { name: pluginName },
        )
      : [];
  const plugins = pluginValues.filter(isRecord).map((plugin): MarketplacePluginEntryInfo => {
    const pluginName = readRequiredString(plugin.name, "marketplace plugin name");
    const dependencies = Array.isArray(plugin.dependencies)
      ? plugin.dependencies.filter(
          (dependency): dependency is string =>
            typeof dependency === "string" && dependency.trim().length > 0,
        )
      : [];
    return {
      name: pluginName,
      dependencies,
      raw: plugin,
      ...(plugin.source !== undefined ? { source: plugin.source } : {}),
    };
  });
  return {
    name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...readMarketplacePluginRoot(value),
    plugins,
    raw: value,
  };
}

function readMarketplacePluginRoot(value: Record<string, unknown>): { pluginRoot?: string } {
  if (typeof value.pluginRoot === "string" && value.pluginRoot.trim()) {
    return { pluginRoot: value.pluginRoot.trim() };
  }
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  if (typeof metadata.pluginRoot === "string" && metadata.pluginRoot.trim()) {
    return { pluginRoot: metadata.pluginRoot.trim() };
  }
  return {};
}

function findMarketplaceManifestPath(sourceRoot: string): string | null {
  const candidates = [
    join(sourceRoot, "marketplace.json"),
    join(sourceRoot, ".claude-plugin", "marketplace.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveMarketplacePluginClosure(
  manifest: MarketplaceManifestInfo,
  marketplaceId: string,
  pluginNames: readonly string[],
): MarketplacePluginEntryInfo[] {
  const byName = new Map(manifest.plugins.map((entry) => [entry.name, entry]));
  const visited = new Set<string>();
  const result: MarketplacePluginEntryInfo[] = [];
  const visit = (pluginName: string, requiredBy: string) => {
    const normalizedName = readRequiredString(pluginName, "marketplace plugin name");
    if (visited.has(normalizedName)) {
      return;
    }
    const entry = byName.get(normalizedName);
    if (!entry) {
      throw new Error(`marketplace plugin not found: ${normalizedName}`);
    }
    visited.add(normalizedName);
    result.push(entry);
    for (const dependency of entry.dependencies) {
      visit(normalizeMarketplaceDependency(dependency, marketplaceId, requiredBy), entry.name);
    }
  };
  for (const pluginName of pluginNames) {
    visit(pluginName, pluginName);
  }
  return result;
}

function normalizeMarketplaceDependency(
  dependency: string,
  marketplaceId: string,
  requiredBy: string,
): string {
  const trimmed = dependency.trim();
  const separatorIndex = trimmed.lastIndexOf("@");
  if (separatorIndex < 0) {
    return trimmed;
  }
  const name = trimmed.slice(0, separatorIndex);
  const marketplace = trimmed.slice(separatorIndex + 1);
  if (marketplace === marketplaceId) {
    return name;
  }
  throw new Error(
    `cross-marketplace dependency is not supported for SSH source mirror: ${dependency} required by ${requiredBy}`,
  );
}

async function buildMarketplaceSourceMirrorEntry(
  loaded: MarketplaceSourceLoadResult,
  entry: MarketplacePluginEntryInfo,
): Promise<MarketplaceSourceMirrorEntry> {
  if (isRemoteMarketplacePluginSource(entry.source)) {
    return { entry };
  }
  const sourcePath = await resolveLocalMarketplacePluginSource(loaded, entry);
  const sourceDirectoryName = toSafeDirectoryName(entry.name);
  return {
    entry,
    mirroredSourcePath: sourcePath,
    mirroredSourceRelativePath: `${MIRRORED_MARKETPLACE_PLUGIN_ROOT}/${sourceDirectoryName}`,
  };
}

function isRemoteMarketplacePluginSource(source: unknown): boolean {
  if (!isRecord(source)) {
    return false;
  }
  const sourceKind = typeof source.source === "string" ? source.source : "";
  return ["github", "git", "url", "git-subdir", "npm", "pip"].includes(sourceKind);
}

async function resolveLocalMarketplacePluginSource(
  loaded: MarketplaceSourceLoadResult,
  entry: MarketplacePluginEntryInfo,
): Promise<string> {
  if (typeof entry.source === "string") {
    return await resolveLocalMarketplacePluginSourcePath(
      loaded,
      entry.source,
      `${entry.name} source`,
    );
  }
  if (isRecord(entry.source)) {
    const sourceKind = typeof entry.source.source === "string" ? entry.source.source : "";
    if (sourceKind === "directory" && typeof entry.source.path === "string") {
      return await resolveLocalMarketplacePluginSourcePath(
        loaded,
        entry.source.path,
        `${entry.name} directory source`,
        { allowSettingsAbsoluteDirectorySource: !loaded.sourceRoot },
      );
    }
    return await resolveLocalMarketplacePluginFallback(loaded, entry);
  }
  return await resolveLocalMarketplacePluginFallback(loaded, entry);
}

async function resolveLocalMarketplacePluginFallback(
  loaded: MarketplaceSourceLoadResult,
  entry: MarketplacePluginEntryInfo,
): Promise<string> {
  if (!loaded.sourceRoot) {
    throw new Error(
      `cannot mirror local marketplace plugin source without source root: ${entry.name}`,
    );
  }
  const pluginBaseDir = resolveMarketplacePluginBaseDir(loaded);
  const fallbackPath = resolvePluginSyncPathWithin(pluginBaseDir, entry.name, {
    unsafePathLabel: "unsafe marketplace plugin source path",
  });
  if (await directoryExists(fallbackPath)) {
    return await assertLocalMarketplacePluginSourceRoot(fallbackPath);
  }
  throw new Error(`local marketplace plugin source does not exist: ${fallbackPath}`);
}

async function resolveLocalMarketplacePluginSourcePath(
  loaded: MarketplaceSourceLoadResult,
  sourcePath: string,
  label: string,
  options: { allowSettingsAbsoluteDirectorySource?: boolean } = {},
): Promise<string> {
  const requestedPath = readRequiredString(sourcePath, label);
  const relativeSourcePath = requestedPath.replace(/^\.\//u, "");
  if (!loaded.sourceRoot && options.allowSettingsAbsoluteDirectorySource) {
    if (!isAbsolute(requestedPath)) {
      throw new Error(
        `cannot mirror local marketplace plugin source without source root: ${sourcePath}`,
      );
    }
    const absolutePath = resolve(requestedPath);
    if (await directoryExists(absolutePath)) {
      return await assertLocalMarketplacePluginSourceRoot(absolutePath);
    }
    throw new Error(`local marketplace plugin source does not exist: ${sourcePath}`);
  }
  if (!loaded.sourceRoot) {
    throw new Error(
      `cannot mirror local marketplace plugin source without source root: ${sourcePath}`,
    );
  }
  const pluginBaseDir = resolveMarketplacePluginBaseDir(loaded);
  const relativePath = resolvePluginSyncPathWithin(pluginBaseDir, relativeSourcePath, {
    unsafePathLabel: "unsafe marketplace plugin source path",
  });
  if (await directoryExists(relativePath)) {
    return await assertLocalMarketplacePluginSourceRoot(relativePath);
  }
  throw new Error(`local marketplace plugin source does not exist: ${sourcePath}`);
}

async function assertLocalMarketplacePluginSourceRoot(pluginRoot: string): Promise<string> {
  const manifest = await readPluginManifestInfo(pluginRoot);
  if (!manifest) {
    // marketplace source mirror 只能复制选中插件目录。先验证 plugin manifest，避免被篡改的 marketplace entry
    // 指向普通目录后，把本机敏感文件作为“插件源码”打包发送到 SSH 远端。
    throw new Error(`local marketplace plugin source is missing plugin manifest: ${pluginRoot}`);
  }
  return pluginRoot;
}

function resolveMarketplacePluginBaseDir(loaded: MarketplaceSourceLoadResult): string {
  const sourceRoot = loaded.sourceRoot;
  if (!sourceRoot) {
    throw new Error("cannot resolve marketplace plugin source root");
  }
  if (!loaded.manifest.pluginRoot) {
    return sourceRoot;
  }
  const pluginRoot = resolvePluginSyncPathWithin(sourceRoot, loaded.manifest.pluginRoot, {
    unsafePathLabel: "unsafe marketplace pluginRoot",
  });
  return existsSync(pluginRoot) ? pluginRoot : sourceRoot;
}

function buildMirroredMarketplaceManifest(
  manifest: MarketplaceManifestInfo,
  entries: readonly MarketplaceSourceMirrorEntry[],
): Record<string, unknown> {
  const hasMirroredLocalSource = entries.some((entry) => entry.mirroredSourceRelativePath);
  const rawMetadata = isRecord(manifest.raw.metadata) ? manifest.raw.metadata : {};
  const rawManifest = { ...manifest.raw };
  delete rawManifest.pluginRoot;
  return {
    ...rawManifest,
    name: manifest.name,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(hasMirroredLocalSource
      ? {
          // agent marketplace 解析只读取 metadata.pluginRoot。
          // 远端镜像 manifest 如果写顶层 pluginRoot，会把 ./hello-world 误解析到市场根目录。
          metadata: {
            ...rawMetadata,
            pluginRoot: MIRRORED_MARKETPLACE_PLUGIN_ROOT,
          },
        }
      : {}),
    plugins: entries.map((entry) => {
      const raw: Record<string, unknown> = { ...entry.entry.raw, name: entry.entry.name };
      if (entry.mirroredSourceRelativePath) {
        raw.source = `./${entry.mirroredSourceRelativePath.split("/").slice(1).join("/")}`;
      }
      return raw;
    }),
  };
}

function createMarketplaceSourceDirectoryName(
  marketplaceId: string,
  manifestContent: string,
  sourceFingerprints: readonly (string | null)[],
): string {
  const hashInput = JSON.stringify({
    manifestContent,
    sourceFingerprints,
  });
  return `${toSafeDirectoryName(marketplaceId)}-${createShortHash(hashInput).slice(0, 12)}`;
}

async function addPluginDirToUserConfig(
  pluginPath: string,
  pluginId: string,
  enabledOverride: boolean | undefined,
): Promise<void> {
  const filePath = getUserZcodeConfigPath();
  const parsed = await readJsonFileOrEmpty(filePath);
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const resolvedPluginPath = resolve(pluginPath);
  const dirs = readStringArray(plugins.dirs);
  const nextDirs = dirs.map((item) => resolve(item)).includes(resolvedPluginPath)
    ? dirs
    : [...dirs, resolvedPluginPath];
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  await writeJsonFileAtomic(filePath, {
    ...parsed,
    plugins: {
      ...plugins,
      dirs: nextDirs,
      ...(enabledOverride !== undefined
        ? {
            enabledPlugins: {
              ...enabledPlugins,
              [pluginId]: enabledOverride,
            },
          }
        : Object.keys(enabledPlugins).length > 0
          ? { enabledPlugins }
          : {}),
    },
  });
}

async function readPluginManifestInfo(pluginRoot: string): Promise<PluginManifestInfo | null> {
  for (const segments of PLUGIN_MANIFEST_RELATIVE_PATHS) {
    const manifestPath = join(pluginRoot, ...segments);
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (!isRecord(parsed)) {
      return null;
    }
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name) {
      return null;
    }
    return {
      name,
      pluginId: `${name}@${INLINE_PLUGIN_MARKETPLACE}`,
      ...(typeof parsed.description === "string" && parsed.description.trim()
        ? { description: parsed.description.trim() }
        : {}),
      ...(typeof parsed.version === "string" && parsed.version.trim()
        ? { version: parsed.version.trim() }
        : {}),
      componentTypes: await resolvePluginComponentTypes(pluginRoot, parsed),
    };
  }
  return null;
}

async function resolvePluginComponentTypes(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): Promise<PluginSyncComponentType[]> {
  const componentTypes: PluginSyncComponentType[] = [];
  if ("skills" in manifest || (await pathExists(join(pluginRoot, "skills")))) {
    componentTypes.push("skills");
  }
  if ("commands" in manifest || (await pathExists(join(pluginRoot, "commands")))) {
    componentTypes.push("commands");
  }
  if ("hooks" in manifest || (await pathExists(join(pluginRoot, "hooks", "hooks.json")))) {
    componentTypes.push("hooks");
  }
  if ("mcpServers" in manifest || (await pathExists(join(pluginRoot, ".mcp.json")))) {
    componentTypes.push("mcp");
  }
  return componentTypes;
}

async function computeRecursiveSize(path: string): Promise<number> {
  const pathStat = await lstat(path);
  if (pathStat.isFile()) {
    return pathStat.size;
  }
  if (!pathStat.isDirectory()) {
    return 0;
  }
  let total = 0;
  for (const entry of await readdir(path)) {
    total += await computeRecursiveSize(join(path, entry));
  }
  return total;
}

async function computeRecursiveContentFingerprint(path: string): Promise<string> {
  const pathStat = await lstat(path);
  const hash = createHash("sha256");
  if (pathStat.isFile()) {
    hash.update("file\0");
    hash.update(await readFile(path));
    return hash.digest("hex");
  }
  if (!pathStat.isDirectory()) {
    throw new Error(`unsupported plugin archive source: ${path}`);
  }
  hash.update("dir\0");
  const children = (await readdir(path, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const child of children) {
    hash.update(child.name);
    hash.update("\0");
    hash.update(await computeRecursiveContentFingerprint(join(path, child.name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function createUniqueDirectoryName(
  directoryBasename: string,
  pluginName: string,
  pluginRoot: string,
  usedDirectoryNames: Set<string>,
): string {
  const baseName = toSafeDirectoryName(directoryBasename || pluginName);
  if (!usedDirectoryNames.has(baseName)) {
    usedDirectoryNames.add(baseName);
    return baseName;
  }
  const dedupedName = toSafeDirectoryName(`${baseName}-${createShortHash(pluginRoot).slice(0, 8)}`);
  usedDirectoryNames.add(dedupedName);
  return dedupedName;
}

function toSafeDirectoryName(value: string): string {
  const sanitized = value.trim().replace(/[\\/:]/gu, "-") || "plugin";
  try {
    return normalizePluginSyncRelativePath(sanitized);
  } catch {
    return `plugin-${createShortHash(value).slice(0, 8)}`;
  }
}

function createCandidateId(pluginId: string, pluginRoot: string): string {
  return createShortHash(`${pluginId}:${pluginRoot}`);
}

function createShortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePluginId(pluginId: string): string {
  const normalized = pluginId.trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) {
    throw new Error(`invalid plugin id: ${pluginId}`);
  }
  return normalized;
}

function normalizeMarketplaceId(marketplaceId: string): string {
  return normalizePluginId(marketplaceId);
}

function normalizePluginIdKey(pluginId: string): string {
  return normalizePluginId(pluginId).toLowerCase();
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing ${label}`);
  }
  return value.trim();
}

async function readJsonFileOrEmpty(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`invalid json object: ${filePath}`);
  }
  return parsed;
}

async function writeJsonFileAtomic(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.tmp-${basename(filePath)}-${randomUUID()}`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    mode: USER_CONFIG_FILE_MODE,
  });
  await rename(tempPath, filePath);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

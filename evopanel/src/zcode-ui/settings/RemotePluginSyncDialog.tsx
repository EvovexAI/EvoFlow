/* eslint-disable max-lines -- 远端 plugin 同步弹窗集中维护加载、选择、风险提示、逐项进度和结果状态，保持与 Skill/MCP 同步弹窗一致。 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2,
  CircleStop,
  CircleX,
  Loader2,
  Cable,
  UploadCloud,
} from "lucide-react";
import type {
  PluginSyncCandidate,
  PluginSyncImportResult,
  PluginSyncRemoteStatus,
  RemoteTarget,
  ZCodePluginOptionValue,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
  ZCodePluginUserConfigOption,
  ZCodePluginsOverviewResult,
} from "@zcode/shared";
import type { IPluginSyncService, IZCodeAgentService } from "@zcode/services";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import {
  isRemoteSyncPreflightTimeoutError,
  runRemoteSyncPreflightWithTimeout,
  shouldStartRemoteSyncOperation,
} from "@/settings/RemoteSyncActions.js";

type RemotePluginSyncDialogStep = "loading" | "selection" | "preflighting" | "syncing" | "complete";
type Step = RemotePluginSyncDialogStep;
type RemotePluginSyncKind = "inline" | "marketplace";

interface RemotePluginSyncPluginOptions {
  configuredOptions: Record<string, ZCodePluginOptionValue>;
  userConfig: Record<string, ZCodePluginUserConfigOption>;
}

type RemotePluginSyncAgentService = Pick<
  IZCodeAgentService,
  | "addPluginMarketplace"
  | "cancelPluginOperation"
  | "configurePlugin"
  | "getPluginsOverview"
  | "installPlugin"
  | "listPlugins"
  | "setPluginEnabled"
>;

const REMOTE_PLUGIN_SYNC_CONFIG_SCOPE = "user" as const;

interface RemotePluginSyncCandidate {
  id: string;
  kind: RemotePluginSyncKind;
  name: string;
  pluginId: string;
  marketplace: string;
  description?: string;
  version?: string;
  path?: string;
  enabled: boolean;
  componentTypes: string[];
  inlineCandidate?: PluginSyncCandidate;
  pluginOptions?: RemotePluginSyncPluginOptions;
  marketplacePlugin?: {
    marketplaceSourceArchive?: {
      marketplaceId: string;
      source: Record<string, unknown>;
    };
    marketplaceSourceInput?: string;
    pluginName: string;
  };
}

interface RemotePluginSyncCandidateStatus {
  candidateId: string;
  exists: boolean;
  path?: string;
  reason?: "samePluginId" | "targetExists";
  remoteMarketplaceExists?: boolean;
}

interface RemotePluginSyncRow {
  candidate: RemotePluginSyncCandidate;
  exists: boolean;
  path?: string;
  reason?: "samePluginId" | "targetExists";
  remoteMarketplaceExists?: boolean;
}

type RemotePluginSyncResultStatus = PluginSyncImportResult["results"][number]["status"] | "stopped";

interface RemotePluginSyncResultItem extends Omit<
  PluginSyncImportResult["results"][number],
  "status"
> {
  status: RemotePluginSyncResultStatus;
}

interface RemotePluginSyncRunResult {
  results: RemotePluginSyncResultItem[];
}

function shouldFinishRemotePluginSyncRun(
  currentRun: AbortController | null,
  run: AbortController,
): boolean {
  return currentRun === run;
}

type RemotePluginSyncProgressStatus = "queued" | "syncing" | RemotePluginSyncResultStatus;

interface RemotePluginSyncProgressEvent {
  candidateId: string;
  log: string;
  pluginId: string;
  result?: RemotePluginSyncResultItem;
  status: RemotePluginSyncProgressStatus;
}

interface RemotePluginSyncStopControl {
  cancelOperation?: (operationId: string) => Promise<void>;
  isStopped: (candidateId: string) => boolean;
  waitForStop?: (candidateId: string) => Promise<void>;
}

interface RemotePluginSyncProgressView {
  logs: string[];
  result?: RemotePluginSyncResultItem;
  status: RemotePluginSyncProgressStatus;
}

class RemotePluginSyncStoppedError extends Error {
  constructor(readonly row: RemotePluginSyncRow) {
    super(`Stopped sync for ${row.candidate.pluginId}`);
    this.name = "RemotePluginSyncStoppedError";
  }
}

let remotePluginSyncOperationCounter = 0;

function createRemotePluginSyncOperationId(row: RemotePluginSyncRow): string {
  remotePluginSyncOperationCounter += 1;
  const safePluginId = row.candidate.pluginId.replace(/[^a-z0-9._-]+/giu, "-");
  return `remote-plugin-sync-${remotePluginSyncOperationCounter}-${safePluginId}`;
}

interface RemotePluginSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  localPluginSyncService: IPluginSyncService;
  remotePluginSyncService: IPluginSyncService;
  localZCodeAgentService?: RemotePluginSyncAgentService | null;
  remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
  remoteTarget: RemoteTarget;
  localWorkspacePath?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  onSynced: () => Promise<void> | void;
}

function toInlineRemotePluginSyncCandidate(
  candidate: PluginSyncCandidate,
): RemotePluginSyncCandidate {
  return {
    id: `inline:${candidate.id}`,
    kind: "inline",
    name: candidate.name,
    pluginId: candidate.pluginId,
    marketplace: "inline",
    ...(candidate.description ? { description: candidate.description } : {}),
    ...(candidate.version ? { version: candidate.version } : {}),
    path: candidate.path,
    enabled: candidate.enabled,
    componentTypes: candidate.componentTypes,
    inlineCandidate: candidate,
  };
}

function createInlineStatusKey(pluginId: string, directoryName: string): string {
  return `${pluginId.toLowerCase()}\u0000${directoryName}`;
}

function buildRemotePluginSyncRows(
  candidates: readonly PluginSyncCandidate[],
  statuses: readonly PluginSyncRemoteStatus[],
): RemotePluginSyncRow[] {
  const statusByKey = new Map(
    statuses.map((status) => [
      createInlineStatusKey(status.pluginId, status.directoryName),
      status,
    ]),
  );
  return buildRemotePluginSyncRowsForCandidates(
    candidates.map(toInlineRemotePluginSyncCandidate),
    candidates.map((candidate) => {
      const status = statusByKey.get(
        createInlineStatusKey(candidate.pluginId, candidate.directoryName),
      );
      return {
        candidateId: `inline:${candidate.id}`,
        exists: status?.exists ?? false,
        ...(status?.path ? { path: status.path } : {}),
        ...(status?.reason ? { reason: status.reason } : {}),
      };
    }),
  );
}

function buildRemotePluginSyncRowsForCandidates(
  candidates: readonly RemotePluginSyncCandidate[],
  statuses: readonly RemotePluginSyncCandidateStatus[],
): RemotePluginSyncRow[] {
  const statusById = new Map(statuses.map((status) => [status.candidateId, status]));
  return candidates.map((candidate) => {
    const status = statusById.get(candidate.id);
    return {
      candidate,
      exists: status?.exists ?? false,
      ...(status?.path ? { path: status.path } : {}),
      ...(status?.reason ? { reason: status.reason } : {}),
      ...(status?.remoteMarketplaceExists !== undefined
        ? { remoteMarketplaceExists: status.remoteMarketplaceExists }
        : {}),
    };
  });
}

function resolveDefaultRemotePluginSyncSelection(
  rows: readonly RemotePluginSyncRow[],
): Set<string> {
  return new Set(rows.filter((row) => !row.exists).map((row) => row.candidate.id));
}

function filterRemotePluginSyncRows(
  rows: readonly RemotePluginSyncRow[],
  showExistingRemotePlugins: boolean,
): RemotePluginSyncRow[] {
  return showExistingRemotePlugins ? [...rows] : rows.filter((row) => !row.exists);
}

function shouldAllowRemotePluginSyncDialogOpenChange(
  step: RemotePluginSyncDialogStep,
  nextOpen: boolean,
): boolean {
  return nextOpen || (step !== "preflighting" && step !== "syncing");
}

function buildMarketplaceRemotePluginSyncCandidates(
  overview: ZCodePluginsOverviewResult,
  plugins: readonly ZCodePluginInfo[],
): RemotePluginSyncCandidate[] {
  const pluginInfoById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const marketplaceSourceById = new Map(
    overview.marketplaces.map((marketplace) => [
      marketplace.id,
      buildMarketplaceSourceSyncInfo(marketplace),
    ]),
  );
  return overview.installedPlugins.map((plugin) => {
    const info = pluginInfoById.get(plugin.id);
    const componentTypes = plugin.componentTypes ?? componentTypesFromPluginInfo(info);
    const marketplaceSource = marketplaceSourceById.get(plugin.marketplace);
    const pluginOptions = buildRemotePluginSyncPluginOptions(info);
    return {
      id: `marketplace:${plugin.id}`,
      kind: "marketplace",
      name: plugin.name,
      pluginId: plugin.id,
      marketplace: plugin.marketplace,
      ...((plugin.description ?? info?.description)
        ? { description: plugin.description ?? info?.description }
        : {}),
      ...((plugin.version ?? info?.version) ? { version: plugin.version ?? info?.version } : {}),
      ...((plugin.installPath ?? info?.rootPath)
        ? { path: plugin.installPath ?? info?.rootPath }
        : {}),
      enabled: plugin.enabled,
      componentTypes,
      ...(pluginOptions ? { pluginOptions } : {}),
      marketplacePlugin: {
        ...marketplaceSource,
        pluginName: plugin.name,
      },
    };
  });
}

function buildMarketplaceRemotePluginStatuses(
  candidates: readonly RemotePluginSyncCandidate[],
  remoteOverview: ZCodePluginsOverviewResult,
): RemotePluginSyncCandidateStatus[] {
  const installedById = new Map(
    remoteOverview.installedPlugins.map((plugin) => [plugin.id, plugin]),
  );
  const remoteMarketplaceIds = new Set(
    remoteOverview.marketplaces.map((marketplace) => marketplace.id),
  );
  return candidates.map((candidate) => {
    const installed = installedById.get(candidate.pluginId);
    return {
      candidateId: candidate.id,
      exists: Boolean(installed),
      ...(installed?.installPath ? { path: installed.installPath } : {}),
      ...(installed ? { reason: "samePluginId" as const } : {}),
      remoteMarketplaceExists: remoteMarketplaceIds.has(candidate.marketplace),
    };
  });
}

function componentTypesFromPluginInfo(plugin: ZCodePluginInfo | undefined): string[] {
  return plugin?.components?.map((component) => component.kind) ?? [];
}

function buildRemotePluginSyncPluginOptions(
  plugin: ZCodePluginInfo | undefined,
): RemotePluginSyncPluginOptions | undefined {
  const configuredOptions = plugin?.configuredOptions ?? {};
  if (Object.keys(configuredOptions).length === 0) {
    return undefined;
  }
  return {
    configuredOptions: { ...configuredOptions },
    userConfig: { ...(plugin?.userConfig ?? {}) },
  };
}

function applyPluginInfoToRemoteSyncCandidate(
  candidate: RemotePluginSyncCandidate,
  plugin: ZCodePluginInfo | undefined,
): RemotePluginSyncCandidate {
  const pluginOptions = buildRemotePluginSyncPluginOptions(plugin);
  return pluginOptions ? { ...candidate, pluginOptions } : candidate;
}

function enrichRemotePluginSyncCandidatesWithPluginInfo(
  candidates: readonly RemotePluginSyncCandidate[],
  plugins: readonly ZCodePluginInfo[],
): RemotePluginSyncCandidate[] {
  const pluginInfoById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  return candidates.map((candidate) =>
    applyPluginInfoToRemoteSyncCandidate(candidate, pluginInfoById.get(candidate.pluginId)),
  );
}

function summarizeLocalPluginOptionsForDisplay(
  pluginOptions: RemotePluginSyncPluginOptions | undefined,
): { manualCount: number; syncableCount: number } | null {
  if (!pluginOptions || Object.keys(pluginOptions.configuredOptions).length === 0) {
    return null;
  }
  let syncableCount = 0;
  let manualCount = 0;
  for (const [key, value] of Object.entries(pluginOptions.configuredOptions)) {
    const option = pluginOptions.userConfig[key];
    if (isPortablePluginOptionValue(value, option, option)) {
      syncableCount += 1;
    } else {
      manualCount += 1;
    }
  }
  return { manualCount, syncableCount };
}

function serializeMarketplaceSourceInput(
  marketplace: ZCodePluginMarketplaceSummary,
): string | undefined {
  const source = marketplace.source;
  const sourceKind = typeof source.source === "string" ? source.source : "";
  const refSuffix =
    typeof source.ref === "string" && source.ref.trim() ? `#${source.ref.trim()}` : "";
  if (sourceKind === "github" && typeof source.repo === "string" && source.repo.trim()) {
    return `${source.repo.trim()}${refSuffix}`;
  }
  if (sourceKind === "git" && typeof source.url === "string" && source.url.trim()) {
    return `${source.url.trim()}${refSuffix}`;
  }
  if (sourceKind === "url" && typeof source.url === "string" && source.url.trim()) {
    return source.url.trim();
  }
  return undefined;
}

function buildMarketplaceSourceSyncInfo(
  marketplace: ZCodePluginMarketplaceSummary,
): Pick<
  NonNullable<RemotePluginSyncCandidate["marketplacePlugin"]>,
  "marketplaceSourceArchive" | "marketplaceSourceInput"
> {
  const sourceInput = serializeMarketplaceSourceInput(marketplace);
  if (sourceInput) {
    return { marketplaceSourceInput: sourceInput };
  }
  const sourceKind = typeof marketplace.source.source === "string" ? marketplace.source.source : "";
  if (["file", "directory", "settings"].includes(sourceKind)) {
    return {
      marketplaceSourceArchive: {
        marketplaceId: marketplace.id,
        source: marketplace.source,
      },
    };
  }
  return {};
}

async function loadRemotePluginSyncCandidates(params: {
  localPluginSyncService: IPluginSyncService;
  localWorkspacePath: string;
  localZCodeAgentService?: RemotePluginSyncAgentService | null;
  remotePluginSyncService: IPluginSyncService;
  remoteWorkspaceIdentity?: string;
  remoteWorkspacePath: string;
  remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
}): Promise<{
  candidates: RemotePluginSyncCandidate[];
  statuses: RemotePluginSyncCandidateStatus[];
}> {
  const localInlineResult = await params.localPluginSyncService.listLocalUserPluginCandidates();
  const inlineCandidates = localInlineResult.candidates.map(toInlineRemotePluginSyncCandidate);
  const remoteInlineResult = await params.remotePluginSyncService.listRemoteUserPluginStatuses({
    plugins: localInlineResult.candidates.map((candidate) => ({
      pluginId: candidate.pluginId,
      directoryName: candidate.directoryName,
    })),
  });
  const inlineStatuses = buildRemotePluginSyncRows(
    localInlineResult.candidates,
    remoteInlineResult.statuses,
  ).map(
    (row): RemotePluginSyncCandidateStatus => ({
      candidateId: row.candidate.id,
      exists: row.exists,
      ...(row.path ? { path: row.path } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    }),
  );

  if (!params.localZCodeAgentService || !params.remoteZCodeAgentService) {
    return { candidates: inlineCandidates, statuses: inlineStatuses };
  }

  const [localOverview, localPluginsResult, remoteOverview] = await Promise.all([
    params.localZCodeAgentService.getPluginsOverview({
      workspacePath: params.localWorkspacePath,
    }),
    params.localZCodeAgentService.listPlugins({
      workspacePath: params.localWorkspacePath,
    }),
    params.remoteZCodeAgentService.getPluginsOverview({
      workspacePath: params.remoteWorkspacePath,
      ...(params.remoteWorkspaceIdentity
        ? { workspaceIdentity: params.remoteWorkspaceIdentity }
        : {}),
    }),
  ]);
  const marketplaceCandidates = buildMarketplaceRemotePluginSyncCandidates(
    localOverview,
    localPluginsResult.plugins,
  );
  return {
    candidates: [
      ...enrichRemotePluginSyncCandidatesWithPluginInfo(
        inlineCandidates,
        localPluginsResult.plugins,
      ),
      ...marketplaceCandidates,
    ],
    statuses: [
      ...inlineStatuses,
      ...buildMarketplaceRemotePluginStatuses(marketplaceCandidates, remoteOverview),
    ],
  };
}

function isRemotePluginSyncStoppedError(error: unknown): error is RemotePluginSyncStoppedError {
  return error instanceof RemotePluginSyncStoppedError;
}

function buildStoppedRemotePluginResult(row: RemotePluginSyncRow): RemotePluginSyncResultItem {
  return {
    name: row.candidate.name,
    pluginId: row.candidate.pluginId,
    directoryName:
      row.candidate.kind === "inline"
        ? (row.candidate.inlineCandidate?.directoryName ?? row.candidate.name)
        : `${row.candidate.marketplace}/${row.candidate.name}`,
    status: "stopped",
    error:
      "stop requested; stopped waiting for this plugin sync. Any remote RPC that already started may still finish on the remote target.",
  };
}

function emitRemotePluginSyncProgress(
  params: {
    onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
  },
  row: RemotePluginSyncRow,
  status: RemotePluginSyncProgressStatus,
  log: string,
  result?: RemotePluginSyncResultItem,
) {
  params.onItemProgress?.({
    candidateId: row.candidate.id,
    log,
    pluginId: row.candidate.pluginId,
    ...(result ? { result } : {}),
    status,
  });
}

function throwIfRemotePluginSyncStopped(
  params: {
    signal?: AbortSignal;
    stopControl?: RemotePluginSyncStopControl;
  },
  row: RemotePluginSyncRow,
) {
  if (params.signal?.aborted || params.stopControl?.isStopped(row.candidate.id)) {
    throw new RemotePluginSyncStoppedError(row);
  }
}

async function awaitRemotePluginSyncStep<T>(
  params: {
    onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
    signal?: AbortSignal;
    stopControl?: RemotePluginSyncStopControl;
  },
  row: RemotePluginSyncRow,
  log: string,
  run: (operationId: string) => Promise<T>,
  options: { cancellableRemoteOperation?: boolean } = {},
): Promise<T> {
  throwIfRemotePluginSyncStopped(params, row);
  const operationId = createRemotePluginSyncOperationId(row);
  emitRemotePluginSyncProgress(params, row, "syncing", `${log} (${operationId})`);
  const promise = run(operationId);
  const stopPromise = params.stopControl?.waitForStop?.(row.candidate.id);
  let removeAbortListener: (() => void) | undefined;
  const abortPromise = params.signal
    ? new Promise<void>((resolve) => {
        if (params.signal?.aborted) {
          resolve();
          return;
        }
        const handleAbort = () => resolve();
        params.signal?.addEventListener("abort", handleAbort, { once: true });
        removeAbortListener = () => params.signal?.removeEventListener("abort", handleAbort);
      })
    : undefined;
  const interruptionPromises = [stopPromise, abortPromise].filter(
    (candidate): candidate is Promise<void> => Boolean(candidate),
  );
  if (interruptionPromises.length === 0) {
    return await promise;
  }
  try {
    return await Promise.race([
      promise,
      Promise.race(interruptionPromises).then(async () => {
        if (options.cancellableRemoteOperation === true && params.stopControl?.cancelOperation) {
          emitRemotePluginSyncProgress(
            params,
            row,
            "stopped",
            `request cancel plugin sync operation ${operationId}`,
          );
          try {
            await params.stopControl.cancelOperation(operationId);
            emitRemotePluginSyncProgress(
              params,
              row,
              "stopped",
              `cancel request sent for ${operationId}`,
            );
          } catch (error) {
            emitRemotePluginSyncProgress(
              params,
              row,
              "stopped",
              `cancel request failed for ${operationId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        throw new RemotePluginSyncStoppedError(row);
      }),
    ]);
  } finally {
    removeAbortListener?.();
  }
}

function isPathPluginOption(option: ZCodePluginUserConfigOption | undefined): boolean {
  return option?.type === "file" || option?.type === "directory";
}

function isPortablePluginOptionValue(
  value: ZCodePluginOptionValue,
  localOption: ZCodePluginUserConfigOption | undefined,
  remoteOption: ZCodePluginUserConfigOption | undefined,
): boolean {
  if (!localOption || !remoteOption) {
    return false;
  }
  if (localOption.sensitive === true || remoteOption.sensitive === true) {
    return false;
  }
  if (isPathPluginOption(localOption) || isPathPluginOption(remoteOption)) {
    return false;
  }
  const expectedType = remoteOption.type ?? localOption.type;
  if (expectedType === "boolean") return typeof value === "boolean";
  if (expectedType === "number") return typeof value === "number";
  if (expectedType === "string") return typeof value === "string";
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function buildPortablePluginOptionsSyncPlan(
  localOptions: RemotePluginSyncPluginOptions,
  remotePlugin: ZCodePluginInfo,
): { options: Record<string, ZCodePluginOptionValue>; skippedCount: number } {
  const options: Record<string, ZCodePluginOptionValue> = {};
  let skippedCount = 0;
  for (const [key, value] of Object.entries(localOptions.configuredOptions)) {
    if (
      isPortablePluginOptionValue(
        value,
        localOptions.userConfig[key],
        remotePlugin.userConfig?.[key],
      )
    ) {
      options[key] = value;
    } else {
      skippedCount += 1;
    }
  }
  return { options, skippedCount };
}

function arePluginOptionsEqual(
  left: Record<string, ZCodePluginOptionValue>,
  right: Record<string, ZCodePluginOptionValue>,
): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) {
    return false;
  }
  return leftEntries.every(([key, value]) => right[key] === value);
}

async function syncPortablePluginOptions(
  params: {
    onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
    remoteWorkspaceIdentity?: string;
    remoteWorkspacePath: string;
    remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
    signal?: AbortSignal;
    stopControl?: RemotePluginSyncStopControl;
  },
  row: RemotePluginSyncRow,
): Promise<void> {
  const localOptions = row.candidate.pluginOptions;
  if (!localOptions || Object.keys(localOptions.configuredOptions).length === 0) {
    return;
  }
  const remoteZCodeAgentService = params.remoteZCodeAgentService;
  if (!remoteZCodeAgentService) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      "skip plugin options: remote plugin service is not available",
    );
    return;
  }
  const workspace = {
    workspacePath: params.remoteWorkspacePath,
    ...(params.remoteWorkspaceIdentity
      ? { workspaceIdentity: params.remoteWorkspaceIdentity }
      : {}),
  };
  const remotePlugins = await awaitRemotePluginSyncStep(
    params,
    row,
    `RPC plugins/list for options ${row.candidate.pluginId}`,
    () => remoteZCodeAgentService.listPlugins(workspace),
  );
  const remotePlugin = remotePlugins.plugins.find((plugin) => plugin.id === row.candidate.pluginId);
  if (!remotePlugin) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      `skip plugin options: remote plugin schema not found for ${row.candidate.pluginId}`,
    );
    return;
  }
  const plan = buildPortablePluginOptionsSyncPlan(localOptions, remotePlugin);
  if (plan.skippedCount > 0) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      `skipped ${plan.skippedCount} non-portable plugin option(s)`,
    );
  }
  const portableCount = Object.keys(plan.options).length;
  if (portableCount === 0) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      "skip plugin options: no portable configured option values",
    );
    return;
  }
  const mergedOptions = {
    ...(remotePlugin.configuredOptions ?? {}),
    ...plan.options,
  };
  if (arePluginOptionsEqual(remotePlugin.configuredOptions ?? {}, mergedOptions)) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      `plugin options already synced (${portableCount} portable option(s))`,
    );
    return;
  }
  await awaitRemotePluginSyncStep(
    params,
    row,
    `RPC plugins/configure ${portableCount} portable option(s) for ${row.candidate.pluginId}`,
    () =>
      remoteZCodeAgentService.configurePlugin({
        ...workspace,
        options: mergedOptions,
        pluginId: row.candidate.pluginId,
        scope: REMOTE_PLUGIN_SYNC_CONFIG_SCOPE,
      }),
  );
}

async function syncSelectedRemotePlugins(params: {
  localPluginSyncService: IPluginSyncService;
  onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
  remotePluginSyncService: IPluginSyncService;
  remoteWorkspaceIdentity?: string;
  remoteWorkspacePath: string;
  remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
  rows: readonly RemotePluginSyncRow[];
  signal?: AbortSignal;
  stopControl?: RemotePluginSyncStopControl;
}): Promise<RemotePluginSyncRunResult> {
  const results: RemotePluginSyncRunResult["results"] = [];
  for (const row of params.rows) {
    emitRemotePluginSyncProgress(params, row, "queued", "Queued plugin sync");
  }

  for (const row of params.rows) {
    if (row.candidate.kind !== "inline") {
      continue;
    }
    try {
      throwIfRemotePluginSyncStopped(params, row);
      const inlineCandidate = row.candidate.inlineCandidate;
      if (!inlineCandidate) {
        throw new Error("inline plugin metadata is not available");
      }
      const exported = await awaitRemotePluginSyncStep(
        params,
        row,
        `export inline plugin ${row.candidate.pluginId}`,
        () =>
          params.localPluginSyncService.exportPluginsArchive({
            pluginIds: [inlineCandidate.id],
          }),
      );
      const result = await awaitRemotePluginSyncStep(
        params,
        row,
        `import inline plugin ${row.candidate.pluginId} on remote`,
        () =>
          params.remotePluginSyncService.importPluginsArchive({
            archive: exported.archive,
            overwrite: false,
          }),
      );
      const item = result.results[0];
      if (!item) {
        throw new Error(`remote import did not return ${row.candidate.pluginId}`);
      }
      if (item.status === "synced") {
        await syncPortablePluginOptions(params, row);
      }
      results.push(item);
      emitRemotePluginSyncProgress(params, row, item.status, `inline plugin ${item.status}`, item);
    } catch (error) {
      const item = isRemotePluginSyncStoppedError(error)
        ? buildStoppedRemotePluginResult(row)
        : {
            name: row.candidate.name,
            pluginId: row.candidate.pluginId,
            directoryName: row.candidate.inlineCandidate?.directoryName ?? row.candidate.name,
            status: "failed" as const,
            error: error instanceof Error ? error.message : String(error),
          };
      results.push(item);
      emitRemotePluginSyncProgress(params, row, item.status, item.error ?? item.status, item);
    }
  }

  const selectedMarketplacePluginNames = buildSelectedMarketplacePluginNames(params.rows);
  const preparedMarketplaceSources = new Set<string>();
  for (const row of params.rows) {
    if (row.candidate.kind !== "marketplace") {
      continue;
    }
    results.push(
      await syncMarketplaceRemotePlugin(
        {
          ...params,
          preparedMarketplaceSources,
          selectedMarketplacePluginNames,
        },
        row,
      ),
    );
  }
  return { results };
}

async function syncMarketplaceRemotePlugin(
  params: {
    localPluginSyncService: IPluginSyncService;
    onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
    preparedMarketplaceSources: Set<string>;
    remotePluginSyncService: IPluginSyncService;
    remoteWorkspaceIdentity?: string;
    remoteWorkspacePath: string;
    remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
    selectedMarketplacePluginNames: ReadonlyMap<string, string[]>;
    signal?: AbortSignal;
    stopControl?: RemotePluginSyncStopControl;
  },
  row: RemotePluginSyncRow,
): Promise<RemotePluginSyncResultItem> {
  const candidate = row.candidate;
  const marketplacePlugin = candidate.marketplacePlugin;
  const directoryName = `${candidate.marketplace}/${candidate.name}`;
  try {
    throwIfRemotePluginSyncStopped(params, row);
    if (!params.remoteZCodeAgentService || !marketplacePlugin) {
      throw new Error("remote plugin install service is not available");
    }
    const remoteZCodeAgentService = params.remoteZCodeAgentService;
    const workspace = {
      workspacePath: params.remoteWorkspacePath,
      ...(params.remoteWorkspaceIdentity
        ? { workspaceIdentity: params.remoteWorkspaceIdentity }
        : {}),
    };
    if (
      !row.remoteMarketplaceExists &&
      !params.preparedMarketplaceSources.has(candidate.marketplace)
    ) {
      await prepareRemoteMarketplaceSource(
        {
          localPluginSyncService: params.localPluginSyncService,
          onItemProgress: params.onItemProgress,
          remotePluginSyncService: params.remotePluginSyncService,
          remoteZCodeAgentService,
          selectedMarketplacePluginNames: params.selectedMarketplacePluginNames,
          signal: params.signal,
          stopControl: params.stopControl,
        },
        row,
        workspace,
      );
      params.preparedMarketplaceSources.add(candidate.marketplace);
    }
    const installResult = await awaitRemotePluginSyncStep(
      params,
      row,
      `RPC plugins/install ${candidate.pluginId}`,
      (operationId) =>
        remoteZCodeAgentService.installPlugin({
          ...workspace,
          marketplace: candidate.marketplace,
          operationId,
          pluginName: marketplacePlugin.pluginName,
          scope: REMOTE_PLUGIN_SYNC_CONFIG_SCOPE,
        }),
      { cancellableRemoteOperation: true },
    );
    const installError = formatInstallError(installResult, candidate.pluginId);
    if (installError) {
      throw new Error(installError);
    }
    const installedPlugin = installResult.installedPlugins.find(
      (plugin) => plugin.id === candidate.pluginId,
    );
    if (!installedPlugin) {
      throw new Error(`remote install did not return ${candidate.pluginId}`);
    }
    await awaitRemotePluginSyncStep(
      params,
      row,
      `RPC plugins/setEnabled enabled=${String(candidate.enabled)} for ${candidate.pluginId}`,
      () =>
        remoteZCodeAgentService.setPluginEnabled({
          ...workspace,
          enabled: candidate.enabled,
          pluginId: candidate.pluginId,
          scope: REMOTE_PLUGIN_SYNC_CONFIG_SCOPE,
        }),
    );
    await syncPortablePluginOptions(params, row);
    const result = {
      name: candidate.name,
      pluginId: candidate.pluginId,
      directoryName,
      status: "synced",
      ...(installedPlugin.installPath ? { path: installedPlugin.installPath } : {}),
    } satisfies RemotePluginSyncResultItem;
    emitRemotePluginSyncProgress(params, row, "synced", "marketplace plugin synced", result);
    return result;
  } catch (error) {
    const result = isRemotePluginSyncStoppedError(error)
      ? buildStoppedRemotePluginResult(row)
      : {
          name: candidate.name,
          pluginId: candidate.pluginId,
          directoryName,
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        };
    emitRemotePluginSyncProgress(params, row, result.status, result.error ?? result.status, result);
    return result;
  }
}

function buildSelectedMarketplacePluginNames(
  rows: readonly RemotePluginSyncRow[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const marketplacePlugin = row.candidate.marketplacePlugin;
    if (row.candidate.kind !== "marketplace" || !marketplacePlugin) {
      continue;
    }
    const names = result.get(row.candidate.marketplace) ?? [];
    names.push(marketplacePlugin.pluginName);
    result.set(row.candidate.marketplace, names);
  }
  return result;
}

async function prepareRemoteMarketplaceSource(
  params: {
    localPluginSyncService: IPluginSyncService;
    onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
    remotePluginSyncService: IPluginSyncService;
    remoteZCodeAgentService: RemotePluginSyncAgentService;
    selectedMarketplacePluginNames: ReadonlyMap<string, string[]>;
    signal?: AbortSignal;
    stopControl?: RemotePluginSyncStopControl;
  },
  row: RemotePluginSyncRow,
  workspace: { workspaceIdentity?: string; workspacePath: string },
): Promise<void> {
  const candidate = row.candidate;
  const marketplacePlugin = candidate.marketplacePlugin;
  if (!marketplacePlugin) {
    throw new Error("marketplace plugin metadata is not available");
  }
  const marketplaceSourceInput = marketplacePlugin.marketplaceSourceInput;
  if (marketplaceSourceInput) {
    await awaitRemotePluginSyncStep(
      params,
      row,
      `RPC plugins/marketplace/add ${candidate.marketplace} from ${marketplaceSourceInput}`,
      (operationId) =>
        params.remoteZCodeAgentService.addPluginMarketplace({
          ...workspace,
          operationId,
          source: marketplaceSourceInput,
        }),
      { cancellableRemoteOperation: true },
    );
    return;
  }
  const marketplaceSourceArchive = marketplacePlugin.marketplaceSourceArchive;
  if (!marketplaceSourceArchive) {
    throw new Error(`marketplace source cannot be synchronized: ${candidate.marketplace}`);
  }
  const exported = await awaitRemotePluginSyncStep(
    params,
    row,
    `export marketplace source ${candidate.marketplace}`,
    () =>
      params.localPluginSyncService.exportMarketplaceSourceArchive({
        marketplaceId: marketplaceSourceArchive.marketplaceId,
        pluginNames: params.selectedMarketplacePluginNames.get(candidate.marketplace) ?? [
          marketplacePlugin.pluginName,
        ],
        source: marketplaceSourceArchive.source,
      }),
  );
  const imported = await awaitRemotePluginSyncStep(
    params,
    row,
    `import marketplace source ${candidate.marketplace} on remote`,
    () =>
      params.remotePluginSyncService.importMarketplaceSourceArchive({
        archive: exported.archive,
        overwrite: false,
      }),
  );
  await awaitRemotePluginSyncStep(
    params,
    row,
    `RPC plugins/marketplace/add mirrored ${candidate.marketplace} from ${imported.path}`,
    (operationId) =>
      params.remoteZCodeAgentService.addPluginMarketplace({
        ...workspace,
        operationId,
        source: imported.path,
      }),
    { cancellableRemoteOperation: true },
  );
}

function formatInstallError(
  result: Awaited<ReturnType<RemotePluginSyncAgentService["installPlugin"]>>,
  pluginId: string,
): string | null {
  const diagnostics = result.diagnostics.filter((diagnostic) => diagnostic.severity !== "warning");
  if (diagnostics.length === 0) {
    return null;
  }
  return diagnostics
    .map((diagnostic) => {
      const target = diagnostic.pluginId ?? pluginId;
      return `${target}: ${diagnostic.message}`;
    })
    .join("; ");
}

function RemotePluginSyncTitle() {
  const { intl } = useZCodeIntl();
  const [warningTooltipOpen, setWarningTooltipOpen] = useState(false);
  const warningTitle = intl.formatMessage({
    id: "settings.plugins.remoteSync.warningTitle",
  });

  return (
    <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: "settings.plugins.remoteSync.title" })}
      </span>
      <ControlHintTooltip
        open={warningTooltipOpen}
        title={warningTitle}
        description={intl.formatMessage({
          id: "settings.plugins.remoteSync.warningDescription",
        })}
        side="right"
        align="center"
      >
        <span
          aria-label={warningTitle}
          className="inline-flex size-5 items-center justify-center rounded-full text-warning transition-colors hover:bg-hover hover:text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          onMouseEnter={() => setWarningTooltipOpen(true)}
          onMouseLeave={() => setWarningTooltipOpen(false)}
          role="img"
        >
          <AlertCircleIcon className="size-3.5" aria-hidden="true" />
        </span>
      </ControlHintTooltip>
    </DialogTitle>
  );
}

function RemotePluginSyncExistingFilterCheckbox({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <label className="inline-flex h-6 cursor-pointer items-center gap-2 rounded-md px-1 text-ui-base text-foreground-subtle hover:text-foreground">
      <input
        type="checkbox"
        className="size-4"
        checked={checked}
        onChange={(event) => onCheckedChange(event.currentTarget.checked)}
      />
      <span>{intl.formatMessage({ id: "settings.plugins.remoteSync.showExisting" })}</span>
    </label>
  );
}

function RemotePluginSyncTargetRow({
  targetLabel,
  showExistingRemotePlugins,
  showExistingFilter,
  onShowExistingRemotePluginsChange,
}: {
  targetLabel: string;
  showExistingRemotePlugins: boolean;
  showExistingFilter: boolean;
  onShowExistingRemotePluginsChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="min-w-0 break-words font-mono text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.remoteSync.target" }, { target: targetLabel })}
      </p>
      {showExistingFilter ? (
        <div className="shrink-0">
          <RemotePluginSyncExistingFilterCheckbox
            checked={showExistingRemotePlugins}
            onCheckedChange={onShowExistingRemotePluginsChange}
          />
        </div>
      ) : null}
    </div>
  );
}

function RemotePluginSyncBulkSelectionCheckbox({
  selectedCount,
  totalSelectable,
  onSelectAll,
  onClearAll,
}: {
  selectedCount: number;
  totalSelectable: number;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  const { intl } = useZCodeIntl();
  const inputRef = useRef<HTMLInputElement>(null);
  const disabled = totalSelectable === 0;
  const checked = totalSelectable > 0 && selectedCount >= totalSelectable;
  const indeterminate = totalSelectable > 0 && selectedCount > 0 && selectedCount < totalSelectable;

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <label
      className={`inline-flex h-6 items-center gap-2 rounded-md px-1 text-ui-base text-foreground-subtle ${
        disabled ? "opacity-50" : "cursor-pointer hover:text-foreground"
      }`}
    >
      <input
        ref={inputRef}
        type="checkbox"
        className="size-4"
        checked={checked}
        disabled={disabled}
        aria-checked={indeterminate ? "mixed" : checked ? "true" : "false"}
        onChange={(event) => {
          if (event.currentTarget.checked) {
            onSelectAll();
          } else {
            onClearAll();
          }
        }}
      />
      <span>{intl.formatMessage({ id: "settings.plugins.remoteSync.selectAll" })}</span>
    </label>
  );
}

function RemotePluginSyncSelectionList({
  rows,
  selectedIds,
  emptyMessageId = "settings.plugins.remoteSync.empty",
  onToggle,
}: {
  rows: readonly RemotePluginSyncRow[];
  selectedIds: ReadonlySet<string>;
  emptyMessageId?: string;
  onToggle: (pluginId: string, checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: emptyMessageId })}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {rows.map((row) => {
        const checkboxId = `remote-plugin-sync-${row.candidate.id}`;
        const labelId = `${checkboxId}-label`;
        const selected = !row.exists && selectedIds.has(row.candidate.id);
        const optionSummary = summarizeLocalPluginOptionsForDisplay(row.candidate.pluginOptions);
        return (
          <label
            key={row.candidate.id}
            htmlFor={checkboxId}
            className={`grid grid-cols-[auto_auto_minmax(0,1fr)] gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base ${
              row.exists
                ? "cursor-default"
                : "cursor-pointer hover:border-border-hover hover:bg-surface-hover"
            }`}
          >
            <input
              id={checkboxId}
              type="checkbox"
              aria-labelledby={labelId}
              className="mt-1 size-4"
              checked={selected}
              disabled={row.exists}
              onChange={(event) => onToggle(row.candidate.id, event.currentTarget.checked)}
            />
            <span
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-foreground-subtle"
              aria-hidden="true"
            >
              <Cable className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <span id={labelId} className="font-medium text-foreground">
                  {row.candidate.name}
                </span>
                {row.candidate.version ? (
                  <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                    {row.candidate.version}
                  </span>
                ) : null}
                {row.candidate.componentTypes.map((type) => (
                  <span
                    key={type}
                    className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle"
                  >
                    {type}
                  </span>
                ))}
                <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                  {row.candidate.kind === "inline" ? "inline" : row.candidate.marketplace}
                </span>
                {row.exists ? (
                  <span className="text-ui-base text-foreground-subtlest">
                    {intl.formatMessage({ id: "settings.plugins.remoteSync.existing" })}
                  </span>
                ) : null}
              </span>
              {row.candidate.description ? (
                <span className="mt-1 block text-ui-base text-foreground-subtle">
                  {row.candidate.description}
                </span>
              ) : null}
              {row.candidate.path ? (
                <span className="mt-1 block break-all font-mono text-ui-base text-foreground-subtlest">
                  {row.candidate.path}
                </span>
              ) : null}
              {optionSummary ? (
                <span className="mt-1 block text-ui-xs text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "settings.plugins.remoteSync.optionsSummary" },
                    {
                      manual: String(optionSummary.manualCount),
                      syncable: String(optionSummary.syncableCount),
                    },
                  )}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function RemotePluginSyncStatusBadge({ status }: { status: RemotePluginSyncProgressStatus }) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: `settings.plugins.remoteSync.${status}` });
  const icon =
    status === "synced" ? (
      <CheckCircle2 className="size-3" aria-hidden="true" />
    ) : status === "failed" ? (
      <CircleX className="size-3" aria-hidden="true" />
    ) : status === "stopped" ? (
      <CircleStop className="size-3" aria-hidden="true" />
    ) : null;
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-ui-xs font-medium",
        status === "synced" && "border-success/30 bg-success/10 text-success dark:bg-success/14",
        status === "failed" && "border-destructive/30 bg-destructive/10 text-destructive",
        status === "stopped" && "border-warning/30 bg-warning/10 text-warning",
        status === "skipped" && "border-border bg-secondary text-foreground-subtle",
        (status === "queued" || status === "syncing") &&
          "border-border bg-secondary text-foreground-subtle",
      )}
    >
      {icon}
      {label}
    </span>
  );
}

function RemotePluginSyncLogHoverCard({ logs }: { logs: readonly string[] }) {
  const { intl } = useZCodeIntl();
  const shownLogs = logs.length > 0 ? logs : ["Queued plugin sync"];

  return (
    <HoverCard closeDelay={160} openDelay={120}>
      <HoverCardTrigger asChild>
        <span
          aria-label={intl.formatMessage({ id: "settings.plugins.remoteSync.logTooltip" })}
          className="inline-flex size-6 cursor-help items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground"
          role="img"
        >
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        align="end"
        side="left"
        sideOffset={6}
        className="flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 bg-popover p-3 text-left"
      >
        <div className="text-ui-base font-medium text-popover-foreground">
          {intl.formatMessage({ id: "settings.plugins.remoteSync.logTooltip" })}
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary p-2 font-mono text-ui-xs/relaxed text-popover-foreground">
          {shownLogs.join("\n")}
        </pre>
      </HoverCardContent>
    </HoverCard>
  );
}

function RemotePluginSyncProgressList({
  progressById,
  rows,
  onStop,
}: {
  progressById: ReadonlyMap<string, RemotePluginSyncProgressView>;
  rows: readonly RemotePluginSyncRow[];
  onStop: (candidateId: string) => void;
}) {
  const { intl } = useZCodeIntl();

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.remoteSync.resultEmpty" })}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {rows.map((row) => {
        const progress = progressById.get(row.candidate.id) ?? {
          logs: ["Queued plugin sync"],
          status: "queued" as const,
        };
        const optionSummary = summarizeLocalPluginOptionsForDisplay(row.candidate.pluginOptions);
        const canStop = progress.status === "queued" || progress.status === "syncing";
        return (
          <div
            key={row.candidate.id}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base"
          >
            <span
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-foreground-subtle"
              aria-hidden="true"
            >
              <Cable className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="font-medium text-foreground">{row.candidate.name}</span>
                {row.candidate.version ? (
                  <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                    {row.candidate.version}
                  </span>
                ) : null}
                {row.candidate.componentTypes.map((type) => (
                  <span
                    key={type}
                    className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle"
                  >
                    {type}
                  </span>
                ))}
                <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                  {row.candidate.kind === "inline" ? "inline" : row.candidate.marketplace}
                </span>
              </div>
              {progress.result?.error ? (
                <div className="mt-1 break-words text-ui-base text-destructive">
                  {progress.result.error}
                </div>
              ) : row.candidate.path ? (
                <div className="mt-1 break-all font-mono text-ui-base text-foreground-subtlest">
                  {row.candidate.path}
                </div>
              ) : null}
              {optionSummary && !progress.result?.error ? (
                <div className="mt-1 text-ui-xs text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "settings.plugins.remoteSync.optionsSummary" },
                    {
                      manual: String(optionSummary.manualCount),
                      syncable: String(optionSummary.syncableCount),
                    },
                  )}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-start gap-1">
              {progress.status === "syncing" ? (
                <RemotePluginSyncLogHoverCard logs={progress.logs} />
              ) : null}
              <RemotePluginSyncStatusBadge status={progress.status} />
              {canStop ? (
                <ControlHintTooltip
                  title={intl.formatMessage({ id: "settings.plugins.remoteSync.stop" })}
                  side="left"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={intl.formatMessage({
                      id: "settings.plugins.remoteSync.stop",
                    })}
                    className="text-foreground-subtle hover:text-warning"
                    onClick={() => onStop(row.candidate.id)}
                  >
                    <CircleStop className="size-3.5" aria-hidden="true" />
                  </Button>
                </ControlHintTooltip>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RemotePluginSyncResultList({ result }: { result: RemotePluginSyncRunResult | null }) {
  const { intl } = useZCodeIntl();
  const items = result?.results ?? [];

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.remoteSync.resultEmpty" })}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="divide-y divide-border">
        {items.map((item) => (
          <div
            key={`${item.pluginId}-${item.directoryName}-${item.status}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="truncate text-ui-base font-medium text-foreground">{item.name}</div>
              {item.error ? (
                <div className="mt-0.5 break-words text-ui-base text-destructive">{item.error}</div>
              ) : item.path ? (
                <div className="mt-0.5 truncate font-mono text-ui-xs text-foreground-subtlest">
                  {item.path}
                </div>
              ) : null}
            </div>
            <RemotePluginSyncStatusBadge status={item.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function RemotePluginSyncDialog(props: RemotePluginSyncDialogProps) {
  const { intl } = useZCodeIntl();
  const {
    localPluginSyncService,
    localWorkspacePath,
    localZCodeAgentService,
    onOpenChange,
    onSynced,
    open,
    remotePluginSyncService,
    remoteZCodeAgentService,
    remoteTarget,
    workspacePath,
    workspaceIdentity,
  } = props;
  const [step, setStep] = useState<Step>("loading");
  const [rows, setRows] = useState<RemotePluginSyncRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showExistingRemotePlugins, setShowExistingRemotePlugins] = useState(true);
  const [importResult, setImportResult] = useState<RemotePluginSyncRunResult | null>(null);
  const [syncProgressById, setSyncProgressById] = useState<
    Map<string, RemotePluginSyncProgressView>
  >(new Map());
  const [syncRows, setSyncRows] = useState<RemotePluginSyncRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stopRequestedRef = useRef<Set<string>>(new Set());
  const stopWaitersRef = useRef<Map<string, () => void>>(new Map());
  const syncInFlightRef = useRef(false);
  const syncAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setStep("loading");
    setRows([]);
    setSelectedIds(new Set());
    setShowExistingRemotePlugins(true);
    setImportResult(null);
    setSyncProgressById(new Map());
    setSyncRows([]);
    setError(null);
    syncAbortControllerRef.current?.abort();
    syncAbortControllerRef.current = null;
    stopRequestedRef.current = new Set();
    stopWaitersRef.current = new Map();
    syncInFlightRef.current = false;

    void (async () => {
      try {
        const { candidates, statuses } = await loadRemotePluginSyncCandidates({
          localPluginSyncService,
          localWorkspacePath: localWorkspacePath ?? workspacePath,
          localZCodeAgentService,
          remotePluginSyncService,
          remoteWorkspaceIdentity: workspaceIdentity,
          remoteWorkspacePath: workspacePath,
          remoteZCodeAgentService,
        });
        if (cancelled) {
          return;
        }
        const nextRows = buildRemotePluginSyncRowsForCandidates(candidates, statuses);
        setRows(nextRows);
        setSelectedIds(resolveDefaultRemotePluginSyncSelection(nextRows));
        setStep("selection");
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStep("selection");
      }
    })();

    return () => {
      cancelled = true;
      // 远端目标失效会直接卸载 Dialog，绕过“同步中禁止关闭”的交互保护。
      // 主动终止当前 run，避免旧目标上的后续步骤和结果继续落回已失效的 UI。
      syncAbortControllerRef.current?.abort();
      syncAbortControllerRef.current = null;
    };
  }, [
    localPluginSyncService,
    localWorkspacePath,
    localZCodeAgentService,
    open,
    remotePluginSyncService,
    remoteZCodeAgentService,
    workspaceIdentity,
    workspacePath,
  ]);

  const visibleRows = useMemo(
    () => filterRemotePluginSyncRows(rows, showExistingRemotePlugins),
    [rows, showExistingRemotePlugins],
  );
  const visibleMissingIds = useMemo(
    () => visibleRows.filter((row) => !row.exists).map((row) => row.candidate.id),
    [visibleRows],
  );
  const selectedSyncIds = useMemo(
    () => visibleMissingIds.filter((id) => selectedIds.has(id)),
    [selectedIds, visibleMissingIds],
  );
  const selectedCount = selectedSyncIds.length;
  const targetLabel = formatRemoteSkillSyncTarget(remoteTarget, workspacePath);

  const handleOpenChange = (nextOpen: boolean) => {
    // plugin 同步是逐项远端 RPC；同步中关闭弹窗会让下次打开时重置为 loading/0 项，
    // 但后台 RPC 仍在跑。同步中只拦截关闭请求，避免丢失进度状态。
    if (!shouldAllowRemotePluginSyncDialogOpenChange(step, nextOpen)) {
      return;
    }
    onOpenChange(nextOpen);
  };

  const togglePlugin = (pluginId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(pluginId);
      } else {
        next.delete(pluginId);
      }
      return next;
    });
  };

  const stopPluginSync = (candidateId: string) => {
    stopRequestedRef.current.add(candidateId);
    stopWaitersRef.current.get(candidateId)?.();
    // 远端 marketplace install/add 会占用插件存储锁；只在远程同步生成的
    // operationId 上发送取消，避免误伤本地插件页的常规安装、启停和市场管理操作。
    setSyncProgressById((current) => {
      const next = new Map(current);
      const previous = next.get(candidateId) ?? { logs: [], status: "queued" as const };
      next.set(candidateId, {
        ...previous,
        logs: [
          ...previous.logs,
          "stop requested; cancelling the active remote plugin operation when possible",
        ],
        status: "stopped",
      });
      return next;
    });
  };

  const syncSelected = async () => {
    if (
      !shouldStartRemoteSyncOperation({
        inFlight: syncInFlightRef.current,
        selectedCount: selectedSyncIds.length,
      })
    ) {
      if (selectedSyncIds.length === 0) {
        setError(intl.formatMessage({ id: "settings.plugins.remoteSync.noSelection" }));
      }
      return;
    }

    syncInFlightRef.current = true;
    const syncAbortController = new AbortController();
    syncAbortControllerRef.current?.abort();
    syncAbortControllerRef.current = syncAbortController;
    const finishSyncRun = () => {
      if (!shouldFinishRemotePluginSyncRun(syncAbortControllerRef.current, syncAbortController)) {
        return;
      }
      syncAbortControllerRef.current = null;
      syncInFlightRef.current = false;
    };
    setError(null);
    setStep("preflighting");
    const selectedRows = rows.filter((row) => !row.exists && selectedIds.has(row.candidate.id));
    try {
      const access = await runRemoteSyncPreflightWithTimeout(() =>
        remotePluginSyncService.checkRemoteUserPluginWriteAccess(),
      );
      if (!access.ok) {
        throw new Error(
          intl.formatMessage(
            { id: "settings.remoteSync.preflightFailed" },
            { path: access.path, error: access.error ?? "" },
          ),
        );
      }
    } catch (syncError) {
      if (syncAbortController.signal.aborted) {
        finishSyncRun();
        return;
      }
      setError(
        isRemoteSyncPreflightTimeoutError(syncError)
          ? intl.formatMessage(
              { id: "settings.remoteSync.preflightTimeout" },
              { seconds: String(Math.ceil(syncError.timeoutMs / 1000)) },
            )
          : syncError instanceof Error
            ? syncError.message
            : String(syncError),
      );
      setStep("selection");
      finishSyncRun();
      return;
    }

    if (syncAbortController.signal.aborted) {
      finishSyncRun();
      return;
    }

    setStep("syncing");
    setSyncRows(selectedRows);
    setSyncProgressById(
      new Map(
        selectedRows.map((row) => [
          row.candidate.id,
          {
            logs: ["Queued plugin sync"],
            status: "queued" as const,
          },
        ]),
      ),
    );
    stopRequestedRef.current = new Set();
    stopWaitersRef.current = new Map();
    try {
      const result = await syncSelectedRemotePlugins({
        localPluginSyncService,
        onItemProgress: (event) => {
          if (syncAbortController.signal.aborted) {
            return;
          }
          setSyncProgressById((current) => {
            const next = new Map(current);
            const previous = next.get(event.candidateId) ?? {
              logs: [],
              status: "queued" as const,
            };
            next.set(event.candidateId, {
              logs: [...previous.logs, event.log],
              ...(event.result
                ? { result: event.result }
                : previous.result
                  ? { result: previous.result }
                  : {}),
              status: event.status,
            });
            return next;
          });
        },
        remotePluginSyncService,
        remoteWorkspaceIdentity: workspaceIdentity,
        remoteWorkspacePath: workspacePath,
        remoteZCodeAgentService,
        rows: selectedRows,
        signal: syncAbortController.signal,
        stopControl: {
          cancelOperation: async (operationId) => {
            if (!remoteZCodeAgentService?.cancelPluginOperation) {
              return;
            }
            await remoteZCodeAgentService.cancelPluginOperation({ operationId });
          },
          isStopped: (candidateId) => stopRequestedRef.current.has(candidateId),
          waitForStop: (candidateId) => {
            if (stopRequestedRef.current.has(candidateId)) {
              return Promise.resolve();
            }
            return new Promise<void>((resolve) => {
              stopWaitersRef.current.set(candidateId, resolve);
            });
          },
        },
      });
      if (syncAbortController.signal.aborted) {
        return;
      }
      await onSynced();
      if (syncAbortController.signal.aborted) {
        return;
      }
      setImportResult(result);
      setStep("complete");
    } catch (syncError) {
      if (syncAbortController.signal.aborted) {
        return;
      }
      setError(syncError instanceof Error ? syncError.message : String(syncError));
      setStep("selection");
    } finally {
      finishSyncRun();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={step !== "preflighting" && step !== "syncing"}
        className="h-[min(720px,calc(100dvh-2rem))] max-h-[min(720px,calc(100dvh-2rem))] max-w-2xl flex flex-col overflow-hidden"
      >
        <DialogHeader>
          <RemotePluginSyncTitle />
          <RemotePluginSyncTargetRow
            targetLabel={targetLabel}
            showExistingRemotePlugins={showExistingRemotePlugins}
            showExistingFilter={step === "selection" && rows.length > 0}
            onShowExistingRemotePluginsChange={setShowExistingRemotePlugins}
          />
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="mb-3 rounded-lg border border-destructive/40 bg-surface px-3 py-2 text-ui-base text-destructive">
              {error}
            </div>
          ) : null}
          {step === "loading" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.remoteSync.loading" })}
            </div>
          ) : null}
          {step === "preflighting" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.remoteSync.preflighting" })}
            </div>
          ) : null}
          {step === "selection" ? (
            <RemotePluginSyncSelectionList
              rows={visibleRows}
              selectedIds={selectedIds}
              emptyMessageId={
                rows.length > 0 ? "settings.plugins.remoteSync.filteredEmpty" : undefined
              }
              onToggle={togglePlugin}
            />
          ) : null}
          {step === "syncing" ? (
            <RemotePluginSyncProgressList
              progressById={syncProgressById}
              rows={syncRows}
              onStop={stopPluginSync}
            />
          ) : null}
          {step === "complete" ? <RemotePluginSyncResultList result={importResult} /> : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.plugins.remoteSync.selectionCount" },
              { selected: String(selectedCount), total: String(visibleMissingIds.length) },
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {step === "selection" ? (
              <RemotePluginSyncBulkSelectionCheckbox
                selectedCount={selectedCount}
                totalSelectable={visibleMissingIds.length}
                onSelectAll={() => setSelectedIds(new Set(visibleMissingIds))}
                onClearAll={() => setSelectedIds(new Set())}
              />
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={step !== "selection" || selectedCount === 0}
              onClick={syncSelected}
            >
              <UploadCloud className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.remoteSync.start" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

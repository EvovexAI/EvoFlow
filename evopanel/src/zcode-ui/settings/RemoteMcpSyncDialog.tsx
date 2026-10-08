/* eslint-disable max-lines -- 远端 MCP 同步弹窗集中维护加载、选择、结果和批量选择状态，拆分会增加跨状态传递复杂度。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircleIcon, Loader2, Server, UploadCloud } from "lucide-react";
import type {
  McpServerConfig,
  McpSyncCandidate,
  McpSyncExportResult,
  McpSyncImportResult,
  McpSyncRemoteStatus,
  RemoteTarget,
} from "@zcode/shared";
import type { IMcpSyncService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  isRemoteSyncPreflightTimeoutError,
  runRemoteSyncPreflightWithTimeout,
  shouldStartRemoteSyncOperation,
} from "@/settings/RemoteSyncActions.js";

type Step = "loading" | "selection" | "preflighting" | "syncing" | "complete";

interface RemoteMcpSyncRow {
  candidate: McpSyncCandidate;
  exists: boolean;
}

interface RemoteMcpSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  localMcpSyncService: IMcpSyncService;
  remoteMcpSyncService: IMcpSyncService;
  remoteTarget: RemoteTarget;
  workspacePath: string;
  localWorkspacePath?: string;
  onSynced: () => Promise<void> | void;
}

function buildRemoteMcpSyncRows(
  candidates: readonly McpSyncCandidate[],
  statuses: readonly McpSyncRemoteStatus[],
): RemoteMcpSyncRow[] {
  const statusByName = new Map(statuses.map((status) => [status.name, status]));
  return candidates.map((candidate) => ({
    candidate,
    exists: statusByName.get(candidate.name)?.exists ?? false,
  }));
}

function resolveDefaultRemoteMcpSyncSelection(rows: readonly RemoteMcpSyncRow[]): Set<string> {
  return new Set(rows.filter((row) => !row.exists).map((row) => row.candidate.id));
}

function filterRemoteMcpSyncRows(
  rows: readonly RemoteMcpSyncRow[],
  showExistingRemoteMcp: boolean,
): RemoteMcpSyncRow[] {
  return showExistingRemoteMcp ? [...rows] : rows.filter((row) => !row.exists);
}

function buildRemoteMcpSyncImportParams(params: {
  exported: McpSyncExportResult;
  localHomeDir: string;
  localWorkspacePath?: string;
  remoteWorkspacePath: string;
}): Parameters<IMcpSyncService["importMcpServers"]>[0] {
  return {
    servers: params.exported.servers,
    localHomeDir: params.exported.localHomeDir || params.localHomeDir,
    localWorkspacePath: params.localWorkspacePath,
    remoteWorkspacePath: params.remoteWorkspacePath,
    overwrite: false,
  };
}

function resolveMcpTypeLabel(config: McpServerConfig): string {
  if (typeof config.type === "string" && config.type.trim()) {
    return config.type.trim();
  }
  if (typeof config.command === "string" && config.command.trim()) {
    return "stdio";
  }
  if (typeof config.url === "string" && config.url.trim()) {
    return "http";
  }
  return "unknown";
}

function RemoteMcpSyncTitle() {
  const { intl } = useZCodeIntl();
  const [warningTooltipOpen, setWarningTooltipOpen] = useState(false);
  const warningTitle = intl.formatMessage({
    id: "settings.mcp.remoteSync.warningTitle",
  });

  return (
    <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: "settings.mcp.remoteSync.title" })}
      </span>
      <ControlHintTooltip
        open={warningTooltipOpen}
        title={warningTitle}
        description={intl.formatMessage({
          id: "settings.mcp.remoteSync.warningDescription",
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

function RemoteMcpSyncExistingFilterCheckbox({
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
      <span>{intl.formatMessage({ id: "settings.mcp.remoteSync.showExisting" })}</span>
    </label>
  );
}

function RemoteMcpSyncTargetRow({
  targetLabel,
  showExistingRemoteMcp,
  showExistingFilter,
  onShowExistingRemoteMcpChange,
}: {
  targetLabel: string;
  showExistingRemoteMcp: boolean;
  showExistingFilter: boolean;
  onShowExistingRemoteMcpChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="min-w-0 break-words font-mono text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.mcp.remoteSync.target" }, { target: targetLabel })}
      </p>
      {showExistingFilter ? (
        <div className="shrink-0">
          <RemoteMcpSyncExistingFilterCheckbox
            checked={showExistingRemoteMcp}
            onCheckedChange={onShowExistingRemoteMcpChange}
          />
        </div>
      ) : null}
    </div>
  );
}

function RemoteMcpSyncBulkSelectionCheckbox({
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
      <span>{intl.formatMessage({ id: "settings.mcp.remoteSync.selectAll" })}</span>
    </label>
  );
}

function RemoteMcpSyncSelectionList({
  rows,
  selectedIds,
  emptyMessageId = "settings.mcp.remoteSync.empty",
  onToggle,
}: {
  rows: readonly RemoteMcpSyncRow[];
  selectedIds: ReadonlySet<string>;
  emptyMessageId?: string;
  onToggle: (id: string, checked: boolean) => void;
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
        const checkboxId = `remote-mcp-sync-${row.candidate.id}`;
        const labelId = `${checkboxId}-label`;
        const typeLabel = resolveMcpTypeLabel(row.candidate.config);
        const selected = !row.exists && selectedIds.has(row.candidate.id);
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
              <Server className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <span id={labelId} className="font-medium text-foreground">
                  {row.candidate.name}
                </span>
                <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                  {typeLabel}
                </span>
                <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                  {row.candidate.source}
                </span>
                {row.exists ? (
                  <span className="text-ui-base text-foreground-subtlest">
                    {intl.formatMessage({ id: "settings.mcp.remoteSync.existing" })}
                  </span>
                ) : null}
              </span>
              <span className="mt-1 block break-all font-mono text-ui-base text-foreground-subtlest">
                {row.candidate.path}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function RemoteMcpSyncResultList({ result }: { result: McpSyncImportResult | null }) {
  const { intl } = useZCodeIntl();
  const items = result?.results ?? [];

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.mcp.remoteSync.resultEmpty" })}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="divide-y divide-border">
        {items.map((item) => (
          <div
            key={`${item.name}-${item.status}`}
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
            <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle ring-1 ring-border">
              {intl.formatMessage({ id: `settings.mcp.remoteSync.${item.status}` })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RemoteMcpSyncDialog(props: RemoteMcpSyncDialogProps) {
  const { intl } = useZCodeIntl();
  const {
    localMcpSyncService,
    localWorkspacePath,
    onOpenChange,
    onSynced,
    open,
    remoteMcpSyncService,
    remoteTarget,
    workspacePath,
  } = props;
  const [step, setStep] = useState<Step>("loading");
  const [rows, setRows] = useState<RemoteMcpSyncRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showExistingRemoteMcp, setShowExistingRemoteMcp] = useState(true);
  const [importResult, setImportResult] = useState<McpSyncImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localHomeDir, setLocalHomeDir] = useState("");
  const syncInFlightRef = useRef(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setStep("loading");
    setRows([]);
    setSelectedIds(new Set());
    setShowExistingRemoteMcp(true);
    setImportResult(null);
    setError(null);
    setLocalHomeDir("");
    syncInFlightRef.current = false;

    void (async () => {
      try {
        const localResult = await localMcpSyncService.listLocalUserMcpCandidates();
        const remoteResult = await remoteMcpSyncService.listRemoteUserMcpStatuses({
          names: localResult.candidates.map((candidate) => candidate.name),
        });
        if (cancelled) {
          return;
        }
        const nextRows = buildRemoteMcpSyncRows(localResult.candidates, remoteResult.statuses);
        setLocalHomeDir(localResult.localHomeDir);
        setRows(nextRows);
        setSelectedIds(resolveDefaultRemoteMcpSyncSelection(nextRows));
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
    };
  }, [localMcpSyncService, open, remoteMcpSyncService]);

  const visibleRows = useMemo(
    () => filterRemoteMcpSyncRows(rows, showExistingRemoteMcp),
    [rows, showExistingRemoteMcp],
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
    if (!nextOpen && (step === "preflighting" || step === "syncing")) {
      return;
    }
    onOpenChange(nextOpen);
  };

  const toggleMcp = (serverId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(serverId);
      } else {
        next.delete(serverId);
      }
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
        setError(intl.formatMessage({ id: "settings.mcp.remoteSync.noSelection" }));
      }
      return;
    }

    syncInFlightRef.current = true;
    setError(null);
    setStep("preflighting");
    try {
      const access = await runRemoteSyncPreflightWithTimeout(() =>
        remoteMcpSyncService.checkRemoteUserMcpWriteAccess(),
      );
      if (!access.ok) {
        throw new Error(
          intl.formatMessage(
            { id: "settings.remoteSync.preflightFailed" },
            { path: access.path, error: access.error ?? "" },
          ),
        );
      }
      setStep("syncing");
      const exported = await localMcpSyncService.exportMcpServers({
        serverIds: selectedSyncIds,
      });
      const result = await remoteMcpSyncService.importMcpServers(
        buildRemoteMcpSyncImportParams({
          exported,
          localHomeDir,
          localWorkspacePath,
          remoteWorkspacePath: workspacePath,
        }),
      );
      await onSynced();
      setImportResult(result);
      setStep("complete");
    } catch (syncError) {
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
    } finally {
      syncInFlightRef.current = false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="h-[min(720px,calc(100dvh-2rem))] max-h-[min(720px,calc(100dvh-2rem))] max-w-2xl flex flex-col overflow-hidden">
        <DialogHeader>
          <RemoteMcpSyncTitle />
          <RemoteMcpSyncTargetRow
            targetLabel={targetLabel}
            showExistingRemoteMcp={showExistingRemoteMcp}
            showExistingFilter={step === "selection" && rows.length > 0}
            onShowExistingRemoteMcpChange={setShowExistingRemoteMcp}
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
              {intl.formatMessage({ id: "settings.mcp.remoteSync.loading" })}
            </div>
          ) : null}
          {step === "preflighting" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.remoteSync.preflighting" })}
            </div>
          ) : null}
          {step === "selection" ? (
            <RemoteMcpSyncSelectionList
              rows={visibleRows}
              selectedIds={selectedIds}
              emptyMessageId={rows.length > 0 ? "settings.mcp.remoteSync.filteredEmpty" : undefined}
              onToggle={toggleMcp}
            />
          ) : null}
          {step === "syncing" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.mcp.remoteSync.syncing" })}
            </div>
          ) : null}
          {step === "complete" ? <RemoteMcpSyncResultList result={importResult} /> : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.mcp.remoteSync.selectionCount" },
              { selected: String(selectedCount), total: String(visibleMissingIds.length) },
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {step === "selection" ? (
              <RemoteMcpSyncBulkSelectionCheckbox
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
              {intl.formatMessage({ id: "settings.mcp.remoteSync.start" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

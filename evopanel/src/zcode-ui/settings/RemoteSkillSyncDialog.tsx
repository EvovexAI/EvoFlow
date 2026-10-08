/* eslint-disable max-lines -- 远端 Skill 同步弹窗集中维护加载、选择、预检和结果状态，拆分会增加跨状态传递复杂度。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, UploadCloud } from "lucide-react";
import {
  normalizeUnknownError,
  SKILL_SYNC_SIZE_LIMIT_ERROR_CODE,
  type RemoteTarget,
  type SkillSyncCandidate,
  type SkillSyncImportResult,
  type SkillSyncRemoteStatus,
  type SkillSyncSizeLimitErrorData,
} from "@zcode/shared";
import type { ISkillSyncService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";
import {
  RemoteSkillSyncSelectionList,
  type RemoteSkillSyncRow,
} from "@/settings/RemoteSkillSyncSelectionList.js";
import { RemoteSkillSyncResultList } from "@/settings/RemoteSkillSyncResultList.js";
import { RemoteSkillSyncTitle } from "@/settings/RemoteSkillSyncTitle.js";
import {
  isRemoteSyncPreflightTimeoutError,
  runRemoteSyncPreflightWithTimeout,
  shouldStartRemoteSyncOperation,
} from "@/settings/RemoteSyncActions.js";

export {
  RemoteSkillSyncSelectionList,
  shouldToggleRemoteSkillSyncCardSelection,
} from "@/settings/RemoteSkillSyncSelectionList.js";
export type { RemoteSkillSyncRow } from "@/settings/RemoteSkillSyncSelectionList.js";

type Step = "loading" | "selection" | "preflighting" | "syncing" | "complete";

interface RemoteSkillSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  localSkillSyncService: ISkillSyncService;
  remoteSkillSyncService: ISkillSyncService;
  remoteTarget: RemoteTarget;
  workspacePath: string;
  workspaceIdentity?: string;
  onSynced: () => Promise<void> | void;
}

function buildRemoteSkillSyncRows(
  candidates: readonly SkillSyncCandidate[],
  statuses: readonly SkillSyncRemoteStatus[],
): RemoteSkillSyncRow[] {
  const statusByDirectory = new Map(statuses.map((status) => [status.directoryName, status]));
  return candidates.map((candidate) => ({
    candidate,
    exists: statusByDirectory.get(candidate.directoryName)?.exists ?? false,
  }));
}

function resolveDefaultRemoteSkillSyncSelection(rows: readonly RemoteSkillSyncRow[]): Set<string> {
  return new Set(rows.filter((row) => !row.exists).map((row) => row.candidate.id));
}

function filterRemoteSkillSyncRows(
  rows: readonly RemoteSkillSyncRow[],
  showExistingRemoteSkills: boolean,
): RemoteSkillSyncRow[] {
  return showExistingRemoteSkills ? [...rows] : rows.filter((row) => !row.exists);
}

export function formatRemoteSkillSyncTarget(
  remoteTarget: RemoteTarget,
  workspacePath: string,
): string {
  const target =
    remoteTarget.kind === "ssh"
      ? `${remoteTarget.username}@${remoteTarget.host}${remoteTarget.port ? `:${remoteTarget.port}` : ""}`
      : remoteTarget.kind === "wsl"
        ? ["WSL", remoteTarget.distro, remoteTarget.user?.trim()].filter(Boolean).join(" · ")
        : remoteTarget.kind;
  return workspacePath ? `${target} · ${workspacePath}` : target;
}

function formatRemoteSkillSyncError(
  error: unknown,
  intl: Pick<IntlInstance, "formatMessage">,
): string {
  // RPC 原始错误中的字节数和阶段信息不能直接作为用户文案；
  // 这里只识别稳定错误码，按阶段和当前语言生成可操作提示，其他错误保留原始信息。
  const normalizedError = normalizeUnknownError(error);
  if (normalizedError.code !== SKILL_SYNC_SIZE_LIMIT_ERROR_CODE) {
    return normalizedError.message;
  }

  const data = readSkillSyncSizeLimitErrorData(error);
  if (!data) {
    return normalizedError.message;
  }

  const messageId = {
    "selected-content": "settings.skills.remoteSync.sizeLimit.selectedContent",
    archive: "settings.skills.remoteSync.sizeLimit.archive",
    "extracted-content": "settings.skills.remoteSync.sizeLimit.extractedContent",
  }[data.phase];
  return intl.formatMessage(
    { id: messageId },
    {
      actualSize: formatSkillSyncBytes(data.actualBytes),
      maxSize: formatSkillSyncBytes(data.maxBytes),
    },
  );
}

function readSkillSyncSizeLimitErrorData(error: unknown): SkillSyncSizeLimitErrorData | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return null;
  }
  const candidate = data as Partial<SkillSyncSizeLimitErrorData>;
  if (
    typeof candidate.actualBytes !== "number" ||
    typeof candidate.maxBytes !== "number" ||
    (candidate.phase !== "selected-content" &&
      candidate.phase !== "archive" &&
      candidate.phase !== "extracted-content")
  ) {
    return null;
  }
  return candidate as SkillSyncSizeLimitErrorData;
}

function formatSkillSyncBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return `${Number.isInteger(mebibytes) ? mebibytes : mebibytes.toFixed(1)} MiB`;
}

function getRemoteSkillSyncBulkSelectionState({
  selectedCount,
  totalSelectable,
}: {
  selectedCount: number;
  totalSelectable: number;
}) {
  const disabled = totalSelectable === 0;
  const checked = totalSelectable > 0 && selectedCount >= totalSelectable;
  const indeterminate = totalSelectable > 0 && selectedCount > 0 && selectedCount < totalSelectable;
  return { checked, disabled, indeterminate };
}

function RemoteSkillSyncExistingFilterCheckbox({
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
      <span>{intl.formatMessage({ id: "settings.skills.remoteSync.showExisting" })}</span>
    </label>
  );
}

function RemoteSkillSyncTargetRow({
  targetLabel,
  showExistingRemoteSkills,
  showExistingFilter,
  onShowExistingRemoteSkillsChange,
}: {
  targetLabel: string;
  showExistingRemoteSkills: boolean;
  showExistingFilter: boolean;
  onShowExistingRemoteSkillsChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="min-w-0 break-words font-mono text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.skills.remoteSync.target" }, { target: targetLabel })}
      </p>
      {showExistingFilter ? (
        <div className="shrink-0">
          <RemoteSkillSyncExistingFilterCheckbox
            checked={showExistingRemoteSkills}
            onCheckedChange={onShowExistingRemoteSkillsChange}
          />
        </div>
      ) : null}
    </div>
  );
}

function RemoteSkillSyncBulkSelectionCheckbox({
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
  const selectionState = getRemoteSkillSyncBulkSelectionState({
    selectedCount,
    totalSelectable,
  });

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = selectionState.indeterminate;
    }
  }, [selectionState.indeterminate]);

  return (
    <label
      className={`inline-flex h-6 items-center gap-2 rounded-md px-1 text-ui-base text-foreground-subtle ${
        selectionState.disabled ? "opacity-50" : "cursor-pointer hover:text-foreground"
      }`}
    >
      <input
        ref={inputRef}
        type="checkbox"
        className="size-4"
        checked={selectionState.checked}
        disabled={selectionState.disabled}
        aria-checked={
          selectionState.indeterminate ? "mixed" : selectionState.checked ? "true" : "false"
        }
        onChange={(event) => {
          if (event.currentTarget.checked) {
            onSelectAll();
          } else {
            onClearAll();
          }
        }}
      />
      <span>{intl.formatMessage({ id: "settings.skills.remoteSync.selectAll" })}</span>
    </label>
  );
}

export function RemoteSkillSyncDialog(props: RemoteSkillSyncDialogProps) {
  const { intl } = useZCodeIntl();
  const {
    open,
    onOpenChange,
    localSkillSyncService,
    remoteSkillSyncService,
    remoteTarget,
    workspacePath,
    onSynced,
  } = props;
  const [step, setStep] = useState<Step>("loading");
  const [rows, setRows] = useState<RemoteSkillSyncRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showExistingRemoteSkills, setShowExistingRemoteSkills] = useState(true);
  const [importResult, setImportResult] = useState<SkillSyncImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const syncInFlightRef = useRef(false);
  // 加载请求可能跨越语言切换，effect 闭包中的 intl 会过期；错误提示必须读取最近一次渲染的实例。
  const latestIntlRef = useRef(intl);
  latestIntlRef.current = intl;

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setStep("loading");
    setRows([]);
    setSelectedIds(new Set());
    setShowExistingRemoteSkills(true);
    setImportResult(null);
    setError(null);
    syncInFlightRef.current = false;

    void (async () => {
      try {
        const localResult = await localSkillSyncService.listLocalUserSkillCandidates();
        const remoteResult = await remoteSkillSyncService.listRemoteUserSkillStatuses({
          directoryNames: localResult.candidates.map((candidate) => candidate.directoryName),
          skills: localResult.candidates.map((candidate) => ({
            directoryName: candidate.directoryName,
            name: candidate.name,
          })),
        });
        if (cancelled) {
          return;
        }
        const nextRows = buildRemoteSkillSyncRows(localResult.candidates, remoteResult.statuses);
        setRows(nextRows);
        setSelectedIds(resolveDefaultRemoteSkillSyncSelection(nextRows));
        setStep("selection");
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setError(formatRemoteSkillSyncError(loadError, latestIntlRef.current));
        setStep("selection");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [localSkillSyncService, open, remoteSkillSyncService]);

  const visibleRows = useMemo(
    () => filterRemoteSkillSyncRows(rows, showExistingRemoteSkills),
    [rows, showExistingRemoteSkills],
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

  const toggleSkill = (skillId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(skillId);
      } else {
        next.delete(skillId);
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
        setError(intl.formatMessage({ id: "settings.skills.remoteSync.noSelection" }));
      }
      return;
    }

    syncInFlightRef.current = true;
    setError(null);
    setStep("preflighting");
    try {
      const access = await runRemoteSyncPreflightWithTimeout(() =>
        remoteSkillSyncService.checkRemoteUserSkillWriteAccess(),
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
      const archive = await localSkillSyncService.exportSkillsArchive({
        skillIds: selectedSyncIds,
      });
      const result = await remoteSkillSyncService.importSkillsArchive({
        archive: archive.archive,
        overwrite: false,
      });
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
          : formatRemoteSkillSyncError(syncError, intl),
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
          <RemoteSkillSyncTitle />
          <RemoteSkillSyncTargetRow
            targetLabel={targetLabel}
            showExistingRemoteSkills={showExistingRemoteSkills}
            showExistingFilter={step === "selection" && rows.length > 0}
            onShowExistingRemoteSkillsChange={setShowExistingRemoteSkills}
          />
        </DialogHeader>

        {/* 筛选会改变可见 rows 数量，DialogContent 固定高度后由列表区内部滚动；
            否则空态按内容收缩会造成弹窗跳动，长列表也会把底部操作栏挤出窗口。 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="mb-3 rounded-lg border border-destructive/40 bg-surface px-3 py-2 text-ui-base text-destructive">
              {error}
            </div>
          ) : null}
          {step === "loading" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.skills.remoteSync.loading" })}
            </div>
          ) : null}
          {step === "preflighting" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.remoteSync.preflighting" })}
            </div>
          ) : null}
          {step === "selection" ? (
            <RemoteSkillSyncSelectionList
              rows={visibleRows}
              selectedIds={selectedIds}
              emptyMessageId={
                rows.length > 0 ? "settings.skills.remoteSync.filteredEmpty" : undefined
              }
              onToggle={toggleSkill}
            />
          ) : null}
          {step === "syncing" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.skills.remoteSync.syncing" })}
            </div>
          ) : null}
          {step === "complete" ? <RemoteSkillSyncResultList result={importResult} /> : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.skills.remoteSync.selectionCount" },
              { selected: String(selectedCount), total: String(visibleMissingIds.length) },
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {step === "selection" ? (
              <RemoteSkillSyncBulkSelectionCheckbox
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
              {intl.formatMessage({ id: "settings.skills.remoteSync.start" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

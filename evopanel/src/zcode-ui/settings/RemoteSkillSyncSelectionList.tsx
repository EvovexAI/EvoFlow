import { useState, type MouseEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SkillSyncCandidate } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface RemoteSkillSyncRow {
  candidate: SkillSyncCandidate;
  exists: boolean;
}

const REMOTE_SKILL_SYNC_CARD_ACTION_SELECTOR =
  "button,input,a,textarea,select,label,[data-remote-skill-sync-card-action]";

export function shouldToggleRemoteSkillSyncCardSelection({
  exists,
  target,
}: {
  exists: boolean;
  target: EventTarget | null;
}): boolean {
  if (exists) {
    return false;
  }
  const closest = (target as { closest?: unknown } | null)?.closest;
  return (
    typeof closest !== "function" || !closest.call(target, REMOTE_SKILL_SYNC_CARD_ACTION_SELECTOR)
  );
}

export function RemoteSkillSyncSelectionList({
  rows,
  selectedIds,
  emptyMessageId = "settings.skills.remoteSync.empty",
  onToggle,
}: {
  rows: readonly RemoteSkillSyncRow[];
  selectedIds: ReadonlySet<string>;
  emptyMessageId?: string;
  onToggle: (skillId: string, checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const [expandedDescriptionIds, setExpandedDescriptionIds] = useState<Set<string>>(new Set());

  const toggleDescription = (skillId: string) => {
    setExpandedDescriptionIds((current) => {
      const next = new Set(current);
      if (next.has(skillId)) {
        next.delete(skillId);
      } else {
        next.add(skillId);
      }
      return next;
    });
  };

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
        const checkboxId = `remote-skill-sync-${row.candidate.id}`;
        const labelId = `${checkboxId}-label`;
        const descriptionExpanded = expandedDescriptionIds.has(row.candidate.id);
        const selected = !row.exists && selectedIds.has(row.candidate.id);
        const handleCardClick = (event: MouseEvent<HTMLDivElement>) => {
          if (
            !shouldToggleRemoteSkillSyncCardSelection({
              exists: row.exists,
              target: event.target,
            })
          ) {
            return;
          }
          onToggle(row.candidate.id, !selected);
        };

        return (
          <div
            key={row.candidate.id}
            className={`grid grid-cols-[auto_1fr] gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base ${
              row.exists
                ? "cursor-default"
                : "cursor-pointer hover:border-border-hover hover:bg-surface-hover"
            }`}
            onClick={handleCardClick}
          >
            <input
              id={checkboxId}
              type="checkbox"
              aria-labelledby={labelId}
              className="mt-1 size-4"
              disabled={row.exists}
              checked={selected}
              onChange={(event) => onToggle(row.candidate.id, event.currentTarget.checked)}
            />
            <span className="min-w-0">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <label id={labelId} htmlFor={checkboxId} className="font-medium text-foreground">
                  {row.candidate.name}
                </label>
                {row.candidate.description ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-5 rounded-sm text-foreground-subtle hover:text-foreground"
                    aria-expanded={descriptionExpanded}
                    aria-label={intl.formatMessage({
                      id: descriptionExpanded
                        ? "settings.skills.remoteSync.collapseDescription"
                        : "settings.skills.remoteSync.expandDescription",
                    })}
                    data-remote-skill-sync-card-action="description-toggle"
                    onClick={() => toggleDescription(row.candidate.id)}
                  >
                    {descriptionExpanded ? (
                      <ChevronDown className="size-3.5" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="size-3.5" aria-hidden="true" />
                    )}
                  </Button>
                ) : null}
                {row.exists ? (
                  <span className="text-ui-base text-foreground-subtlest">
                    {intl.formatMessage({ id: "settings.skills.remoteSync.existing" })}
                  </span>
                ) : null}
              </span>
              {row.candidate.description ? (
                <span className="mt-1 block min-w-0">
                  {/* Tailwind v4 下 block 会覆盖 line-clamp 所需的 display:-webkit-box；
                      折叠态不能同时带 block，否则描述仍会按普通文本换行展示。 */}
                  <span
                    className={`text-ui-base text-foreground-subtle ${
                      descriptionExpanded ? "block whitespace-pre-wrap" : "line-clamp-1"
                    }`}
                  >
                    {row.candidate.description}
                  </span>
                </span>
              ) : null}
              <span className="mt-1 block break-all font-mono text-ui-base text-foreground-subtlest">
                {row.candidate.directoryName}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

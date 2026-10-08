import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCommitTime, getRefIcon, getShortHash } from "./GitGraphDisplay.js";
import type { GitGraphCommit } from "./layout.js";

interface GitGraphCommitDetailProps {
  commit: GitGraphCommit;
}

export function GitGraphCommitDetail({ commit }: GitGraphCommitDetailProps) {
  const { intl, locale } = useZCodeIntl();

  return (
    <div className="border-t border-border bg-surface/45 px-3 py-3">
      <div className="grid gap-3 text-ui-base text-foreground-subtle md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="mb-1 text-ui-base font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "gitGraph.detail.subject" })}
          </div>
          <div className="break-words text-ui-base text-foreground">
            {commit.subject || getShortHash(commit.hash)}
          </div>
          {commit.refs.length > 0 ? (
            <div className="mt-2 flex min-w-0 flex-wrap gap-1">
              {commit.refs.map((ref) => (
                <span
                  key={`${commit.hash}:${ref.name}`}
                  className={cn(
                    "inline-flex h-5 min-w-0 items-center gap-1 rounded-md border border-border bg-surface px-1.5 text-ui-base text-foreground-subtle",
                    ref.kind === "head" && "border-git-descendant bg-selected text-foreground",
                    ref.kind === "tag" && "border-git-added",
                  )}
                >
                  {getRefIcon(ref, "size-2.5")}
                  <span className="max-w-48 truncate">{ref.name}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2">
          <div className="min-w-0">
            <div className="text-foreground-subtlest">
              {intl.formatMessage({ id: "gitGraph.detail.commit" })}
            </div>
            <div className="truncate font-mono text-foreground">{commit.hash}</div>
          </div>
          <div className="min-w-0">
            <div className="text-foreground-subtlest">
              {intl.formatMessage({ id: "gitGraph.detail.author" })}
            </div>
            <div className="truncate text-foreground">{commit.authorName || "-"}</div>
          </div>
          <div className="min-w-0">
            <div className="text-foreground-subtlest">
              {intl.formatMessage({ id: "gitGraph.detail.date" })}
            </div>
            <div className="truncate text-foreground">
              {formatCommitTime(commit.authoredAtMs, locale) || "-"}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-foreground-subtlest">
              {intl.formatMessage({ id: "gitGraph.detail.parents" })}
            </div>
            <div className="truncate font-mono text-foreground">
              {commit.parents.length > 0 ? commit.parents.map(getShortHash).join(", ") : "-"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

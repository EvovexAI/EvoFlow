import { GitBranchIcon, TagIcon } from "lucide-react";
import type { GitGraphRef } from "./layout.js";

export function getShortHash(hash: string): string {
  return hash.slice(0, 7);
}

export function getRefIcon(ref: GitGraphRef, className = "size-3") {
  if (ref.kind === "tag") {
    return <TagIcon className={className} />;
  }

  return <GitBranchIcon className={className} />;
}

export function formatCommitTime(timestampMs: number | null, locale: string): string {
  if (!timestampMs) {
    return "";
  }

  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestampMs));
}

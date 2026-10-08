import type { ReactNode } from "react";

interface TextMatchRange {
  start: number;
  end: number;
}

function getQueryParts(query: string): string[] {
  const seen = new Set<string>();
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .filter((part) => {
      if (seen.has(part)) {
        return false;
      }
      seen.add(part);
      return true;
    });
}

function mergeRanges(ranges: TextMatchRange[]): TextMatchRange[] {
  const sortedRanges = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const mergedRanges: TextMatchRange[] = [];

  for (const range of sortedRanges) {
    const lastRange = mergedRanges.at(-1);
    if (!lastRange || range.start > lastRange.end) {
      mergedRanges.push({ ...range });
      continue;
    }

    lastRange.end = Math.max(lastRange.end, range.end);
  }

  return mergedRanges;
}

function findTextMatchRanges(text: string, query: string): TextMatchRange[] {
  const parts = getQueryParts(query);
  if (parts.length === 0 || text.length === 0) {
    return [];
  }

  const normalizedText = text.toLocaleLowerCase();
  const ranges: TextMatchRange[] = [];

  for (const part of parts) {
    let searchIndex = 0;
    while (searchIndex < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(part, searchIndex);
      if (matchIndex === -1) {
        break;
      }

      ranges.push({
        start: matchIndex,
        end: matchIndex + part.length,
      });
      searchIndex = matchIndex + part.length;
    }
  }

  return mergeRanges(ranges);
}

export function HighlightedMatchText({ text, query }: { text: string; query: string }) {
  const ranges = findTextMatchRanges(text, query);
  if (ranges.length === 0) {
    return <>{text}</>;
  }

  const parts: ReactNode[] = [];
  let cursor = 0;

  ranges.forEach((range, index) => {
    if (cursor < range.start) {
      parts.push(<span key={`plain-${index}`}>{text.slice(cursor, range.start)}</span>);
    }

    parts.push(
      <mark key={`match-${index}`} className="rounded-sm bg-accent font-semibold text-foreground">
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });

  if (cursor < text.length) {
    parts.push(<span key="plain-end">{text.slice(cursor)}</span>);
  }

  return <>{parts}</>;
}

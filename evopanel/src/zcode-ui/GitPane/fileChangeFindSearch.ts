interface FileChangeFindTarget {
  path: string;
  content: string | null | undefined;
}

interface FileChangeFindMatch {
  path: string;
  globalIndex: number;
  matchIndexInFile: number;
}

interface FileChangeFindState {
  matches: FileChangeFindMatch[];
  activeMatch: FileChangeFindMatch | null;
  currentIndex: number;
  total: number;
}

function normalizeFileChangeFindQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function countMatches(text: string, normalizedQuery: string): number {
  if (!normalizedQuery) {
    return 0;
  }

  const normalizedText = text.toLocaleLowerCase();
  let count = 0;
  let searchStart = 0;

  while (searchStart < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, searchStart);
    if (matchIndex === -1) {
      break;
    }

    count += 1;
    searchStart = matchIndex + normalizedQuery.length;
  }

  return count;
}

export function getFileChangeFindState(
  targets: readonly FileChangeFindTarget[],
  query: string,
  preferredIndex: number,
): FileChangeFindState {
  const normalizedQuery = normalizeFileChangeFindQuery(query);
  const matches: FileChangeFindMatch[] = [];

  if (normalizedQuery) {
    for (const target of targets) {
      if (!target.content) {
        continue;
      }

      const matchCount = countMatches(target.content, normalizedQuery);
      for (let matchIndexInFile = 0; matchIndexInFile < matchCount; matchIndexInFile += 1) {
        matches.push({
          path: target.path,
          globalIndex: matches.length,
          matchIndexInFile,
        });
      }
    }
  }

  const currentIndex =
    matches.length === 0
      ? -1
      : preferredIndex >= 0 && preferredIndex < matches.length
        ? preferredIndex
        : 0;

  return {
    matches,
    activeMatch: currentIndex >= 0 ? (matches[currentIndex] ?? null) : null,
    currentIndex,
    total: matches.length,
  };
}

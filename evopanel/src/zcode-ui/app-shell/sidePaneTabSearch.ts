interface SearchFields {
  title: string;
  hint: string;
  typeLabel: string;
  all: string;
}

export function buildSearchFields(title: string, hint: string, typeLabel: string): SearchFields {
  return {
    title: normalizeSearchText(title),
    hint: normalizeSearchText(hint),
    typeLabel: normalizeSearchText(typeLabel),
    all: normalizeSearchText(`${title} ${hint} ${typeLabel}`),
  };
}

export function normalizeSearchQuery(query: string): string[] {
  return normalizeSearchText(query).split(/\s+/).filter(Boolean);
}

export function filterAndRankSearchItems<T extends { searchFields: SearchFields }>(
  items: T[],
  queryParts: string[],
): T[] {
  if (queryParts.length === 0) {
    return items;
  }

  return items
    .map((item, index) => ({
      item,
      index,
      score: getSearchScore(item.searchFields, queryParts),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item);
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function getSearchScore(fields: SearchFields, queryParts: string[]): number {
  if (!queryParts.every((part) => fields.all.includes(part))) {
    return 0;
  }

  return queryParts.reduce((score, part) => {
    if (fields.title.startsWith(part)) {
      return score + 120;
    }
    if (hasWordPrefix(fields.title, part)) {
      return score + 90;
    }
    if (fields.title.includes(part)) {
      return score + 70;
    }
    if (fields.hint.includes(part)) {
      return score + 40;
    }
    if (fields.typeLabel.includes(part)) {
      return score + 20;
    }
    return score + 1;
  }, 0);
}

function hasWordPrefix(value: string, part: string): boolean {
  return value.split(/[\s/_.:-]+/).some((word) => word.startsWith(part));
}

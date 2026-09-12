export const numberCompact = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${value}`;
};

export const money = (value: number) => `$${value.toFixed(2)}`;

export const cls = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ');

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readOpenTarget(input: unknown): string | null {
  const url = readText(asRecord(asRecord(input)?.app), "url");
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const leaf = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "");
    return leaf.trim() || null;
  } catch {
    return null;
  }
}

const MAC_KEY_SYMBOLS: Record<string, string> = {
  cmd: "⌘",
  command: "⌘",
  meta: "⌘",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
  ctrl: "⌃",
  control: "⌃",
};

function formatShortcut(value: string): string {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return value;
  return parts.map((part) => MAC_KEY_SYMBOLS[part.toLowerCase()] ?? part.toUpperCase()).join("");
}

export function readCuaActionDetail(toolName: string | null, input: unknown): string | null {
  const record = asRecord(input);
  if (toolName === "open_application") return readOpenTarget(input);
  if (toolName === "key" || toolName === "hold_key") {
    const shortcut = readText(record, "key") ?? readText(record, "text");
    return shortcut ? formatShortcut(shortcut) : null;
  }
  return null;
}

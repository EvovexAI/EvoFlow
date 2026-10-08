import { AppWindow } from "lucide-react";
import { useEffect, useState } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

interface CuaAppItem {
  name: string;
  bundleId: string | null;
  active: boolean;
}

interface CuaWindowItem {
  title: string | null;
  width: number | null;
  height: number | null;
  main: boolean;
  focused: boolean;
}

export type CuaDetailList =
  | { kind: "apps"; items: CuaAppItem[] }
  | { kind: "windows"; items: CuaWindowItem[] };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseCuaResultList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  const candidate = value.split("\n\nStructured content:", 1)[0]?.trim();
  if (!candidate?.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseStructuredCuaResultList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      return parseStructuredCuaResultList(JSON.parse(value));
    } catch {
      return null;
    }
  }
  const result = asRecord(value)?.result;
  return result === undefined ? null : parseStructuredCuaResultList(result);
}

function readCuaResultList(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): unknown[] {
  const display = readToolResultDisplay(toolCall.raw);
  // v4/replayable 的稳定事实源是 display；legacy 文本可能已被 head/tail 裁剪。
  const displayRows =
    display?.kind === "cua" ? parseStructuredCuaResultList(display.structuredContent) : null;
  return (
    displayRows ??
    parseCuaResultList(toolCall.output) ??
    parseCuaResultList(readText(asRecord(toolCall.raw), "rawOutput")) ??
    []
  );
}

export function buildCuaDetailList(
  toolName: string,
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): CuaDetailList | undefined {
  const rows = readCuaResultList(toolCall);
  if (toolName === "list_apps") {
    const items = rows.flatMap((value): CuaAppItem[] => {
      const record = asRecord(value);
      const name = readText(record, "name");
      if (!name) return [];
      return [
        {
          name,
          bundleId: readText(record, "bundle_id"),
          active: record?.active === true,
        },
      ];
    });
    items.sort((left, right) => Number(right.active) - Number(left.active));
    return { kind: "apps", items };
  }
  if (toolName === "list_windows") {
    const items = rows.flatMap((value): CuaWindowItem[] => {
      const record = asRecord(value);
      if (!record) return [];
      const bounds = Array.isArray(record.bounds) ? record.bounds : [];
      return [
        {
          title: readText(record, "title"),
          width: typeof bounds[2] === "number" ? bounds[2] : null,
          height: typeof bounds[3] === "number" ? bounds[3] : null,
          main: record.main === true,
          focused: record.focused === true,
        },
      ];
    });
    return { kind: "windows", items };
  }
  return undefined;
}

function CuaAppList({ items }: { items: CuaAppItem[] }) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [icons, setIcons] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    const bundleIds = [...new Set(items.flatMap((item) => (item.bundleId ? [item.bundleId] : [])))];
    if (!platform?.getApplicationIcon || bundleIds.length === 0) return () => undefined;
    void Promise.all(
      bundleIds.map(async (bundleId) => {
        const result = await platform.getApplicationIcon?.(bundleId);
        return [bundleId, result?.iconDataUrl ?? null] as const;
      }),
    ).then((results) => {
      if (!active) return;
      setIcons(
        Object.fromEntries(
          results.filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
        ),
      );
    });
    return () => {
      active = false;
    };
  }, [items, platform]);

  return (
    <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
      {items.map((item, index) => (
        <div
          key={`${item.bundleId ?? item.name}:${index}`}
          className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover"
        >
          {item.bundleId && icons[item.bundleId] ? (
            <img
              src={icons[item.bundleId]}
              alt=""
              aria-hidden
              className="size-4 shrink-0 object-contain"
            />
          ) : (
            <AppWindow className="size-4 shrink-0 text-foreground-subtle" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{item.name}</span>
          {item.active ? (
            <span className="shrink-0 text-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolCall.cua.details.active" })}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CuaWindowList({ items }: { items: CuaWindowItem[] }) {
  const { intl } = useZCodeIntl();
  return (
    <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
      {items.map((item, index) => (
        <div
          key={`${item.title ?? "untitled"}:${index}`}
          className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-hover"
        >
          <AppWindow className="size-4 shrink-0 text-foreground-subtle" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-foreground">
              {item.title ?? intl.formatMessage({ id: "chat.toolCall.cua.details.untitledWindow" })}
            </div>
            {item.main || item.focused ? (
              <div className="flex flex-wrap gap-x-2 text-sm text-foreground-subtle">
                {item.main ? (
                  <span>{intl.formatMessage({ id: "chat.toolCall.cua.details.mainWindow" })}</span>
                ) : null}
                {item.focused ? (
                  <span>{intl.formatMessage({ id: "chat.toolCall.cua.details.focused" })}</span>
                ) : null}
              </div>
            ) : null}
          </div>
          {item.width !== null && item.height !== null ? (
            <span className="shrink-0 font-mono text-sm text-foreground-subtle">
              {item.width} × {item.height}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function CuaDetailListSection({ list }: { list: CuaDetailList }) {
  const { intl } = useZCodeIntl();
  return (
    <section className="space-y-2 border-t border-border pt-3">
      <h4 className="text-sm text-foreground-subtle">
        {intl.formatMessage({
          id:
            list.kind === "apps"
              ? "chat.toolCall.cua.details.appList"
              : "chat.toolCall.cua.details.windowList",
        })}
      </h4>
      {list.kind === "apps" ? (
        <CuaAppList items={list.items} />
      ) : (
        <CuaWindowList items={list.items} />
      )}
    </section>
  );
}

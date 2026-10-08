import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";

export interface SettingsBreadcrumbItem {
  label: string;
  onSelect?: () => void;
}

interface SettingsBreadcrumbReport {
  items: readonly SettingsBreadcrumbItem[];
  onSectionSelect?: () => void;
}

const SettingsBreadcrumbContext = createContext<
  ((report: SettingsBreadcrumbReport) => () => void) | null
>(null);

export function SettingsBreadcrumbProvider({
  children,
  onItemsChange,
  sectionLabel,
}: {
  children: ReactNode;
  onItemsChange: (items: readonly SettingsBreadcrumbItem[]) => void;
  sectionLabel: string;
}) {
  const reportVersionRef = useRef(0);
  const report = useCallback(
    ({ items, onSectionSelect }: SettingsBreadcrumbReport) => {
      const reportVersion = ++reportVersionRef.current;
      onItemsChange([{ label: sectionLabel, onSelect: onSectionSelect }, ...items]);
      return () => {
        // 多个页面 reporter 切换时，旧 effect 可能晚于新 effect cleanup。
        // 旧版本只能清理自己的投影，不能把较新的面包屑覆盖为空。
        if (reportVersionRef.current === reportVersion) {
          onItemsChange([]);
        }
      };
    },
    [onItemsChange, sectionLabel],
  );

  return (
    <SettingsBreadcrumbContext.Provider value={report}>
      {children}
    </SettingsBreadcrumbContext.Provider>
  );
}

/**
 * 将 section 内既有页面状态和返回动作投影到 Settings 顶栏，但不拥有或持久化导航状态。
 */
export function SettingsBreadcrumbReporter({
  items,
  onSectionSelect,
}: {
  items: readonly SettingsBreadcrumbItem[];
  onSectionSelect?: () => void;
}) {
  const report = useContext(SettingsBreadcrumbContext);
  const actionsRef = useRef(items.map((item) => item.onSelect));
  const sectionActionRef = useRef(onSectionSelect);
  actionsRef.current = items.map((item) => item.onSelect);
  sectionActionRef.current = onSectionSelect;
  const signature = JSON.stringify(items.map((item) => item.label));

  useEffect(() => {
    const labels = JSON.parse(signature) as string[];
    const dispose = report?.({
      items: labels.map((label, index) => ({
        label,
        onSelect: actionsRef.current[index] ? () => actionsRef.current[index]?.() : undefined,
      })),
      onSectionSelect: sectionActionRef.current ? () => sectionActionRef.current?.() : undefined,
    });
    return dispose;
  }, [report, signature]);

  return null;
}

export function SettingsHeaderBreadcrumb({
  ariaLabel,
  className,
  items,
}: {
  ariaLabel: string;
  className?: string;
  items: readonly SettingsBreadcrumbItem[];
}) {
  if (items.length < 2) return null;

  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        "pointer-events-none flex h-full min-w-0 items-center overflow-hidden px-2.5",
        className,
      )}
    >
      <ol className="flex min-w-0 items-center gap-0 overflow-hidden text-ui-base/relaxed">
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <li key={`${index}:${item.label}`} className="flex min-w-0 items-center gap-0">
              {index > 0 ? (
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtlest"
                  data-testid="settings-breadcrumb-separator"
                />
              ) : null}
              {current || !item.onSelect ? (
                <span
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "truncate",
                    current ? "px-2 text-foreground" : "text-foreground-subtle",
                  )}
                >
                  {item.label}
                </span>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="default"
                  data-testid={
                    index === 0 ? "settings-breadcrumb-section" : "settings-breadcrumb-item"
                  }
                  className="pointer-events-auto min-w-0 shrink text-foreground-subtle hover:text-foreground [app-region:no-drag]"
                  onClick={item.onSelect}
                >
                  <span className="truncate">{item.label}</span>
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

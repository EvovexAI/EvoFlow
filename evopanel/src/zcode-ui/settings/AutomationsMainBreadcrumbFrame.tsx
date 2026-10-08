import { useState, type ReactNode } from "react";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";

/**
 * 工作区 Automations 不经过 SettingsPage，编辑页的面包屑上报需要 Provider 接收，
 * 所以桌面顶栏只剩空拖拽区；这里让工作区入口复用设置页的同一套面包屑合同。
 */
export function AutomationsMainBreadcrumbFrame({
  ariaLabel,
  children,
  isDesktop,
  sectionLabel,
}: {
  ariaLabel: string;
  children: ReactNode;
  isDesktop: boolean;
  sectionLabel: string;
}) {
  const [items, setItems] = useState<readonly SettingsBreadcrumbItem[]>([]);

  return (
    <SettingsBreadcrumbProvider onItemsChange={setItems} sectionLabel={sectionLabel}>
      <div className="flex min-h-0 flex-1 flex-col">
        {isDesktop ? (
          <div
            className="h-12 shrink-0 [app-region:drag]"
            data-testid="automations-main-drag-region"
          >
            <SettingsHeaderBreadcrumb ariaLabel={ariaLabel} items={items} />
          </div>
        ) : null}
        {children}
      </div>
    </SettingsBreadcrumbProvider>
  );
}

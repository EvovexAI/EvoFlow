import type { ReactNode } from "react";
import { type BuiltinModelProviderId } from "@zcode/shared";
import { PackageIcon } from "lucide-react";
import { ProviderLogo } from "./ProviderLogo.js";
import { type ModelProviderNavItem } from "./constants.js";

export function createPresetProviderNodeKey(id: BuiltinModelProviderId): string {
  return `preset:${id}`;
}

export function createCodingPlanProviderNodeKey(id: BuiltinModelProviderId): string {
  return `coding-plan:${id}`;
}

export function createCustomProviderNodeKey(id: string): string {
  return `custom:${id}`;
}

export function resolveModelProviderNavLogo(item: ModelProviderNavItem) {
  // 品牌主入口沿用 Start 导航 ID，但不能因此显示体验套餐图标。
  if (item.type === "preset") return item.logo;
  return "provider" in item ? item.provider?.config.logo : undefined;
}

export function renderModelProviderNavIcon(item: ModelProviderNavItem): ReactNode {
  if ("provider" in item && item.provider) {
    return <ProviderLogo logo={resolveModelProviderNavLogo(item)} className="size-4" />;
  }
  return <PackageIcon className="size-4 shrink-0" />;
}

export function fuzzyMatch(text: string, query: string): boolean {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const queryParts = normalizedQuery.split(/\s+/).filter(Boolean);
  return queryParts.every((part) => {
    let searchIndex = 0;
    for (const char of part) {
      const foundIndex = normalizedText.indexOf(char, searchIndex);
      if (foundIndex < 0) {
        return false;
      }
      searchIndex = foundIndex + 1;
    }
    return true;
  });
}

export function handleEndpointSuggestionPopoverOpenAutoFocus({
  keepInputFocus,
  preventDefault,
  focusInput,
}: {
  keepInputFocus: boolean;
  preventDefault: () => void;
  focusInput: () => void;
}): boolean {
  if (!keepInputFocus) {
    return false;
  }

  preventDefault();
  focusInput();
  return true;
}

export function resolveEndpointSuggestionOpenRequest({
  nowMs,
  suppressOpenUntilMs,
}: {
  nowMs: number;
  suppressOpenUntilMs: number;
}): { shouldOpen: boolean } {
  return { shouldOpen: nowMs >= suppressOpenUntilMs };
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SidebarPurposeSectionPreferences {
  projectsExpanded: boolean;
  conversationsExpanded: boolean;
  sectionOrder: SidebarPurposeSectionId[];
}

const SIDEBAR_PURPOSE_SECTION_IDS = ["projects", "conversations"] as const;

type SidebarPurposeSectionId = (typeof SIDEBAR_PURPOSE_SECTION_IDS)[number];

const SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY = "zcode-sidebar-purpose-section-preferences";

const DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES: SidebarPurposeSectionPreferences = {
  projectsExpanded: true,
  conversationsExpanded: true,
  sectionOrder: [...SIDEBAR_PURPOSE_SECTION_IDS],
};

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getDefaultPreferences(): SidebarPurposeSectionPreferences {
  return {
    ...DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES,
    sectionOrder: [...DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.sectionOrder],
  };
}

function normalizeSectionOrder(value: unknown): SidebarPurposeSectionId[] {
  if (!Array.isArray(value) || value.length !== SIDEBAR_PURPOSE_SECTION_IDS.length) {
    return [...SIDEBAR_PURPOSE_SECTION_IDS];
  }

  const sectionIds = new Set(value);
  if (
    sectionIds.size !== SIDEBAR_PURPOSE_SECTION_IDS.length ||
    SIDEBAR_PURPOSE_SECTION_IDS.some((sectionId) => !sectionIds.has(sectionId))
  ) {
    return [...SIDEBAR_PURPOSE_SECTION_IDS];
  }

  return value as SidebarPurposeSectionId[];
}

export function reorderSidebarPurposeSections(
  sectionOrder: readonly SidebarPurposeSectionId[],
  activeSectionId: string,
  overSectionId: string,
): SidebarPurposeSectionId[] {
  const currentOrder = normalizeSectionOrder(sectionOrder);
  const activeIndex = currentOrder.indexOf(activeSectionId as SidebarPurposeSectionId);
  const overIndex = currentOrder.indexOf(overSectionId as SidebarPurposeSectionId);
  if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
    return currentOrder;
  }

  const nextOrder = [...currentOrder];
  const activeSection = nextOrder[activeIndex];
  if (!activeSection) {
    return currentOrder;
  }
  nextOrder.splice(activeIndex, 1);
  nextOrder.splice(overIndex, 0, activeSection);
  return nextOrder;
}

export function readSidebarPurposeSectionPreferences(
  storage: StorageLike | null = getBrowserStorage(),
): SidebarPurposeSectionPreferences {
  try {
    const rawValue = storage?.getItem(SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY);
    if (!rawValue) {
      return getDefaultPreferences();
    }

    const parsed: unknown = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return getDefaultPreferences();
    }

    const value = parsed as Partial<SidebarPurposeSectionPreferences>;
    return {
      projectsExpanded:
        typeof value.projectsExpanded === "boolean"
          ? value.projectsExpanded
          : DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.projectsExpanded,
      conversationsExpanded:
        typeof value.conversationsExpanded === "boolean"
          ? value.conversationsExpanded
          : DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.conversationsExpanded,
      sectionOrder: normalizeSectionOrder(value.sectionOrder),
    };
  } catch {
    return getDefaultPreferences();
  }
}

export function persistSidebarPurposeSectionPreferences(
  preferences: SidebarPurposeSectionPreferences,
  storage: StorageLike | null = getBrowserStorage(),
) {
  try {
    storage?.setItem(
      SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        projectsExpanded: preferences.projectsExpanded,
        conversationsExpanded: preferences.conversationsExpanded,
        sectionOrder: normalizeSectionOrder(preferences.sectionOrder),
      }),
    );
  } catch {
    // 受限 WebView 或隐私模式可能禁止写 localStorage；偏好写入失败不能阻断侧栏交互。
  }
}

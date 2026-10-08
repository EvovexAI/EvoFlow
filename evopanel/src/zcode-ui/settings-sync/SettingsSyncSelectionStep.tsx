import { useMemo } from "react";
import { CheckIcon, MinusIcon } from "lucide-react";
import type { SettingsSyncCategory, SettingsSyncDiscoveryResult } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { renderProviderCliIcon } from "@/lib/providerCliIcon.js";

function getSelectionKey(agent: string, category: string): string {
  return `${agent}:${category}`;
}

const CATEGORY_ORDER: SettingsSyncCategory[] = ["providers", "skills"];

function unionCategories(agents: SettingsSyncDiscoveryResult["agents"]): SettingsSyncCategory[] {
  const found = new Set<SettingsSyncCategory>();
  for (const agent of agents) {
    for (const c of agent.categories) {
      found.add(c.category);
    }
  }
  return CATEGORY_ORDER.filter((c) => found.has(c));
}

function agentsWithCategory(
  agents: SettingsSyncDiscoveryResult["agents"],
  category: SettingsSyncCategory,
) {
  return agents.filter((a) => a.categories.some((c) => c.category === category));
}

function formatAgentName(agent: string, intl: ReturnType<typeof useZCodeIntl>["intl"]): string {
  switch (agent) {
    case "zcode":
      return intl.formatMessage({ id: "settingsSync.agent.zcode" });
    case "claudeCode":
      return intl.formatMessage({ id: "settingsSync.agent.claudeCode" });
    case "codexCli":
      return intl.formatMessage({ id: "settingsSync.agent.codexCli" });
    case "openCode":
      return intl.formatMessage({ id: "settingsSync.agent.openCode" });
    case "agents":
      return intl.formatMessage({ id: "settingsSync.agent.agents" });
    default:
      return agent;
  }
}

function formatCategoryName(
  category: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  switch (category) {
    case "providers":
      return intl.formatMessage({ id: "settingsSync.category.providers" });
    case "skills":
      return intl.formatMessage({ id: "settingsSync.category.skills" });
    default:
      return category;
  }
}

function formatCategoryDescription(
  category: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  switch (category) {
    case "providers":
      return intl.formatMessage({
        id: "settingsSync.category.providers.description",
      });
    case "skills":
      return intl.formatMessage({
        id: "settingsSync.category.skills.description",
      });
    default:
      return intl.formatMessage({
        id: "settingsSync.category.default.description",
      });
  }
}

/**
 * Onboarding 代理设置：与 MCP 平级的可勾选分类列表（当前仅模型供应商）；每类下为各 Agent。
 */
export function SettingsSyncSelectionStep(props: {
  discovery: SettingsSyncDiscoveryResult;
  selectedKeys: string[];
  onToggleSelection: (key: string) => void;
  onSetCategorySelectionAllAgents: (category: SettingsSyncCategory, checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const selected = useMemo(() => new Set(props.selectedKeys), [props.selectedKeys]);

  const agents = props.discovery.agents;
  const categoriesInOrder = useMemo(() => unionCategories(agents), [agents]);

  return (
    <div className="flex w-full flex-col gap-4">
      {categoriesInOrder.map((category) => {
        const agentsForCategory = agentsWithCategory(agents, category);
        const total = agentsForCategory.length;
        const selectedForCategory = agentsForCategory.filter((agent) =>
          selected.has(getSelectionKey(agent.agent, category)),
        ).length;
        const allSelected = total > 0 && selectedForCategory === total;
        const partiallySelected =
          total > 0 && selectedForCategory > 0 && selectedForCategory < total;

        return (
          <div key={category} className="flex w-full flex-col gap-1">
            <div className="flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors hover:bg-surface-hover/50">
              <button
                type="button"
                className="flex size-5 shrink-0 items-center justify-start"
                disabled={total === 0}
                aria-label={intl.formatMessage(
                  { id: "onboarding.agentSettings.categoryToggleAllAria" },
                  { category: formatCategoryName(category, intl) },
                )}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onSetCategorySelectionAllAgents(category, !allSelected);
                }}
              >
                <div
                  className={cn(
                    "flex size-4 items-center justify-center rounded-sm border border-border",
                    allSelected && "border-primary bg-primary text-primary-foreground",
                    partiallySelected &&
                      !allSelected &&
                      "border-primary bg-primary/20 text-primary",
                  )}
                >
                  {allSelected ? (
                    <CheckIcon className="size-3.5" />
                  ) : partiallySelected ? (
                    <MinusIcon className="size-3.5" />
                  ) : null}
                </div>
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-ui-base">
                  <div className="text-ui-base font-medium leading-none text-foreground">
                    {formatCategoryName(category, intl)}
                  </div>
                  <div className="min-w-0 truncate text-foreground-subtle">
                    {formatCategoryDescription(category, intl)}
                  </div>
                </div>
              </div>
            </div>
            <div className="ml-5 flex flex-col gap-1 border-l border-border py-1 pl-4">
              {agentsForCategory.map((agent) => {
                const key = getSelectionKey(agent.agent, category);
                const checked = selected.has(key);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => props.onToggleSelection(key)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors",
                      "hover:bg-surface-hover/50",
                    )}
                  >
                    <div className="flex size-5 shrink-0 items-center justify-center">
                      <div
                        className={cn(
                          "flex size-4 items-center justify-center rounded-sm border border-border",
                          checked && "border-primary bg-primary text-primary-foreground",
                        )}
                      >
                        {checked ? <CheckIcon className="size-3.5" /> : null}
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {renderProviderCliIcon("glm", "size-4 shrink-0 text-foreground")}
                      <div className="min-w-0 flex-1">
                        <div className="text-ui-base font-medium leading-none text-foreground">
                          {formatAgentName(agent.agent, intl)}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

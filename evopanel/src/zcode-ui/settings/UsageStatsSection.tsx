import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import {
  CodingPlanUsagePanel,
  type CodingPlanUsageSource,
} from "@/settings/usage-stats/CodingPlanUsagePanel.js";

export type UsageStatsSectionTab = "app" | "codingPlan" | `codingPlan:${string}`;

export function UsageStatsSection({
  activeTab,
  providerSourcesLoading,
  workspaceIdentity,
  workspacePath,
  selectedCodingPlanSource,
}: {
  activeTab: UsageStatsSectionTab;
  providerSourcesLoading: boolean;
  workspaceIdentity?: string;
  workspacePath?: string;
  selectedCodingPlanSource?: CodingPlanUsageSource | null;
}) {
  if (activeTab === "app") {
    return <AppUsagePanel />;
  }

  return (
    <CodingPlanUsagePanel
      loadingSources={providerSourcesLoading}
      workspaceIdentity={workspaceIdentity}
      workspacePath={workspacePath}
      selectedSource={selectedCodingPlanSource}
    />
  );
}

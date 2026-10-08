interface TeamPlanDisplayNameInput {
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  productName?: string | null;
  productBigTitle?: string | null;
  tier?: string | null;
}

export function formatTeamPlanDisplayName(input: TeamPlanDisplayNameInput): string | null {
  const organizationName = input.organizationName?.trim() ?? "";
  return organizationName || null;
}

type AccountProviderCredentialScope = {
  readonly providerId: string;
  readonly accountIdentity: string;
} & (
  | { readonly planKind: "start-plan" | "individual-coding-plan" }
  | {
      readonly planKind: "team-coding-plan";
      readonly productId: string;
      readonly organizationId: string;
      readonly projectId: string;
    }
);

/**
 * Credential Store 的私有物理 key。
 *
 * 旧账号标识同时承担 Config 身份和凭据缓存键，导致账号身份扩散到
 * Provider、Protocol 与 UI。物理键现在只留在拥有账号身份的 Services 凭据边界。
 */
export function accountProviderCredentialKey(input: AccountProviderCredentialScope): string {
  const providerId = required(input.providerId, "Provider ID");
  const accountIdentity = required(input.accountIdentity, "账号身份");
  const scope =
    input.planKind === "team-coding-plan"
      ? [
          "team",
          providerId,
          required(input.productId, "Team Product ID"),
          required(input.organizationId, "Team Organization ID"),
          required(input.projectId, "Team Project ID"),
        ]
          .map(encodeURIComponent)
          .join(":")
      : `${input.planKind === "start-plan" ? "start-plan" : "coding-plan"}:${providerId}`;
  return `account-provider:${scope}:account:${encodeURIComponent(accountIdentity)}:api-key`;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Account Provider 缺少${label}`);
  return normalized;
}

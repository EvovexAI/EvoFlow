import type { ProviderFamilyDomain } from "@zcode/shared";
import type { AccountProviderCredentialStore } from "./accountProviderCredentialStore.js";
import { accountProviderCredentialKey } from "./accountProviderCredentialKey.js";

interface AccountProviderCredentialServiceOptions {
  readonly credentialStore: Pick<
    AccountProviderCredentialStore,
    "loadApiKey" | "saveApiKey" | "deleteApiKey"
  >;
  readonly loadOAuthAccessToken: (family: ProviderFamilyDomain) => Promise<string | null>;
  readonly resolveProviderApiKey: (
    family: ProviderFamilyDomain,
    accessToken: string,
  ) => Promise<string | null>;
}

interface LoadCodingPlanApiKeyInput {
  readonly providerId: string;
  readonly family: ProviderFamilyDomain;
  readonly accountIdentity: string;
  readonly forceRefresh?: boolean;
}

interface AccountProviderCredentialService {
  loadCodingPlanApiKey(input: LoadCodingPlanApiKeyInput): Promise<string | null>;
}

/**
 * 管理 Personal Coding Plan 的账号级请求凭据。
 *
 * 账号身份只在这里生成 Credential Store 私有 key；远端解析、缓存和并发合并都留在服务内。
 */
export function createAccountProviderCredentialService(
  options: AccountProviderCredentialServiceOptions,
): AccountProviderCredentialService {
  const inFlight = new Map<string, Promise<string | null>>();

  return {
    loadCodingPlanApiKey(input) {
      const credentialKey = accountProviderCredentialKey({
        providerId: input.providerId,
        planKind: "individual-coding-plan",
        accountIdentity: input.accountIdentity,
      });
      const operationKey = `${input.forceRefresh ? "refresh" : "load"}:${credentialKey}`;
      const current = inFlight.get(operationKey);
      if (current) return current;

      const operation = loadCodingPlanApiKey({
        credentialKey,
        family: input.family,
        forceRefresh: input.forceRefresh === true,
        options,
      });
      inFlight.set(operationKey, operation);
      const clearOperation = () => {
        if (inFlight.get(operationKey) === operation) {
          inFlight.delete(operationKey);
        }
      };
      void operation.then(clearOperation, clearOperation);
      return operation;
    },
  };
}

async function loadCodingPlanApiKey(params: {
  readonly credentialKey: string;
  readonly family: ProviderFamilyDomain;
  readonly forceRefresh: boolean;
  readonly options: AccountProviderCredentialServiceOptions;
}): Promise<string | null> {
  if (!params.forceRefresh) {
    const cached = normalizeSecret(
      await params.options.credentialStore.loadApiKey(params.credentialKey),
    );
    if (cached) return cached;
  }

  const accessToken = normalizeSecret(await params.options.loadOAuthAccessToken(params.family));
  if (!accessToken) return null;
  const apiKey = normalizeSecret(
    await params.options.resolveProviderApiKey(params.family, accessToken),
  );
  if (!apiKey) return null;
  await params.options.credentialStore.saveApiKey(params.credentialKey, apiKey);
  return apiKey;
}

function normalizeSecret(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

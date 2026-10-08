import type { ICredentialService } from "#src/credential/credential.js";

export interface AccountProviderCredentialStore {
  loadApiKey(credentialKey: string): Promise<string | null>;
  saveApiKey(credentialKey: string, apiKey: string): Promise<void>;
  deleteApiKey(credentialKey: string): Promise<void>;
}

export interface AccountProviderCredentialStoreOptions {
  readonly credentialService: Pick<ICredentialService, "load" | "save" | "delete">;
}

/**
 * 保存 Account Provider 的请求期凭据。
 *
 * 只读取账号 Credential Store；旧 Provider Store 不再作为凭据来源。
 */
export function createAccountProviderCredentialStore(
  options: AccountProviderCredentialStoreOptions,
): AccountProviderCredentialStore {
  return {
    async loadApiKey(credentialKey) {
      const key = requireCredentialKey(credentialKey);
      return normalizeApiKey(await options.credentialService.load(key));
    },

    async saveApiKey(credentialKey, apiKey) {
      const key = requireCredentialKey(credentialKey);
      const normalized = normalizeApiKey(apiKey);
      if (!normalized) {
        await options.credentialService.delete(key);
        return;
      }
      await options.credentialService.save(key, normalized);
    },

    async deleteApiKey(credentialKey) {
      await options.credentialService.delete(requireCredentialKey(credentialKey));
    },
  };
}

function requireCredentialKey(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Account Provider Credential Key 不能为空");
  return normalized;
}

function normalizeApiKey(value: string | null | undefined): string | null {
  const apiKey = value?.trim() ?? "";
  return apiKey || null;
}

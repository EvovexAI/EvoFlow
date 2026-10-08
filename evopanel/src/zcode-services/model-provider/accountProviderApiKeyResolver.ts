import { BIGMODEL_PROVIDER_ID, resolveBigModelApiOrigin, ZAI_PROVIDER_ID } from "@zcode/shared";
import { ZAI_API_HOST } from "../providers/api/apiEndpoints.js";
import {
  DEFAULT_ORG_NAME,
  DEFAULT_PROJECT_NAME,
  ZCODE_API_KEY_NAME,
  type AccountApiProviderId,
  type RemoteApiKeySecret,
  type RemoteApiKeySummary,
  type RemoteCustomerInfo,
} from "./accountProviderApiTypes.js";

export function pickOrgAndProject(customerInfo: RemoteCustomerInfo): {
  organizationId: string;
  projectId: string;
} | null {
  const personalOrganizations = (customerInfo.organizations ?? [])
    .map((organization) => ({
      organization,
      // Team Plan 项目会和个人项目一起返回；个人 Key 只能从非团队项目解析。
      projects: (organization.projects ?? []).filter(
        (project) => String(project.projectType ?? "").trim() !== "2",
      ),
    }))
    .filter(({ organization, projects }) =>
      Boolean(organization.organizationId && projects.length),
    );
  if (personalOrganizations.length === 0) {
    return null;
  }

  const selected =
    personalOrganizations.find(({ organization }) =>
      (organization.organizationName ?? "").includes(DEFAULT_ORG_NAME),
    ) ?? personalOrganizations[0];
  if (!selected?.organization.organizationId) {
    return null;
  }

  const project =
    selected.projects.find((item) => (item.projectName ?? "").includes(DEFAULT_PROJECT_NAME)) ??
    selected.projects[0];
  if (!project?.projectId) {
    return null;
  }

  return {
    organizationId: selected.organization.organizationId,
    projectId: project.projectId,
  };
}

function createBizAuthHeaders(authorization: string): Record<string, string> {
  return {
    Authorization: authorization,
    "Content-Type": "application/json",
  };
}

export class AccountProviderApiKeyResolver {
  constructor(
    private readonly fetchRemoteData: <T>(url: string, init: RequestInit) => Promise<T | null>,
  ) {}

  async resolveProviderApiKey(
    provider: AccountApiProviderId,
    accessToken: string,
  ): Promise<string | null> {
    try {
      if (provider === BIGMODEL_PROVIDER_ID) {
        return await this.resolveBizApiKey(resolveBigModelApiOrigin(process.env), accessToken);
      }

      if (provider === ZAI_PROVIDER_ID) {
        // 必须 await，才能由当前 catch 将复制明文 Key 失败收敛为无可用凭据。
        return await this.resolveZaiApiKey(accessToken);
      }
    } catch {
      return null;
    }

    return null;
  }

  private async resolveZaiApiKey(oauthAccessToken: string): Promise<string | null> {
    // Provider Connection 已把 Z.AI access token 持久化为业务 token。
    return this.resolveBizApiKey(ZAI_API_HOST, `Bearer ${oauthAccessToken}`, {
      requireSecretKey: true,
    });
  }

  private async resolveBizApiKey(
    host: string,
    authorization: string,
    options?: { requireSecretKey?: boolean },
  ): Promise<string | null> {
    const customerInfo = await this.fetchRemoteData<RemoteCustomerInfo>(
      `${host}/api/biz/customer/getCustomerInfo`,
      {
        method: "GET",
        headers: createBizAuthHeaders(authorization),
      },
    );
    if (!customerInfo) {
      return null;
    }

    const location = pickOrgAndProject(customerInfo);
    if (!location) {
      return null;
    }

    const listUrl =
      `${host}/api/biz/v1/organization/${location.organizationId}` +
      `/projects/${location.projectId}/api_keys`;

    const apiKeys =
      (await this.fetchRemoteData<RemoteApiKeySummary[]>(listUrl, {
        method: "GET",
        headers: createBizAuthHeaders(authorization),
      })) ?? [];

    let apiKeyEntry = apiKeys.find((item) => item.name === ZCODE_API_KEY_NAME) ?? null;

    if (!apiKeyEntry) {
      apiKeyEntry = await this.fetchRemoteData<RemoteApiKeySummary>(listUrl, {
        method: "POST",
        headers: createBizAuthHeaders(authorization),
        body: JSON.stringify({ name: ZCODE_API_KEY_NAME }),
      });
    }

    const apiKey = apiKeyEntry?.apiKey?.trim() ?? "";
    if (!apiKey) {
      return null;
    }

    const copyUrl = `${listUrl}/copy/${encodeURIComponent(apiKey)}`;
    const secretData = await this.fetchRemoteData<RemoteApiKeySecret>(copyUrl, {
      method: "GET",
      headers: createBizAuthHeaders(authorization),
    });

    const secretKey = secretData?.secretKey?.trim() ?? "";
    if (!secretKey) {
      // Z.AI 请求必须使用 copy 接口返回的 secretKey，裸 apiKey 不能用于模型鉴权。
      return options?.requireSecretKey ? null : apiKey;
    }

    return `${apiKey}.${secretKey}`;
  }
}

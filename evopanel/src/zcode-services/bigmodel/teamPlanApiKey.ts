import type { ApiClient } from "@zcode/shared";
import { readApiJson } from "#src/providers/api/apiJson.js";

const BIGMODEL_TEAM_PLAN_API_KEY_NAME = "zcode-team-api-key";
const BIGMODEL_TEAM_PLAN_API_KEY_TYPE = 2;

export interface BigModelTeamPlanBizContext {
  organizationId: string;
  projectId: string;
}

export interface BigModelTeamPlanApiKeySummary {
  apiKey?: string | null;
  keyType?: number | null;
  name?: string | null;
}

interface BigModelTeamPlanApiKeySecret {
  secretKey?: string | null;
}

interface BigModelBizEnvelope<T> {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: T | null;
}

export type BigModelTeamPlanApiKeyEnsureStatus = "existing" | "created" | "missing";

export interface BigModelTeamPlanApiKeyEnsureResult {
  apiKey: BigModelTeamPlanApiKeySummary | null;
  diagnostics: BigModelTeamPlanApiKeyEnsureDiagnostics;
  status: BigModelTeamPlanApiKeyEnsureStatus;
}

export interface BigModelTeamPlanApiKeyEnsureDiagnostics {
  create?: BigModelBizEnvelopeDiagnostics & {
    dataHasApiKey: boolean;
    dataKeyType: number | null;
    dataName: string | null;
  };
  list: BigModelBizEnvelopeDiagnostics & {
    apiKeyCount: number;
    usableApiKeyCount: number;
  };
}

export interface BigModelBizEnvelopeDiagnostics {
  code: number | null;
  msg: string | null;
  success: boolean | null;
}

export function createBigModelBizHeaders(
  authorization: string,
  teamContext?: BigModelTeamPlanBizContext | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: authorization,
    "Content-Type": "application/json",
  };
  if (teamContext) {
    headers["bigmodel-organization"] = teamContext.organizationId;
    headers["bigmodel-project"] = teamContext.projectId;
  }
  return headers;
}

function createBigModelTeamPlanApiKeyPayload(): {
  keyType: typeof BIGMODEL_TEAM_PLAN_API_KEY_TYPE;
  name: typeof BIGMODEL_TEAM_PLAN_API_KEY_NAME;
} {
  return {
    name: BIGMODEL_TEAM_PLAN_API_KEY_NAME,
    keyType: BIGMODEL_TEAM_PLAN_API_KEY_TYPE,
  };
}

function isUsableBigModelTeamPlanApiKey(item: BigModelTeamPlanApiKeySummary): boolean {
  return (
    item.name === BIGMODEL_TEAM_PLAN_API_KEY_NAME &&
    item.keyType === BIGMODEL_TEAM_PLAN_API_KEY_TYPE &&
    Boolean(item.apiKey?.trim())
  );
}

export async function ensureBigModelTeamPlanProjectApiKey(params: {
  apiClient: ApiClient;
  authorization: string;
  host: string;
  teamContext: BigModelTeamPlanBizContext;
  timeoutMs: number;
}): Promise<BigModelTeamPlanApiKeySummary | null> {
  const result = await ensureBigModelTeamPlanProjectApiKeyWithStatus(params);
  return result.apiKey;
}

export async function ensureBigModelTeamPlanProjectApiKeyWithStatus(params: {
  apiClient: ApiClient;
  authorization: string;
  host: string;
  teamContext: BigModelTeamPlanBizContext;
  timeoutMs: number;
}): Promise<BigModelTeamPlanApiKeyEnsureResult> {
  const listUrl = buildBigModelTeamPlanApiKeysUrl(params.host, params.teamContext);
  const listPayload = await readApiJson<BigModelBizEnvelope<BigModelTeamPlanApiKeySummary[]>>(
    params.apiClient,
    listUrl,
    {
      method: "GET",
      timeoutMs: params.timeoutMs,
      headers: createBigModelBizHeaders(params.authorization, params.teamContext),
    },
  );
  const apiKeys = isSuccessfulBigModelBizEnvelope(listPayload) ? (listPayload.data ?? []) : [];
  const listDiagnostics = {
    ...createBigModelBizEnvelopeDiagnostics(listPayload),
    apiKeyCount: apiKeys.length,
    usableApiKeyCount: apiKeys.filter(isUsableBigModelTeamPlanApiKey).length,
  };
  const existingApiKey = apiKeys.find(isUsableBigModelTeamPlanApiKey) ?? null;
  if (existingApiKey) {
    return { apiKey: existingApiKey, diagnostics: { list: listDiagnostics }, status: "existing" };
  }

  // 一个账号可能有多个 Team Plan 项目，每个项目都需要自己的 keyType=2
  // 项目级 API Key；只给当前选中团队创建会导致切换到其他团队后 runtime 无法投影。
  const createPayload = await readApiJson<BigModelBizEnvelope<BigModelTeamPlanApiKeySummary>>(
    params.apiClient,
    listUrl,
    {
      method: "POST",
      timeoutMs: params.timeoutMs,
      headers: createBigModelBizHeaders(params.authorization, params.teamContext),
      body: JSON.stringify(createBigModelTeamPlanApiKeyPayload()),
    },
  );
  const createData = isSuccessfulBigModelBizEnvelope(createPayload)
    ? (createPayload.data ?? null)
    : null;
  const createdApiKey =
    createData && isUsableBigModelTeamPlanApiKey(createData) ? createData : null;
  return {
    apiKey: createdApiKey,
    diagnostics: {
      create: {
        ...createBigModelBizEnvelopeDiagnostics(createPayload),
        dataHasApiKey: Boolean(createPayload.data?.apiKey?.trim()),
        dataKeyType:
          typeof createPayload.data?.keyType === "number" ? createPayload.data.keyType : null,
        dataName: createPayload.data?.name?.trim() || null,
      },
      list: listDiagnostics,
    },
    status: createdApiKey ? "created" : "missing",
  };
}

export async function copyBigModelTeamPlanProjectApiKeySecret(params: {
  apiClient: ApiClient;
  authorization: string;
  apiKey: string;
  host: string;
  teamContext: BigModelTeamPlanBizContext;
  timeoutMs: number;
}): Promise<string | null> {
  const copyPayload = await readApiJson<BigModelBizEnvelope<BigModelTeamPlanApiKeySecret>>(
    params.apiClient,
    `${buildBigModelTeamPlanApiKeysUrl(params.host, params.teamContext)}/copy/${encodeURIComponent(
      params.apiKey,
    )}`,
    {
      method: "GET",
      timeoutMs: params.timeoutMs,
      headers: createBigModelBizHeaders(params.authorization, params.teamContext),
    },
  );
  const secretKey = isSuccessfulBigModelBizEnvelope(copyPayload)
    ? (copyPayload.data?.secretKey?.trim() ?? "")
    : "";
  return secretKey || null;
}

function buildBigModelTeamPlanApiKeysUrl(
  host: string,
  teamContext: BigModelTeamPlanBizContext,
): string {
  return (
    `${host}/api/biz/v1/organization/${encodeURIComponent(teamContext.organizationId)}` +
    `/projects/${encodeURIComponent(teamContext.projectId)}/api_keys`
  );
}

function isSuccessfulBigModelBizEnvelope(envelope: BigModelBizEnvelope<unknown>): boolean {
  if (envelope.success === false) {
    return false;
  }
  if (typeof envelope.code === "number") {
    return envelope.code === 0 || envelope.code === 200;
  }
  return envelope.success === true || envelope.data !== undefined;
}

function createBigModelBizEnvelopeDiagnostics(
  envelope: BigModelBizEnvelope<unknown>,
): BigModelBizEnvelopeDiagnostics {
  return {
    code: typeof envelope.code === "number" ? envelope.code : null,
    msg: envelope.msg?.trim() || null,
    success: typeof envelope.success === "boolean" ? envelope.success : null,
  };
}

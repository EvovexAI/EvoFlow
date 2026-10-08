type FeishuAppRegistrationDomain = "feishu" | "lark";

interface FeishuAppRegistrationBeginResult {
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  interval: number;
  expiresAt: number;
  domain: FeishuAppRegistrationDomain;
  pollDomain?: FeishuAppRegistrationDomain;
}

type FeishuAppRegistrationPollResult =
  | {
      status: "pending";
      interval: number;
      domain: FeishuAppRegistrationDomain;
      pollDomain?: FeishuAppRegistrationDomain;
    }
  | {
      status: "success";
      appId: string;
      appSecret: string;
      domain: FeishuAppRegistrationDomain;
      appName?: string;
      openId?: string;
    }
  | {
      status: "access_denied" | "expired" | "error";
      message?: string;
      domain: FeishuAppRegistrationDomain;
    };

interface FeishuAppRegistrationInitResponse {
  supported_auth_methods?: string[];
}

interface FeishuAppRegistrationBeginResponse {
  device_code?: string;
  verification_uri_complete?: string;
  verification_uri?: string;
  user_code?: string;
  interval?: number;
  expire_in?: number;
}

interface FeishuAppRegistrationPollResponse {
  client_id?: string;
  client_secret?: string;
  app_name?: string;
  client_name?: string;
  name?: string;
  app?: {
    app_name?: string;
    name?: string;
  };
  user_info?: {
    open_id?: string;
    tenant_brand?: FeishuAppRegistrationDomain;
  };
  error?: string;
  error_description?: string;
}

const FEISHU_ACCOUNTS_URL = "https://accounts.feishu.cn";
const LARK_ACCOUNTS_URL = "https://accounts.larksuite.com";
const FEISHU_APP_REGISTRATION_PATH = "/oauth/v1/app/registration";
const FEISHU_APP_REGISTRATION_TIMEOUT_MS = 10_000;
const FEISHU_APP_REGISTRATION_SOURCE = "node-sdk/zcode";

function getAccountsBaseUrl(domain: FeishuAppRegistrationDomain): string {
  return domain === "lark" ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL;
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function readRegistrationAppName(response: FeishuAppRegistrationPollResponse): string | undefined {
  const app = typeof response.app === "object" && response.app !== null ? response.app as Record<string, unknown> : null;
  return (
    response.app_name?.trim() ||
    response.client_name?.trim() ||
    response.name?.trim() ||
    readString(app, "app_name").trim() ||
    readString(app, "name").trim() ||
    undefined
  );
}

async function postRegistration<T>(
  domain: FeishuAppRegistrationDomain,
  body: Record<string, string>,
): Promise<T> {
  const response = await fetch(`${getAccountsBaseUrl(domain)}${FEISHU_APP_REGISTRATION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(FEISHU_APP_REGISTRATION_TIMEOUT_MS),
  });
  return (await response.json()) as T;
}

export async function beginFeishuAppRegistration(
  domain: FeishuAppRegistrationDomain = "feishu",
): Promise<FeishuAppRegistrationBeginResult> {
  // Bugfix: 对齐 @larksuiteoapi/node-sdk registerApp：一键创建应用总是先从 Feishu accounts issuer
  // 获取二维码，Lark 租户在 poll 阶段根据 tenant_brand 再切到 accounts.larksuite.com。
  const pollDomain: FeishuAppRegistrationDomain = "feishu";
  const initResponse = await postRegistration<FeishuAppRegistrationInitResponse>(pollDomain, {
    action: "init",
  });
  if (!initResponse.supported_auth_methods?.includes("client_secret")) {
    throw new Error("Current Feishu environment does not support client_secret registration.");
  }

  const beginResponse = await postRegistration<FeishuAppRegistrationBeginResponse>(pollDomain, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  if (!beginResponse.device_code || !beginResponse.verification_uri_complete) {
    throw new Error("Feishu app registration did not return a device code.");
  }
  const qrUrl = new URL(beginResponse.verification_uri_complete);
  // SDK registerApp 使用 from=sdk/source=node-sdk[/source]/tp=sdk；这里保留 zcode 来源方便排查。
  qrUrl.searchParams.set("from", "sdk");
  qrUrl.searchParams.set("source", FEISHU_APP_REGISTRATION_SOURCE);
  qrUrl.searchParams.set("tp", "sdk");
  const expireInSeconds = beginResponse.expire_in ?? 600;
  return {
    deviceCode: beginResponse.device_code,
    qrUrl: qrUrl.toString(),
    userCode: beginResponse.user_code ?? "",
    interval: beginResponse.interval ?? 5,
    expiresAt: Date.now() + expireInSeconds * 1000,
    domain,
    pollDomain,
  };
}

export async function pollFeishuAppRegistration(params: {
  deviceCode: string;
  domain?: FeishuAppRegistrationDomain;
  pollDomain?: FeishuAppRegistrationDomain;
}): Promise<FeishuAppRegistrationPollResult> {
  const domain = params.domain ?? "feishu";
  const pollDomain = params.pollDomain ?? domain;
  const pollResponse = await postRegistration<FeishuAppRegistrationPollResponse>(pollDomain, {
    action: "poll",
    device_code: params.deviceCode,
  });
  const resultDomain = pollResponse.user_info?.tenant_brand ?? domain;
  if (pollResponse.user_info?.tenant_brand === "lark" && pollDomain !== "lark") {
    return {
      status: "pending",
      interval: 0,
      domain: resultDomain,
      pollDomain: "lark",
    };
  }
  if (pollResponse.client_id && pollResponse.client_secret) {
    const appName = readRegistrationAppName(pollResponse);
    return {
      status: "success",
      appId: pollResponse.client_id,
      appSecret: pollResponse.client_secret,
      domain: resultDomain,
      ...(appName ? { appName } : {}),
      openId: pollResponse.user_info?.open_id,
    };
  }
  if (!pollResponse.error || pollResponse.error === "authorization_pending") {
    return { status: "pending", interval: 5, domain: resultDomain };
  }
  if (pollResponse.error === "slow_down") {
    return { status: "pending", interval: 10, domain: resultDomain };
  }
  if (pollResponse.error === "access_denied") {
    return { status: "access_denied", domain: resultDomain };
  }
  if (pollResponse.error === "expired_token") {
    return { status: "expired", domain: resultDomain };
  }
  return {
    status: "error",
    message: `${pollResponse.error}: ${pollResponse.error_description ?? "unknown"}`,
    domain: resultDomain,
  };
}

import {
  ApiError,
  BIGMODEL_PROVIDER_ID,
  type ApiClient,
  type OAuthCallbackParams,
  type OAuthProviderMeta,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import { readApiJson } from "../../providers/api/apiJson.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import { parseOAuthLoginAttribution } from "../callbackAttribution.js";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";

interface BigModelZcodeTokenEnvelope {
  code?: number;
  msg?: string;
  data?: {
    token?: string | null;
    access_token?: string | null;
    accessToken?: string | null;
    bigmodel?: {
      access_token?: string | null;
      accessToken?: string | null;
      refresh_token?: string | null;
      refreshToken?: string | null;
    } | null;
  } | null;
}

interface BigModelCustomerInfo {
  customerNumber?: unknown;
  customerName?: unknown;
  nickName?: unknown;
  avatar?: unknown;
}

/** OAuth 启动恢复允许的最长等待时间（1 分钟） */
const OAUTH_USERINFO_TIMEOUT_MS = 60_000;
const log = createServiceLogger("bigmodelOAuth");

function maskOAuthCode(code: string): string {
  if (code.length <= 8) {
    return "*".repeat(code.length);
  }

  return `${code.slice(0, 4)}...${code.slice(-4)}`;
}

function readOptionalString(value: unknown): string | undefined {
  // BigModel userinfo 是远端运行时数据，异常类型不能参与 trim 或持久化为展示字段。
  return typeof value === "string" ? value : undefined;
}

function readTrimmedString(value: unknown): string {
  return readOptionalString(value)?.trim() || "";
}

function resolveBigModelDisplayName(customer: BigModelCustomerInfo): string {
  const customerName = readTrimmedString(customer.customerName);
  const nickName = readTrimmedString(customer.nickName);
  return customerName || nickName || "user";
}

/** BigModel OAuth 协议适配器 */
export class BigModelProviderAdapter implements OAuthProviderAdapter {
  readonly providerId = BIGMODEL_PROVIDER_ID;
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;

  constructor(
    private config: OAuthProviderRuntimeConfig,
    apiClient: ApiClient,
  ) {
    this.meta = {
      id: config.id,
      displayName: config.displayName,
      enabled: config.enabled,
      order: config.order,
    };
    this.redirectUri = config.redirectUri;
    this.apiClient = apiClient;
  }

  async normalizePolledTokenSet(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet> {
    // polling ready 已返回 BigModel 业务 token；不走 Z.AI 的二次业务 token 兑换。
    return tokenSet;
  }

  parseCallbackParams(url: string): OAuthCallbackParams {
    const parsed = new URL(url);
    // BigModel 线上回调历史上用 authCode，新版可能回落为 code。
    // 这里同时兼容两个字段，避免控制台切换参数名时客户端直接登录失败。
    const code = parsed.searchParams.get("authCode") ?? parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");

    if (!code || !state) {
      throw new Error("OAuth 回调缺少 authCode/code 或 state 参数");
    }

    const attribution = parseOAuthLoginAttribution(parsed.searchParams);

    return { code, state, ...(attribution ? { attribution } : {}) };
  }

  buildAuthorizeUrl(context: OAuthProviderContext): string {
    const query = new URLSearchParams({
      redirect: context.redirectUri,
      appId: this.config.appId,
      state: context.state,
    });

    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  async exchangeToken(
    params: OAuthCallbackParams,
    _context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    const tokenSet = await this.exchangeZcodeJwtToken(params, _context);

    return {
      ...tokenSet,
    };
  }

  private async exchangeZcodeJwtToken(
    params: OAuthCallbackParams,
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    log.info(undefined, "zcode token request", {
      method: "POST",
      url: this.config.tokenUrl,
      headers: { "Content-Type": "application/json" },
      body: {
        provider: BIGMODEL_PROVIDER_ID,
        code: maskOAuthCode(params.code),
        codeLength: params.code.length,
        redirect_uri: context.redirectUri,
        state: context.state,
      },
    });

    try {
      const payload = await readApiJson<BigModelZcodeTokenEnvelope>(
        this.apiClient,
        this.config.tokenUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // zcode JWT 的后端 token 路由按 OAuth callback 授权码语义解析。
          // BigModel Start Plan 不能在后续 balance 查询阶段用 access_token 二次兑换，
          // 否则 body 与 Z.ai 登录链路不一致并触发 HTTP 400。provider 用 shared
          // 中的 OAuth provider 枚举值，避免前后端新增多 provider 后只靠 redirect_uri 猜身份。
          body: JSON.stringify({
            provider: BIGMODEL_PROVIDER_ID,
            code: params.code,
            redirect_uri: context.redirectUri,
            state: context.state,
          }),
        },
      );
      if (payload.code !== undefined && payload.code !== 0) {
        // BigModel 的一次性 authCode 现在只交给 zcode token 路由。
        // 如果这里失败，不能继续保存半登录态，否则 Start Plan 仍会显示未连接。
        log.warn(undefined, "zcode token business response rejected", {
          code: payload.code,
          msg: payload.msg,
        });
        throw new Error(
          payload.msg?.trim() || `BigModel zcode token 交换失败（code: ${payload.code}）`,
        );
      }
      const zcodeJwtToken = payload.data?.token?.trim() || "";
      if (!zcodeJwtToken) {
        log.warn(undefined, "zcode token response missing data.token", {
          code: payload.code,
          msg: payload.msg,
        });
        throw new Error("BigModel zcode token 交换失败：响应缺少 data.token");
      }
      const accessToken = resolveBigModelBusinessAccessToken(payload);
      if (!accessToken) {
        // Coding Plan 付费套餐仍调用 bigmodel.cn 业务接口，只能使用
        // BigModel 业务 access token；zcode JWT 只能写入 zcodejwttoken 给 Start Plan 使用。
        // 如果继续把 zcode JWT 写进 oauth:bigmodel:access_token，套餐预览会稳定报“令牌已过期”。
        log.warn(undefined, "zcode token response missing bigmodel access token", {
          code: payload.code,
          msg: payload.msg,
        });
        throw new Error("BigModel zcode token 交换失败：响应缺少 data.bigmodel.access_token");
      }

      const refreshToken =
        payload.data?.bigmodel?.refresh_token?.trim() ??
        payload.data?.bigmodel?.refreshToken?.trim() ??
        "";
      return {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        zcodeJwtToken,
      };
    } catch (error) {
      // BigModel callback code 是一次性的，客户端不能再先调用
      // tokenByAuthCode 消费它；zcode token 交换失败时直接中止登录并记录链路头。
      log.warn(undefined, "zcode token request failed", {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ApiError
          ? {
              method: error.method,
              status: error.status,
              url: error.url,
              responseHeaders: error.responseHeaders ?? {},
            }
          : {}),
      });
      throw error;
    }
  }

  async fetchUserInfo(
    tokenSet: OAuthTokenSet,
    _context: OAuthProviderContext,
  ): Promise<OAuthUserProfile> {
    if (tokenSet.zcodeJwtToken && tokenSet.accessToken === tokenSet.zcodeJwtToken) {
      // 移除 tokenByAuthCode 后 callback 阶段没有 BigModel access token。
      // zcode JWT 不能调用 bigmodel.cn 的 customer 接口，避免无意义的鉴权失败请求。
      return {
        id: "unknown",
        username: "user",
        displayName: "User",
      };
    }

    const userinfoPayload = await readApiJson<{
      data?: BigModelCustomerInfo;
    }>(this.apiClient, this.config.userinfoUrl, {
      method: "GET",
      // 启动恢复登录态依赖这条 userinfo 校验链路。
      // 没有超时时网络层可能长期 pending，导致 UI 一直显示“恢复中”。
      // 这里固定 1 分钟超时，保证失败路径可及时落定，避免无限 loading。
      timeoutMs: OAUTH_USERINFO_TIMEOUT_MS,
      headers: {
        // BigModel customer 信息接口要求 Authorization 直接传 token，
        // 不能使用 Bearer 前缀，否则稳定返回鉴权失败。
        Authorization: tokenSet.accessToken,
        "Content-Type": "application/json",
      },
    });
    const customer = userinfoPayload.data;

    if (!customer) {
      return {
        id: "unknown",
        username: "user",
        displayName: "User",
      };
    }

    // BigModel customerName 是账号真实展示名，nickName 只是昵称兜底；
    // 空字符串在 API 语义上等同缺失，必须 trim 后再选择，避免账号展示为空白。
    const username = resolveBigModelDisplayName(customer);

    return {
      id: readOptionalString(customer.customerNumber) ?? "unknown",
      username,
      displayName: username,
      avatarUrl: readOptionalString(customer.avatar),
    };
  }

  async loadLegacyTokenSet(
    loadCredential: (key: string) => Promise<string | null>,
  ): Promise<OAuthTokenSet | null> {
    const accessToken = await loadCredential("auth_token");
    if (!accessToken) {
      return null;
    }

    const refreshToken = await loadCredential("refresh_token");

    // 旧版 BigModel 登录态只写 auth_token/refresh_token，
    // 如果不在 provider 层做兼容，升级后会被误判为“没有 token”。
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
    };
  }

  normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(`BigModel OAuth 异常: ${String(error)}`);
  }
}

function resolveBigModelBusinessAccessToken(payload: BigModelZcodeTokenEnvelope): string {
  return (
    payload.data?.bigmodel?.access_token?.trim() ??
    payload.data?.bigmodel?.accessToken?.trim() ??
    payload.data?.access_token?.trim() ??
    payload.data?.accessToken?.trim() ??
    ""
  );
}

import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
} from "@zcode/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import { resolveBigModelUserinfoUrl } from "#src/oauth/providers/bigmodelProviderConfig.js";
import { resolveZaiUserinfoUrl } from "#src/oauth/providers/zaiProviderConfig.js";

function tryResolveHttpUrl(resolve: () => string | URL): URL | null {
  try {
    const url = new URL(resolve());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// 这里只判定候选请求；实际退出须由 OAuthService 在会话变更队列内复核，不能依赖异步旧快照。
export async function isCurrentOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return false;
  const currentJwt = (await options.credentialService.load("zcodejwttoken"))?.trim() ?? "";
  if (currentJwt && authorization === `Bearer ${currentJwt}`) return true;

  // 原观察器只识别 ZCode JWT，业务 access token 的 userinfo 401
  // 只会变成普通请求错误。仅扩展用户/团队身份查询，避免支付和 API key 接口跟随全局退出。
  const provider = await options.credentialService.load("oauth:active_provider");
  if (provider !== BIGMODEL_PROVIDER_ID && provider !== ZAI_PROVIDER_ID) return false;
  const env = options.env ?? process.env;
  const requestUrl = tryResolveHttpUrl(() => options.input);
  if (!requestUrl) return false;
  const customerInfoPath = "/api/biz/customer/getCustomerInfo";
  // 单个候选 URL 构造失败曾阻断其它有效接口的 401 识别。
  // 分别延迟构造并解析，只读取 userinfo 所需配置，避免无关授权/登录配置的异常。
  const urls =
    provider === BIGMODEL_PROVIDER_ID
      ? [() => buildBigModelApiUrl(env, customerInfoPath), () => resolveBigModelUserinfoUrl(env)]
      : [() => buildRuntimeZaiBusinessUrl(env, customerInfoPath), () => resolveZaiUserinfoUrl(env)];
  if (
    !urls.some((resolve) => {
      const expected = tryResolveHttpUrl(resolve);
      return (
        expected !== null &&
        requestUrl.origin === expected.origin &&
        requestUrl.pathname === expected.pathname
      );
    })
  )
    return false;

  const accessToken = (
    await options.credentialService.load(`oauth:${provider}:access_token`)
  )?.trim();
  if (!accessToken || (authorization !== accessToken && authorization !== `Bearer ${accessToken}`))
    return false;
  // 读取磁盘期间可能切换平台，不能拿上一平台残留 token 的 401 清理当前登录。
  return (await options.credentialService.load("oauth:active_provider")) === provider;
}

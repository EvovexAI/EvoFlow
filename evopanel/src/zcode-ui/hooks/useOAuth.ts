/**
 * useOAuth —— OAuth 登录流程 hook
 *
 * 仅负责发起登录和 UI 状态管理。
 * OAuth 回调监听在 Root/App 常驻层，不在此 hook 中。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { OAuthProviderId, OAuthProviderMeta } from "@zcode/shared";
import {
  BIGMODEL_PROVIDER_ID,
  isCredentialDecryptError,
  resolveSafeTelemetryHostname,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LoginEntryPurpose } from "@/store/index.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { logger } from "../logger.js";
import { usePlatform } from "./usePlatform.js";
import { useServices } from "./useServices.js";

type OAuthStatus = "idle" | "waiting" | "error";

export function useOAuth() {
  const { oauthService } = useServices();
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<OAuthStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<OAuthProviderMeta[]>([]);
  const [activeProvider, setActiveProvider] = useState<OAuthProviderId | null>(null);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [pendingProvider, setPendingProvider] = useState<OAuthProviderId | null>(null);
  const loginAttemptRef = useRef(0);
  const setOAuthPollingActive = useZCodeStore((state) => state.setOAuthPollingActive);

  const refreshProviders = useCallback(async () => {
    try {
      setLoadingProviders(true);
      const providerList = await oauthService.getProviders();
      setProviders(providerList);

      try {
        const active = await oauthService.getActiveProvider();
        setActiveProvider(active);
      } catch (err) {
        // 只有本地 OAuth 凭据解密失败才可恢复为未登录态；RPC/存储权限等错误需要走外层错误路径。
        if (!isCredentialDecryptError(err)) {
          throw err;
        }

        // active provider 只是登录态指针，解密失败时服务层会清理 OAuth 凭据。
        // provider 列表仍然可用，不能让用户看到“没有登录渠道”。
        logger.warn("[useOAuth] 加载 active provider 凭据失败，已按未登录处理:", err);
        setActiveProvider(null);
      }
    } catch (err) {
      logger.error("[useOAuth] 加载 provider 列表失败:", err);
      setProviders([]);
      setActiveProvider(null);
    } finally {
      setLoadingProviders(false);
    }
  }, [oauthService]);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const startLogin = useCallback(
    async (provider: OAuthProviderId, options: { purpose?: LoginEntryPurpose } = {}) => {
      const loginAttempt = ++loginAttemptRef.current;
      try {
        setStatus("waiting");
        setError(null);
        setPendingProvider(provider);

        const {
          authorizeUrl,
          state,
          provider: startedProvider,
        } = await oauthService.startOAuthWithPolling(provider);

        if (loginAttemptRef.current !== loginAttempt) {
          return;
        }

        platform.registerOAuthState({ state, provider: startedProvider });
        setOAuthPollingActive(
          startedProvider === ZAI_PROVIDER_ID || startedProvider === BIGMODEL_PROVIDER_ID,
        );
        platform.openExternal(authorizeUrl);
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "app_login_ck",
            eventRegion: "app",
            eventType: "ck",
            eventExtraDetail: {
              // 授权 URL 含 state/凭据参数；埋点只取 hostname，浏览器仍使用上面的完整地址。
              login_url: resolveSafeTelemetryHostname(authorizeUrl),
            },
          },
          "useOAuth",
        );

        logger.info("[useOAuth] OAuth 流程已启动，等待浏览器回调", {
          provider: startedProvider,
          purpose: options.purpose ?? "app-login",
        });
      } catch (err) {
        // 旧 init 的失败可能晚于新登录成功返回，不能反向关闭新 flow 的轮询或覆盖 UI。
        if (loginAttemptRef.current !== loginAttempt) {
          return;
        }
        logger.error("[useOAuth] 启动 OAuth 失败:", err);
        setOAuthPollingActive(false);
        setStatus("error");
        // OAuth 启动失败也属于登录失败，不把服务端或平台错误原文展示给用户。
        // 原文通过 i18n 渲染，避免登录页出现 provider/token 等具体失败原因。
        setError(intl.formatMessage({ id: "login.oauth.loginFailure" }));
        setPendingProvider(null);
      }
    },
    [intl, oauthService, platform, setOAuthPollingActive],
  );

  const cancel = useCallback(
    async (provider?: OAuthProviderId) => {
      loginAttemptRef.current += 1;
      await oauthService.cancelPending(provider);
      setOAuthPollingActive(false);
      setStatus("idle");
      setError(null);
      setPendingProvider(null);
    },
    [oauthService, setOAuthPollingActive],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setPendingProvider(null);
  }, []);

  /** 由 Root/App 层的回调监听器调用，更新 UI 状态 */
  const setOAuthError = useCallback((message: string) => {
    setStatus("error");
    setError(message);
    setPendingProvider(null);
  }, []);

  const setOAuthSuccess = useCallback(async () => {
    setStatus("idle");
    setError(null);
    setPendingProvider(null);
    await refreshProviders();
  }, [refreshProviders]);

  return {
    startLogin,
    cancel,
    reset,
    status,
    error,
    providers,
    activeProvider,
    loadingProviders,
    pendingProvider,
    refreshProviders,
    setOAuthError,
    setOAuthSuccess,
  };
}

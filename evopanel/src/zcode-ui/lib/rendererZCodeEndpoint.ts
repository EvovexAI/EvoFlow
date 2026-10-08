import {
  buildRuntimeZCodeEndpointUrls,
  ZCODE_ENV,
  type RuntimeZCodeEndpointEnv,
} from "@zcode/shared";

interface RendererImportMetaEnv {
  VITE_ZCODE_BASE_URL?: string;
  VITE_ZCODE_ENDPOINT_ORIGIN?: string;
}

function readRendererImportMetaEnv(): RendererImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: RendererImportMetaEnv }).env ??
    {}) as RendererImportMetaEnv;
}

function createRendererZCodeEndpointEnv(
  env: RendererImportMetaEnv = readRendererImportMetaEnv(),
): RuntimeZCodeEndpointEnv {
  return {
    ZCODE_ENV,
    // UI 侧的 zcode-plan 占位 provider 以前只看 ZCODE_ENV，
    // 没有消费 Vite 注入的 base url，导致自定义测试域名时 renderer 和 host/service 可能不一致。
    ZCODE_BASE_URL: env.VITE_ZCODE_BASE_URL,
    ZCODE_ENDPOINT_ORIGIN: env.VITE_ZCODE_ENDPOINT_ORIGIN,
  };
}

export const RENDERER_ZCODE_ENDPOINT_URLS = buildRuntimeZCodeEndpointUrls(
  createRendererZCodeEndpointEnv(),
);

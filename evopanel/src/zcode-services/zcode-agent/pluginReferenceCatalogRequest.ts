import {
  zcodeProtocolMethods,
  zcodePluginsReferenceCatalogResultSchema,
  type ZCodePluginsReferenceCatalogParams,
} from "@zcode/shared";
import type { ZCodeProtocolClient } from "#src/zcode-agent/zcodeProtocolClient.js";

/** 旧协议严格校验响应；新展示字段走独立入口，只有 -32601 能证明旧 Agent 不支持。 */
export async function requestPluginReferenceCatalog(
  client: Pick<ZCodeProtocolClient, "request">,
  params: ZCodePluginsReferenceCatalogParams,
) {
  try {
    return await client.request(
      zcodeProtocolMethods.pluginsReferenceCatalogWithCategory,
      params,
      zcodePluginsReferenceCatalogResultSchema,
    );
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === -32601))
      throw error;
    return client.request(
      zcodeProtocolMethods.pluginsReferenceCatalog,
      params,
      zcodePluginsReferenceCatalogResultSchema,
    );
  }
}

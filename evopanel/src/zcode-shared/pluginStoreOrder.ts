import { z } from "zod";

const orderList = z.array(z.string().trim().min(1)).transform((items) => [...new Set(items)]);
const modeOrderSchema = z.object({
  categoryOrder: orderList.optional(),
  pluginOrder: z.record(z.string(), orderList).optional(),
});
const pluginStoreOrderSchema = z.object({
  code: modeOrderSchema.optional().catch(undefined),
  work: modeOrderSchema.optional().catch(undefined),
});

export type PluginStoreModeOrder = z.infer<typeof modeOrderSchema>;
export type PluginStoreOrder = z.infer<typeof pluginStoreOrderSchema>;

/** 排序只是展示配置；错误模式独立回退，不能阻止目录浏览或污染另一种模式。 */
export function parsePluginStoreOrder(value: unknown): PluginStoreOrder | null {
  return pluginStoreOrderSchema.safeParse(value).data ?? null;
}

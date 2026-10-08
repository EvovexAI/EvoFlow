import { z } from "zod";

const sharedContextImportV2StateSchema = z
  .object({
    contextId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    shareUrl: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === "https:" || url.protocol === "http:") &&
            url.search === "" &&
            url.hash === "" &&
            /^\/cn\/share\/[^/]+$/u.test(url.pathname)
          );
        } catch {
          return false;
        }
      }, "shareUrl must use the canonical /cn/share/<code> path"),
    status: z.enum(["pending", "reserved", "attached", "discarded"]),
  })
  .strict();
// shareUrl 硬绑 /cn/share/<code>。将来换域名、或改用英文站 /share/<code> 作为
// canonical 时，存量会话的持久化 provenance 会校验失败（本地持久化，不是 wire，所以不在
// 「响应宽容」那条纪律的覆盖范围内）。真要改 canonical URL 形状时，这里要先加一个接受旧形状
// 的 legacy 分支——照 legacySharedContextImportStateSchema 的做法。

const legacySharedContextImportStateSchema = z.object({ title: z.string().trim().min(1) }).strict();

export const sharedContextImportStateSchema = z.union([
  sharedContextImportV2StateSchema,
  legacySharedContextImportStateSchema,
]);

export type SharedContextImportState = z.infer<typeof sharedContextImportStateSchema>;

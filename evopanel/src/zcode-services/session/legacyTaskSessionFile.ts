import type { ZCodeSessionFile, ZCodeTaskMeta } from "@zcode/shared";
import { zcodeSessionFileSchema, zcodeTaskMetaSchema, zcodeTaskModeSchema } from "@zcode/shared";

export type LegacyTaskSessionFile = Omit<ZCodeSessionFile, "meta"> & {
  meta: Omit<ZCodeTaskMeta, "mode"> & { mode?: ZCodeTaskMeta["mode"] };
};

const legacyTaskSessionFileSchema = zcodeSessionFileSchema.extend({
  // Claude 原生迁移会按清洗路径删除 meta.mode。
  // legacy snapshot 读取/写入仍要校验其它必需字段，但不能再强制把被过滤字段补回文件。
  meta: zcodeTaskMetaSchema.extend({
    mode: zcodeTaskModeSchema.optional(),
  }),
});

export function parseLegacyTaskSessionFile(input: unknown): LegacyTaskSessionFile {
  return legacyTaskSessionFileSchema.parse(input);
}

export function safeParseLegacyTaskSessionFile(input: unknown) {
  return legacyTaskSessionFileSchema.safeParse(input);
}

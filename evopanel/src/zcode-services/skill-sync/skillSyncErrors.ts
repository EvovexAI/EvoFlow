import { SKILL_SYNC_SIZE_LIMIT_ERROR_CODE, type SkillSyncSizeLimitErrorData } from "@zcode/shared";

// 原始错误只携带字节数拼接文本，跨 RPC 后 UI 无法可靠区分导出内容、归档和解压阶段。
// 统一透传稳定 code 与结构化 data，让 UI 可以按当前语言展示可操作的错误。
interface SkillSyncSizeLimitError extends Error {
  code: typeof SKILL_SYNC_SIZE_LIMIT_ERROR_CODE;
  data: SkillSyncSizeLimitErrorData;
}

export function createSkillSyncSizeLimitError(
  data: SkillSyncSizeLimitErrorData,
): SkillSyncSizeLimitError {
  const error = new Error(
    `skill sync size limit exceeded: ${data.actualBytes}/${data.maxBytes} (${data.phase})`,
  ) as SkillSyncSizeLimitError;
  error.name = "SkillSyncSizeLimitError";
  error.code = SKILL_SYNC_SIZE_LIMIT_ERROR_CODE;
  error.data = data;
  return error;
}

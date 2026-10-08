import type { ZCodePromptAttachment } from "@zcode/shared";

export function deriveSessionTitle(
  content: string,
  attachments: readonly ZCodePromptAttachment[],
): string {
  if (content.length > 0) {
    return content.slice(0, 50) + (content.length > 50 ? "..." : "");
  }

  const firstAttachment = attachments[0];
  if (!firstAttachment) {
    return "";
  }

  const extraCount = attachments.length - 1;
  return extraCount > 0 ? `${firstAttachment.filename} +${extraCount}` : firstAttachment.filename;
}

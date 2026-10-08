import type { Locale, PostUpdateReleaseNotesPayload } from "@zcode/shared";

export type LocalizedUpdateReleaseNotes = {
  title: string;
  markdown: string;
};

export function getLocalizedUpdateReleaseNotes(
  payload: PostUpdateReleaseNotesPayload | undefined,
  locale: Locale,
): LocalizedUpdateReleaseNotes | null {
  if (!payload) {
    return null;
  }

  const defaultReleaseNotes = {
    title: payload.title,
    markdown: payload.markdown,
  };

  return (
    payload.releaseNotesByLocale?.[locale] ??
    (locale === "zh-CN"
      ? defaultReleaseNotes
      : (payload.releaseNotesByLocale?.["zh-CN"] ?? defaultReleaseNotes))
  );
}

export function formatUpdateReleaseDate(
  releaseDate: string | undefined,
  locale: Locale,
): string | null {
  if (!releaseDate) {
    return null;
  }

  const date = new Date(releaseDate);
  if (Number.isNaN(date.getTime())) {
    return releaseDate;
  }

  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    // update feed 的 releaseDate 通常是 UTC 零点。按用户本地时区格式化会让
    // 美洲等时区显示成前一天，hover 中只展示发布日期时应保持 feed 日期稳定。
    timeZone: "UTC",
  }).format(date);
}

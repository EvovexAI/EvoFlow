import { pinyin } from "pinyin-pro";

const namePinyin = new Map<string, readonly string[]>();

function pinyinKeys(name: string): readonly string[] {
  const cached = namePinyin.get(name);
  if (cached) return cached;
  const syllables = pinyin(name, { toneType: "none", type: "array" });
  const keys = [syllables.join(""), syllables.map((part) => part[0] ?? "").join("")].map((key) =>
    key.toLowerCase().replace(/\s+/g, ""),
  );
  // 名称来自可刷新市场，限制缓存避免长期运行时保留已移除条目。
  if (namePinyin.size >= 1000) namePinyin.clear();
  namePinyin.set(name, keys);
  return keys;
}

/** 中文品牌名可能只存在于 listing 翻译中；两个页面均按同一条目的名称生成拼音。 */
export function pluginSearchMatches(
  query: string,
  text: readonly (string | undefined)[],
  names: readonly (string | undefined)[],
): boolean {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return true;
  if ([...text, ...names].some((value) => value?.toLowerCase().includes(keyword))) return true;
  const pinyinQuery = keyword.replace(/\s+/g, "");
  if (!/^[a-z]+$/.test(pinyinQuery)) return false;
  return names.some(
    (name) =>
      name &&
      /\p{Script=Han}/u.test(name) &&
      pinyinKeys(name).some((key) => key.includes(pinyinQuery)),
  );
}

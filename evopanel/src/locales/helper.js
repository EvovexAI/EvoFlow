/**
 * i18n 多语言辅助函数
 * 参数顺序: zhCN, en, zhTW, ja, ko, vi, es, pt, ru, fr, de
 * 缺省 fallback: zhTW→zhCN, 其余→en
 */
export const SUPPORTED_LANGS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'vi', 'es', 'pt', 'ru', 'fr', 'de']

export function _(zhCN, en, zhTW, ja, ko, vi, es, pt, ru, fr, de) {
  return {
    'zh-CN': zhCN,
    en,
    'zh-TW': zhTW || zhCN,
    ja: ja || en,
    ko: ko || en,
    vi: vi || en,
    es: es || en,
    pt: pt || en,
    ru: ru || en,
    fr: fr || en,
    de: de || en,
  }
}

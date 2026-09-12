/**
 * i18n 国际化核心模块
 * 模块化多语言架构，支持 zh-CN / en / zh-TW / ja / ko
 */
import { buildLocales } from '../locales/index.js'

const LANGS = buildLocales()
import { getPanelSetting, patchPanelSettings } from './panel-settings.js'

const LANG_KEY = 'evopanel_lang'
const LANG_KEY_LEGACY = 'evopanel_lang'
const FALLBACK = 'zh-CN'

let _lang = FALLBACK
let _dict = LANGS[FALLBACK]
let _listeners = []

/**
 * 翻译函数
 * @param {string} key - 点分隔路径，如 'sidebar.dashboard'
 * @param {object} [params] - 插值参数，如 { count: 3 } 替换 {count}
 * @returns {string}
 */
export function t(key, params) {
  let val = _resolve(_dict, key)
  if (val === undefined) {
    // fallback 到中文
    val = _resolve(LANGS[FALLBACK], key)
  }
  if (val === undefined) return key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      val = val.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return val
}

function _resolve(obj, path) {
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[p]
  }
  return typeof cur === 'string' ? cur : undefined
}

/** 获取当前语言 */
export function getLang() { return _lang }

/** 获取所有可用语言 */
export function getAvailableLangs() {
  return [
    { code: 'zh-CN', label: '简体中文' },
    { code: 'zh-TW', label: '繁體中文' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' },
    { code: 'vi', label: 'Tiếng Việt' },
    { code: 'es', label: 'Español' },
    { code: 'pt', label: 'Português' },
    { code: 'ru', label: 'Русский' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
  ]
}

/** 切换语言 */
export function setLang(lang) {
  if (!LANGS[lang]) return
  _lang = lang
  _dict = LANGS[lang]
  try {
    localStorage.setItem(LANG_KEY, lang)
  } catch {
    /* ignore */
  }
  void patchPanelSettings({ locale: lang })
  _listeners.forEach(fn => { try { fn(lang) } catch {} })
}

/** 监听语言变化 */
export function onLangChange(fn) {
  _listeners.push(fn)
  return () => { _listeners = _listeners.filter(cb => cb !== fn) }
}

/** 初始化：localStorage > navigator.language > fallback */
export function initI18n() {
  let saved = getPanelSetting('locale', '') || localStorage.getItem(LANG_KEY)
  if (!saved) {
    try {
      const legacy = localStorage.getItem(LANG_KEY_LEGACY)
      if (legacy && LANGS[legacy]) {
        localStorage.setItem(LANG_KEY, legacy)
        saved = legacy
      }
    } catch {
      /* ignore */
    }
  }
  if (saved && LANGS[saved]) {
    _lang = saved
    _dict = LANGS[saved]
    return
  }
  // 自动检测浏览器语言
  const nav = navigator.language || navigator.languages?.[0] || ''
  if (nav === 'zh-TW' || nav === 'zh-HK') {
    _lang = 'zh-TW'
  } else if (nav.startsWith('zh')) {
    _lang = 'zh-CN'
  } else if (nav.startsWith('ja')) {
    _lang = 'ja'
  } else if (nav.startsWith('ko')) {
    _lang = 'ko'
  } else if (nav.startsWith('vi')) {
    _lang = 'vi'
  } else if (nav.startsWith('es')) {
    _lang = 'es'
  } else if (nav.startsWith('pt')) {
    _lang = 'pt'
  } else if (nav.startsWith('ru')) {
    _lang = 'ru'
  } else if (nav.startsWith('fr')) {
    _lang = 'fr'
  } else if (nav.startsWith('de')) {
    _lang = 'de'
  } else if (nav.startsWith('en')) {
    _lang = 'en'
  }
  _dict = LANGS[_lang] || LANGS[FALLBACK]
}

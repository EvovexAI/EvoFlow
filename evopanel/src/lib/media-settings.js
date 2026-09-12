/**
 * 创意 / 媒体 API 密钥：持久化在 SQLite（key ``media.credentials``）
 */

import { apiUrl } from './api-client.js'

const API_MEDIA_PATH = '/settings/media'

export const DEFAULT_ENABLED_VENDORS = {
  volcengine: true,
  agnes: false,
  dashscope: false,
  kling: false,
  'volcengine-tts': false,
  aliyun: false,
}

export const DEFAULT_MEDIA_CREDENTIALS = {
  dashscopeApiKey: '',
  dashscopeBaseUrl: '',
  klingAccessKeyId: '',
  klingAccessKeySecret: '',
  klingApiKey: '',
  klingApiBase: '',
  volcengineApiKey: '',
  agnesApiKey: '',
  volcengineArkBaseUrl: '',
  jimengImageModel: 'doubao-seedream-5.0-lite',
  jimengVideoModel: 'doubao-seedance-2.0',
  jimengVideoBaseUrl: '',
  volcengineTtsAppId: '',
  volcengineTtsAccessToken: '',
  volcengineSpeechApiKey: '',
  volcengineTtsCluster: 'volcano_tts',
  volcengineTtsResourceId: 'seed-tts-2.0',
  volcengineTtsSpeaker: 'zh_female_vv_uranus_bigtts',
  volcengineAsrResourceId: 'volc.bigasr.auc_turbo',
  aliyunAccessKeyId: '',
  aliyunAccessKeySecret: '',
  aliyunOssBucket: '',
  aliyunImsEndpoint: '',
  enabledVendors: { ...DEFAULT_ENABLED_VENDORS },
}

/** @type {Record<string, unknown> | null} */
let _cache = null
/** @type {{ image?: string[], video?: string[], voice?: string[] } | null} */
let _availableProviders = null

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

function mergeCredentials(base, patch) {
  const next = { ...base, ...(patch || {}) }
  if (patch?._configured && typeof patch._configured === 'object') {
    next._configured = { ...(base._configured || {}), ...patch._configured }
  }
  if (patch?.enabledVendors && typeof patch.enabledVendors === 'object') {
    next.enabledVendors = { ...(base.enabledVendors || DEFAULT_ENABLED_VENDORS), ...patch.enabledVendors }
  } else if (base.enabledVendors) {
    next.enabledVendors = { ...DEFAULT_ENABLED_VENDORS, ...base.enabledVendors }
  }
  return next
}

async function requestMediaApi(method, body) {
  if (isTauri) {
    const { api } = await import('./tauri-api.js')
    if (method === 'GET') return api.getMediaCredentials()
    return api.patchMediaCredentials(body?.credentials || {})
  }

  const url =
    import.meta.env?.DEV ? `/api${API_MEDIA_PATH}` : apiUrl(API_MEDIA_PATH)

  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `${method} ${API_MEDIA_PATH} failed: ${res.status}`)
  }
  return res.json()
}

export async function fetchMediaCredentials() {
  const data = await requestMediaApi('GET')
  const creds = mergeCredentials({ ...DEFAULT_MEDIA_CREDENTIALS }, data?.credentials || {})
  _cache = creds
  _availableProviders = data?.available_providers || null
  return creds
}

export function getAvailableMediaProviders() {
  return _availableProviders ? { ..._availableProviders } : null
}

export function getCachedMediaCredentials() {
  return _cache ? { ..._cache } : null
}

/**
 * @param {Record<string, string>} patch — 密钥字段留空表示不修改
 */
export async function patchMediaCredentials(patch) {
  const data = await requestMediaApi('PATCH', { credentials: patch || {} })
  const creds = mergeCredentials({ ...DEFAULT_MEDIA_CREDENTIALS }, data?.credentials || {})
  _cache = creds
  _availableProviders = data?.available_providers || null
  return creds
}

export function getEnabledVendors(credentials) {
  return { ...DEFAULT_ENABLED_VENDORS, ...(credentials?.enabledVendors || {}) }
}

export function isFieldConfigured(credentials, field) {
  const cfg = credentials?._configured
  if (cfg && typeof cfg[field] === 'boolean') return cfg[field]
  const v = credentials?.[field]
  return !!(v && String(v).includes('*'))
}

/** 已保存密钥的脱敏展示（如 ****abcd），无则 null */
export function maskedSecretHint(credentials, field) {
  if (!isFieldConfigured(credentials, field)) return null
  const v = String(credentials?.[field] || '').trim()
  if (v && v.includes('*')) return v
  return '已配置'
}

/**
 * 语音（小V）隐式自动开文件的策略闸门。
 *
 * 背景：语音对话里小V自查资料（记忆/技艺/画像、skill、配置、源码）也会触发
 * Read 类工具，之前一律自动开右栏预览——右栏被莫名其妙的内部文件占满，
 * vault 文件还走错通道（file 预览读不到，"file not found" 死标签）。
 *
 * 策略（2026-11-14 与用户定稿）：
 * - 开：用户本轮点名的文件、本轮产物（outputs 段）、图片/视频/音频；
 * - 不开：记忆/技艺/画像（vault 内部资料）、skill/AGENTS/配置、源码自读；
 * - 兜底：未命中一律不开。想主动展示文件走 panel_set 显式通道（不经本闸门）。
 *
 * 纯函数、无副作用、不 import tauri/api —— 便于 vitest 直测。
 */
import { extractEntityAssetRelPath } from '../../react/lib/evo-asset-citation.js'

export type VoiceFileAutoOpenAction = 'open' | 'skip'

export type VoiceFileAutoOpenRoute = 'file' | 'asset'

export type VoiceFileAutoOpenDecision = {
  action: VoiceFileAutoOpenAction
  /** 判定依据，仅供日志/测试归因。 */
  reason: string
  /** file = 工作区文件预览；asset = 实体资产（vault）通道。 */
  route: VoiceFileAutoOpenRoute
}

export type VoiceFileAutoOpenCandidate = {
  /** Read 类工具输入里的目标路径（相对或绝对）。 */
  path: string
  /** 本轮真实用户消息文本（origin=realUser），供「点名」判定；可空。 */
  userTexts?: readonly (string | null | undefined)[] | null
}

function normalizeSlashes(path: string): string {
  return String(path || '').replace(/\\/g, '/').trim()
}

function basenameOf(path: string): string {
  const parts = normalizeSlashes(path).split('/').filter(Boolean)
  return parts[parts.length - 1] || ''
}

function extOf(path: string): string {
  const leaf = basenameOf(path)
  // `.gitignore` / `.env` 这类点开头不是扩展名
  if (/^\.[^.]+$/.test(leaf)) return ''
  const dot = leaf.lastIndexOf('.')
  return dot >= 0 ? leaf.slice(dot + 1).toLowerCase() : ''
}

/** 生成媒体是回答本体，允许开（用户 2026-11-14 拍板：图片和视频可以打开）。 */
const MEDIA_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'heic',
  'avif',
  'ico',
  'mp4',
  'mov',
  'webm',
  'mkv',
  'avi',
  'mp3',
  'wav',
  'aac',
  'm4a',
  'flac',
  'ogg',
  'opus',
])

/** 本轮产出物目录段（对话/语音工作区约定）。 */
const ARTIFACT_SEGMENT_RE = /(?:^|\/)outputs\/(?:[^/]+\/)*[^/]+\.[a-z0-9]{1,12}$/i

/** 内部说明/配置文件名：模型自读的元文档，开了只会占地方。 */
const INTERNAL_DOC_BASENAMES = new Set([
  'agents.md',
  'claude.md',
  'gemini.md',
  'skill.md',
  'tools.md',
  'package.json',
  'tsconfig.json',
  'vitest.config.js',
  'vite.config.js',
])

const INTERNAL_DOC_EXT_RE = /\.(?:lock|env)(?:\.|$)/i

/**
 * 用户本轮是否点名了该文件：消息文本里出现文件名（大小写不敏感）即算。
 * 只做保守的子串匹配，不做主题推断——误开的代价比漏开高。
 */
function isUserMentioned(path: string, userTexts?: readonly (string | null | undefined)[] | null): boolean {
  const name = basenameOf(path).toLowerCase()
  if (!name || name.length < 2) return false
  const full = normalizeSlashes(path).toLowerCase()
  for (const text of userTexts || []) {
    const s = String(text || '').toLowerCase()
    if (!s) continue
    if (s.includes(name) || s.includes(full)) return true
  }
  return false
}

/**
 * 语音隐式 Read 自动开的统一分类。
 * 规则按优先级短路，返回值供调用方决定开/不开与路由。
 */
export function classifyVoiceFileAutoOpen(candidate: VoiceFileAutoOpenCandidate): VoiceFileAutoOpenDecision {
  const raw = String(candidate?.path || '').trim()
  if (!raw) {
    return { action: 'skip', reason: 'no-path', route: 'file' }
  }

  // ① 用户点名 > 一切内部规则：连 vault 资产也开（路由修成 asset 通道）。
  if (isUserMentioned(raw, candidate.userTexts)) {
    const assetRel = extractEntityAssetRelPath(raw)
    return {
      action: 'open',
      reason: 'user-mention',
      route: assetRel ? 'asset' : 'file',
    }
  }

  // ② vault 内部资料：记忆/技艺/画像。小V查资料不等于给用户看。
  const assetRel = extractEntityAssetRelPath(raw)
  if (assetRel) {
    return { action: 'skip', reason: 'vault-internal', route: 'asset' }
  }

  const normalized = normalizeSlashes(raw)

  // ③ 内部工作目录：.evoflow / .zcode / .cursor / .git / node_modules / skills
  if (/(?:^|\/)(?:\.evoflow|\.zcode|\.cursor|\.git|node_modules|skills)\//i.test(normalized)) {
    return { action: 'skip', reason: 'internal-segment', route: 'file' }
  }

  // ④ 内部说明 / 配置文件名
  const leaf = basenameOf(raw).toLowerCase()
  if (INTERNAL_DOC_BASENAMES.has(leaf) || INTERNAL_DOC_EXT_RE.test(leaf)) {
    return { action: 'skip', reason: 'internal-doc', route: 'file' }
  }

  // ⑤ 媒体：图/视频/音频开（多数是本轮生成的回答本体）。
  if (MEDIA_EXTS.has(extOf(raw))) {
    return { action: 'open', reason: 'media', route: 'file' }
  }

  // ⑥ 本轮产物目录（outputs/…）。
  if (ARTIFACT_SEGMENT_RE.test(normalized)) {
    return { action: 'open', reason: 'artifact', route: 'file' }
  }

  // ⑦ 兜底：未命中一律不开。宁可漏开，不要莫名占位。
  return { action: 'skip', reason: 'default-deny', route: 'file' }
}

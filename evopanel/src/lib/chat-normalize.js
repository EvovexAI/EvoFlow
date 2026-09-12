/**
 * 与 chat.js 对齐的历史归一、流式内容提取（供 React 聊天与单测复用）。
 * 不依赖页面级全局变量（如 _toolEventTimes）。
 */

import {
  formatToolDisplayTitle,
  inferToolNameFromArgs,
  isGenericToolName,
  resolveEffectiveToolName,
} from './tool-display.js'
import { buildSubagentTasksFromTools, mergeSubagentTasksMaps } from './subagent-tool-display.js'
import { resolveChatImageSrc } from './chat-image-src.js'
import { apiUrl, apiUrlAsync } from './api-client.js'
import {
  formatSubtaskOutcomeReportOutput,
  formatSubtaskWorkChecklistOutput,
} from './collab-tool-display.js'
import {
  joinTextContentParts,
  mergeStreamReplicaAssistantText,
  normalizeSubtaskResultForDisplay,
} from './subtask-result-display.js'
import { stripToolOutputForDisplay } from './strip-mind-map-hint.js'
import {
  TOOL_APPROVAL_MARKER,
  TOOL_APPROVAL_REPLAY_MARKER,
} from './tool-approval.js'
import { stripResolvedAskClarificationFromRows } from './ask-clarification-pending.js'

export const CHAT_MAIN_SESSION_KEY = 'agent:main:main'

/** 旧版流式曾把 reasoning 拼进正文（**思考：**\\n…）；有独立思考块时从正文剥掉 */
export function stripLegacyEmbeddedReasoningPrefix(text) {
  /* 勿 trimStart：流式 delta 常以 \\n\\n 开头，整块 trim 会吃掉模型换行 */
  return String(text || '').replace(/^\s*\*\*思考[：:]\*\*\s*\n+/, '')
}

/** 控制台排查工具入参：localStorage 设 EVOFLOW_DEBUG_TOOL_STREAM=1 后刷新 */
export function evfToolStreamDebug(label, compactPayload) {
  try {
    if (typeof localStorage === 'undefined' || localStorage.getItem('EVOFLOW_DEBUG_TOOL_STREAM') !== '1') {
      return
    }
    const text =
      typeof compactPayload === 'string'
        ? compactPayload
        : JSON.stringify(compactPayload, (_k, v) => {
            if (typeof v === 'bigint') return String(v)
            return v
          })
     
    console.log(`[evf-tool-stream] ${label} ${text}`)
  } catch {
    /* ignore */
  }
}

function _evfS(s, max) {
  if (s == null) return ''
  const t = String(s)
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/** 仅存常见标量字段的短摘要，不进整段 JSON */
function _evfParamsBrief(inp, opts = {}) {
  const valMax = opts.valMax ?? 64
  const maxKeys = opts.maxKeys ?? 6
  if (inp == null) return null
  if (typeof inp === 'string') {
    const t = inp.trim()
    return t.length > valMax ? `${t.slice(0, valMax)}…(len=${t.length})` : t
  }
  if (typeof inp !== 'object' || Array.isArray(inp)) return _evfS(inp, valMax)
  const out = {}
  const keys = Object.keys(inp).sort()
  for (let i = 0; i < keys.length && i < maxKeys; i++) {
    const k = keys[i]
    const v = inp[k]
    if (typeof v === 'string') out[k] = v.length > valMax ? `${v.slice(0, valMax)}…(len=${v.length})` : v
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (Array.isArray(v)) out[k] = `[${v.length}]`
    else if (v && typeof v === 'object') out[k] = '{}'
    else out[k] = v
  }
  if (keys.length > maxKeys) out._ = `+${keys.length - maxKeys}keys`
  return out
}

export function evfBriefToolRow(tool) {
  if (!tool || typeof tool !== 'object') return { i: '?', n: '?', p: null }
  const id = tool.id ?? tool.tool_call_id
  const nm = tool.name ?? tool.tool_name ?? tool.toolName ?? ''
  return {
    i: _evfS(id, 40),
    n: _evfS(nm, 36),
    p: _evfParamsBrief(tool.input ?? tool.args ?? null),
  }
}

/** 服务端原始 tool_calls 项摘要（未到 merge 层） */
function _evfBriefRawTc(tc) {
  if (!tc || typeof tc !== 'object') return {}
  const id = tc.id ?? tc.tool_call_id
  const nm = tc.name ?? tc.tool_name ?? (tc.function && tc.function.name) ?? ''
  const faRaw =
    tc.function &&
    typeof tc.function === 'object' &&
    typeof tc.function.arguments === 'string'
      ? tc.function.arguments
      : ''
  const fa = faRaw.trim()
  let fh
  if (fa) fh = `[L=${fa.length}]${fa.length > 80 ? `${fa.slice(0, 72)}…` : fa}`
  const args = tc.args
  const ak = args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args).slice(0, 14) : []
  const inp = tc.input
  const ik = inp && typeof inp === 'object' && !Array.isArray(inp) ? Object.keys(inp).slice(0, 14) : []
  const kw = tc.kwargs
  const kk = kw && typeof kw === 'object' && !Array.isArray(kw) ? Object.keys(kw).slice(0, 14) : []
  return {
    i: id != null ? _evfS(id, 40) : '',
    n: _evfS(nm, 36),
    argK: ak.length ? ak : undefined,
    inputK: ik.length ? ik : undefined,
    kwK: kk.length ? kk : undefined,
    faLen: faRaw.length > 0 ? faRaw.length : undefined,
    fnStr: fh,
  }
}

export function evfBriefToolRowsMerged(tools) {
  const arr = Array.isArray(tools) ? tools : []
  return arr.slice(0, 32).map((t) => evfBriefToolRow(t))
}

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export function stripAnsi(text) {
  if (!text) return ''
  const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g')
  return text.replace(ANSI_RE, '')
}

/** 去掉模型/协作侧注入的「身份、协作阶段」等行（非 XML，仅行首匹配） */
export function stripAgentMetaLines(text) {
  if (!text) return ''
  const lines = text.split('\n')
  const out = []
  for (const line of lines) {
    const s = line.trim()
    if (s && /^(身份|核心任务|工作模式|协作阶段|技能|近期操作)[:：]/.test(s)) continue
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function stripThinkingTags(text) {
  const safe = stripAnsi(text)
  const stripped = safe
    .replace(/<\s*think(?:ing)?\s*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/gi, '')
    .replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, '')
    .replace(/\[Queued messages while agent was busy\]\s*---\s*Queued #\d+\s*/gi, '')
    /* CollabPhaseMiddleware 注入，仅供模型用，不在 UI 展示 */
    .replace(/<\s*collab_phase_context\s*>[\s\S]*?<\s*\/\s*collab_phase_context\s*>/gi, '')
    .trim()
  return stripAgentMetaLines(stripped)
}

/**
 * 流式 delta 专用：去掉 thinking/XML 噪声，**不 trim**，保留片段首尾换行（勿对每块 stripThinkingTags）。
 */
export function stripThinkingTagsPreserveNewlines(text) {
  return stripAnsi(String(text || ''))
    .replace(/<\s*think(?:ing)?\s*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/gi, '')
    .replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, '')
    .replace(/\[Queued messages while agent was busy\]\s*---\s*Queued #\d+\s*/gi, '')
    .replace(/<\s*collab_phase_context\s*>[\s\S]*?<\s*\/\s*collab_phase_context\s*>/gi, '')
}

export function normalizeTime(raw) {
  if (!raw) return null
  if (raw instanceof Date) return raw.getTime()
  if (typeof raw === 'string') {
    const num = Number(raw)
    if (!Number.isNaN(num)) return normalizeTime(num)
    const parsed = Date.parse(raw)
    return Number.isNaN(parsed) ? null : parsed
  }
  if (typeof raw === 'number' && raw < 1e12) return raw * 1000
  return raw
}

function resolveToolTime(_toolId, messageTimestamp) {
  return normalizeTime(messageTimestamp) || null
}

/** 将工具参数统一为对象/原始值；字符串 `"{}"` 视为空 */
function splitConcatenatedJsonObjects(s) {
  const t = String(s || '').trim()
  if (!t || !t.includes('}{')) return t ? [t] : []
  const parts = []
  let depth = 0
  let start = -1
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        parts.push(t.slice(start, i + 1))
        start = -1
      }
    }
  }
  return parts.length ? parts : [t]
}

function parseToolInputValue(x) {
  if (x == null) return null
  if (typeof x === 'string') {
    const t = x.trim()
    if (t === '' || t === '{}' || t === '[]') return null
    try {
      const p = JSON.parse(t)
      if (typeof p === 'object' && p !== null) return p
      return x
    } catch {
      const blobs = splitConcatenatedJsonObjects(t)
      if (blobs.length > 1) {
        for (let i = blobs.length - 1; i >= 0; i--) {
          try {
            const p = JSON.parse(blobs[i])
            if (typeof p === 'object' && p !== null && !Array.isArray(p)) return p
          } catch {
            /* try earlier blob */
          }
        }
      }
      return x
    }
  }
  return x
}

/**
 * 流式 function.arguments 尚未形成合法 JSON 时，从已出现的片段里抽出 path 类字段，供 read_file 等折叠摘要。
 */
function unescapePartialJsonString(s) {
  let out = ''
  const raw = String(s || '')
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      const n = raw[i + 1]
      if (n === 'n') {
        out += '\n'
        i++
        continue
      }
      if (n === 't') {
        out += '\t'
        i++
        continue
      }
      if (n === 'r') {
        out += '\r'
        i++
        continue
      }
      if (n === '"') {
        out += '"'
        i++
        continue
      }
      if (n === '\\') {
        out += '\\'
        i++
        continue
      }
      out += n
      i++
      continue
    }
    out += raw[i]
  }
  return out
}

function extractPathLikeFromPartialJsonString(s) {
  const t = stripAnsi(String(s || '')).trim()
  if (!t.startsWith('{')) return null
  for (const key of ['path', 'target_file', 'file_path', 'filepath', 'filePath']) {
    const path = extractJsonStringValueForKey(t, key)
    if (typeof path === 'string' && path.trim()) return { path: path.trim() }
  }
  return null
}

/** 从 `"key": "` 起扫描 JSON 字符串值（支持未闭合的流式尾；仅匹配根对象键） */
function extractJsonStringValueForKey(t, key) {
  const text = String(t || '')
  if (!text) return null
  const keyPat = `"${key}"`
  const keyPatLower = keyPat.toLowerCase()
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      if (depth === 1 && text.slice(i, i + keyPat.length).toLowerCase() === keyPatLower) {
        let j = i + keyPat.length
        while (j < text.length && /\s/.test(text[j])) j += 1
        if (text[j] !== ':') {
          inString = true
          continue
        }
        j += 1
        while (j < text.length && /\s/.test(text[j])) j += 1
        if (text[j] !== '"') return null
        j += 1
        let raw = ''
        while (j < text.length) {
          const c = text[j]
          if (c === '\\' && j + 1 < text.length) {
            raw += c + text[j + 1]
            j += 2
            continue
          }
          if (c === '"') break
          raw += c
          j += 1
        }
        return unescapePartialJsonString(raw)
      }
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === '[') depth += 1
    else if (ch === ']') depth = Math.max(0, depth - 1)
  }
  return null
}

/** 从 `"key": 123` 或 `"key": "123"` 抽取数值（流式未闭合 JSON 可用） */
function extractJsonNumberValueForKey(t, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*("((?:[^"\\\\]|\\\\.)*)"|(-?\\d+))`, 'i')
  const m = re.exec(t)
  if (!m) return null
  if (m[2] != null) return unescapePartialJsonString(m[2]).trim()
  if (m[3] != null) return m[3]
  return null
}

function extractReadRangeLikeFromPartialJsonString(s) {
  const t = stripAnsi(String(s || '')).trim()
  if (!t.startsWith('{')) return null
  const out = {}
  for (const key of ['offset', 'limit', 'start_line', 'end_line']) {
    const val = extractJsonNumberValueForKey(t, key)
    if (val != null && String(val).trim() !== '') out[key] = val
  }
  return Object.keys(out).length ? out : null
}

/**
 * 流式 function.arguments 未闭合时，从 JSON 片段抽出 content / new_string 等正文字段。
 * @param {string} s
 * @returns {{ content?: string; new_string?: string } | null}
 */
/**
 * 流式 plan 的 function.arguments 未闭合时，尽量抽出 goal（有 goal 即可先展示底部条）。
 * @param {string} s
 */
export function extractPlanLikeFromPartialJsonString(s) {
  const t = stripAnsi(String(s || '')).trim()
  if (!t.startsWith('{')) return null
  const goal = extractJsonStringValueForKey(t, 'goal')
  if (!goal?.trim()) return null
  let steps = null
  const stepsIdx = t.search(/"steps"\s*:\s*\[/)
  if (stepsIdx >= 0) {
    let depth = 0
    let started = false
    let end = stepsIdx
    for (let i = stepsIdx; i < t.length; i++) {
      const c = t[i]
      if (c === '[') {
        depth += 1
        started = true
      } else if (c === ']') {
        depth -= 1
        if (started && depth === 0) {
          end = i + 1
          break
        }
      }
    }
    const slice = t.slice(stepsIdx, end > stepsIdx ? end : t.length)
    const arrStart = slice.indexOf('[')
    if (arrStart >= 0) {
      let arrText = slice.slice(arrStart)
      if (!arrText.trimEnd().endsWith(']')) arrText = `${arrText.trimEnd()}]`
      try {
        const parsed = JSON.parse(arrText)
        if (Array.isArray(parsed) && parsed.length) steps = parsed
      } catch {
        /* 流式未闭合 */
      }
    }
  }
  if (!Array.isArray(steps) || !steps.length) return null
  return {
    goal: goal.trim(),
    steps,
    validation: [],
    open_questions: '无',
  }
}

export function extractContentLikeFromPartialJsonString(s) {
  const t = stripAnsi(String(s || '')).trim()
  if (!t.startsWith('{')) return null
  for (const key of ['content', 'new_string', 'new_str', 'text']) {
    const val = extractJsonStringValueForKey(t, key)
    if (val != null && val !== '') {
      return key === 'content' ? { content: val } : { content: val, [key]: val }
    }
  }
  return null
}

/**
 * 部分推理模型会把内部 wire 形态 ``{"content":"…","reasoning":"…"}`` 原样写进正文。
 * @returns {{ content: string | null, reasoning: string | null } | null}
 */
export function parseAssistantContentJsonEnvelope(text) {
  const trimmed = stripAnsi(String(text ?? '')).trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (!Object.prototype.hasOwnProperty.call(parsed, 'content')) return null
    const content = typeof parsed.content === 'string' ? parsed.content : null
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : null
    return { content, reasoning }
  } catch {
    const loose = extractContentLikeFromPartialJsonString(trimmed)
    if (!loose?.content) return null
    return { content: String(loose.content), reasoning: null }
  }
}

/** 用户可见 assistant 正文：剥掉 ``content_json`` 形态的 JSON 外壳，只留 ``content`` 字段 */
export function unwrapAssistantContentJsonEnvelope(text) {
  const env = parseAssistantContentJsonEnvelope(text)
  if (env && env.content != null) return env.content
  return String(text ?? '')
}

/**
 * 流式 function.arguments 未闭合时，从 JSON 片段抽出 command（terminal/bash 折叠摘要）。
 * @param {string} s
 * @returns {{ command?: string } | null}
 */
export function extractCommandLikeFromPartialJsonString(s) {
  const t = stripAnsi(String(s || '')).trim()
  if (!t.startsWith('{')) return null
  for (const key of ['command', 'cmd']) {
    const val = extractJsonStringValueForKey(t, key)
    if (val != null && val !== '') return { command: val }
  }
  return null
}

/** 工具行上可用的原始参数字符串（流式 JSON 片段） */
export function getToolStreamingArgumentsRaw(tool) {
  if (!tool || typeof tool !== 'object') return ''
  const tc = tool
  const stringChunks = []
  const fn = tc.function
  const fa =
    fn && typeof fn === 'object' && typeof fn.arguments === 'string' ? fn.arguments : ''
  if (fa.trim()) stringChunks.push(fa)
  if (typeof tc.arguments === 'string' && tc.arguments.trim()) stringChunks.push(tc.arguments)
  if (typeof tc.input === 'string' && tc.input.trim()) stringChunks.push(tc.input)
  if (typeof tc.args === 'string' && tc.args.trim()) stringChunks.push(tc.args)
  const bestStr = stringChunks.sort((a, b) => b.length - a.length)[0] || ''
  const faTrim = stripAnsi(fa).trim()
  if (faTrim.startsWith('{') && !faTrim.endsWith('}')) return fa
  const obj = getToolInputObjectFromRow(tool)
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    try {
      const objJson = JSON.stringify(obj)
      if (objJson.length > bestStr.length) return objJson
    } catch {
      /* ignore */
    }
  }
  return bestStr
}

/** tool_call 顶层携带的路径字段（部分网关序列化 args 为空但 path 在旁） */
function topLevelPathLikeFromToolCall(tc) {
  if (!tc || typeof tc !== 'object') return null
  const keys = ['target_file', 'path', 'file_path', 'filepath', 'filePath']
  for (const k of keys) {
    const v = tc[k]
    if (typeof v === 'string' && v.trim()) return { path: v.trim() }
  }
  return null
}

/**
 * 合并顶层 path + 未闭合 JSON 字符串里已出现的 path，供 resolvePrimaryToolCallArgs 与 UI 共用。
 * @param {unknown} resolved
 * @param {Record<string, unknown>} tc
 * @param {unknown} [fa] function.arguments 原串（resolved 已为解析结果时仍可用来抽片段）
 */
function extractSessionIdLikeFromPartialJsonString(s) {
  const t = stripAnsi(String(s || '')).trim()
  if (!t.startsWith('{')) return null
  const val = extractJsonStringValueForKey(t, 'session_id')
  if (val != null && val !== '') return { session_id: val }
  return null
}

function looseFieldsFromFaString(fa) {
  if (fa == null || typeof fa !== 'string' || !fa.trim()) {
    return { path: null, readRange: null, content: null, command: null, session: null }
  }
  return {
    path: extractPathLikeFromPartialJsonString(fa),
    readRange: extractReadRangeLikeFromPartialJsonString(fa),
    content: extractContentLikeFromPartialJsonString(fa),
    command: extractCommandLikeFromPartialJsonString(fa),
    session: extractSessionIdLikeFromPartialJsonString(fa),
  }
}

function mergeLooseReadRangeIntoInputObject(out, looseReadRange) {
  if (!looseReadRange || typeof looseReadRange !== 'object') return out
  let merged = out && typeof out === 'object' && !Array.isArray(out) ? { ...out } : {}
  for (const k of ['offset', 'limit', 'start_line', 'end_line']) {
    if (looseReadRange[k] == null || String(looseReadRange[k]).trim() === '') continue
    const nc = String(looseReadRange[k]).trim()
    const pc = merged[k] != null ? String(merged[k]).trim() : ''
    if (!pc) {
      merged = { ...merged, [k]: looseReadRange[k] }
      continue
    }
    if (nc.length > pc.length) merged = { ...merged, [k]: looseReadRange[k] }
  }
  return merged
}

function mergeLooseFieldsIntoInputObject(base, loosePath, looseContent, looseCommand, looseSession, looseReadRange) {
  let out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  if (loosePath?.path && !String(out.path || out.target_file || out.file_path || '').trim()) {
    out = { ...loosePath, ...out }
  }
  if (looseContent) {
    for (const k of ['content', 'new_string', 'new_str', 'text']) {
      const nc = typeof looseContent[k] === 'string' ? looseContent[k] : ''
      if (!nc) continue
      const pc = typeof out[k] === 'string' ? out[k] : ''
      if (nc.length > pc.length) out = { ...out, [k]: nc }
    }
  }
  if (looseCommand?.command) {
    const nc = String(looseCommand.command || '')
    const pc = typeof out.command === 'string' ? out.command : ''
    if (nc.length > pc.length) out = { ...out, command: nc }
  }
  if (looseSession?.session_id) {
    const nc = String(looseSession.session_id || '')
    const pc = typeof out.session_id === 'string' ? out.session_id : ''
    if (nc.length > pc.length) out = { ...out, session_id: nc }
  }
  return mergeLooseReadRangeIntoInputObject(out, looseReadRange)
}

function attachTopLevelAndPartialPath(resolved, tc, fa) {
  const top = topLevelPathLikeFromToolCall(tc)
  const { path: loosePath, readRange: looseReadRange, content: looseContent, command: looseCommand, session: looseSession } =
    looseFieldsFromFaString(fa)
  const partialFromResolved =
    typeof resolved === 'string' ? extractPathLikeFromPartialJsonString(resolved) : null
  const readRangeFromResolved =
    typeof resolved === 'string' ? extractReadRangeLikeFromPartialJsonString(resolved) : null
  const mergedReadRange = mergeLooseReadRangeIntoInputObject(readRangeFromResolved || {}, looseReadRange)
  const partialFromFa = loosePath
  const partial = partialFromResolved || partialFromFa
  const partialSession =
    typeof resolved === 'string'
      ? extractSessionIdLikeFromPartialJsonString(resolved) || looseSession
      : looseSession

  if (typeof resolved === 'object' && resolved != null && !Array.isArray(resolved)) {
    if (!isEmptyToolInput(resolved)) {
      const merged = top ? { ...top, ...resolved } : { ...resolved }
      return mergeLooseFieldsIntoInputObject(merged, loosePath, looseContent, looseCommand, looseSession, mergedReadRange)
    }
    if (top || partial) {
      return mergeLooseFieldsIntoInputObject(
        { ...(top || {}), ...(partial || {}) },
        loosePath,
        looseContent,
        looseCommand,
        looseSession,
        mergedReadRange,
      )
    }
    return mergeLooseFieldsIntoInputObject(resolved, loosePath, looseContent, looseCommand, looseSession, mergedReadRange)
  }
  if (typeof resolved === 'string') {
    const partialCmd =
      extractCommandLikeFromPartialJsonString(resolved) ||
      (looseCommand?.command ? looseCommand : null)
    if (partial) {
      const base = top ? { ...top, ...partial } : { ...partial }
      return mergeLooseFieldsIntoInputObject(base, loosePath, looseContent, partialCmd, partialSession, mergedReadRange)
    }
    if (partialCmd) {
      return mergeLooseFieldsIntoInputObject(top || {}, loosePath, looseContent, partialCmd, partialSession, mergedReadRange)
    }
    if (partialSession?.session_id) {
      return mergeLooseFieldsIntoInputObject(top || {}, loosePath, looseContent, partialCmd, partialSession, mergedReadRange)
    }
    if (Object.keys(mergedReadRange || {}).length) {
      return mergeLooseFieldsIntoInputObject(top || {}, loosePath, looseContent, partialCmd, partialSession, mergedReadRange)
    }
    if (top) return top
    return resolved
  }
  if (resolved == null) {
    if (partial) {
      return mergeLooseFieldsIntoInputObject(
        top ? { ...top, ...partial } : { ...partial },
        loosePath,
        looseContent,
        looseCommand,
        looseSession,
        mergedReadRange,
      )
    }
    if (looseCommand?.command) {
      return mergeLooseFieldsIntoInputObject(top || {}, loosePath, looseContent, looseCommand, looseSession, mergedReadRange)
    }
    if (looseSession?.session_id) {
      return mergeLooseFieldsIntoInputObject(top || {}, loosePath, looseContent, looseCommand, looseSession, mergedReadRange)
    }
    if (Object.keys(mergedReadRange || {}).length) {
      return mergeLooseFieldsIntoInputObject(top || {}, loosePath, looseContent, looseCommand, looseSession, mergedReadRange)
    }
    return top
  }
  return resolved
}

/** 供 UI 解析工具入参对象（含 JSON 字符串），与流式 upsert 同源 */
export function getToolInputObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const row = raw
    const hasToolMeta =
      row.tool_name != null ||
      row.toolName != null ||
      row.name != null ||
      row.tool_call_id != null ||
      row.id != null ||
      row.output_text != null ||
      row.output != null
    const hasNestedInput = row.input != null || row.args != null
    if (hasToolMeta && hasNestedInput) {
      return getToolInputObject(row.input ?? row.args)
    }
  }
  const v = parseToolInputValue(raw)
  if (v != null && typeof v === 'object' && !Array.isArray(v)) {
    if (Object.keys(v).length > 0) return v
  }
  const src = typeof raw === 'string' ? raw : typeof v === 'string' ? v : ''
  const loosePath = src.trim() ? extractPathLikeFromPartialJsonString(src) : null
  const looseReadRange = src.trim() ? extractReadRangeLikeFromPartialJsonString(src) : null
  const looseContent = src.trim() ? extractContentLikeFromPartialJsonString(src) : null
  const looseCommand = src.trim() ? extractCommandLikeFromPartialJsonString(src) : null
  const looseSession = src.trim() ? extractSessionIdLikeFromPartialJsonString(src) : null
  if (loosePath || looseReadRange || looseContent || looseCommand || looseSession) {
    return mergeLooseReadRangeIntoInputObject(
      {
        ...(loosePath || {}),
        ...(looseContent || {}),
        ...(looseCommand || {}),
        ...(looseSession || {}),
      },
      looseReadRange,
    )
  }
  if (v != null && typeof v === 'object' && !Array.isArray(v)) return v
  return null
}

/** 从工具行读取入参（支持 tool_name + input + output_text 形态） */
export function getToolInputObjectFromRow(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null
  const streamMerged = resolvePrimaryToolCallArgs(tool)
  const parsed = getToolInputObject(streamMerged)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
    return parsed
  }
  const direct = tool.input ?? tool.args ?? tool.parameters ?? tool.arguments ?? tool.kwargs
  const fromDirect = getToolInputObject(direct)
  return fromDirect ?? parsed
}

/** 落库 tool_calls：合并 input / function.arguments，并在入参缺失时从输出回填 path 等字段 */
export function serializeToolCallArgsForPersist(toolOrCall) {
  if (!toolOrCall || typeof toolOrCall !== 'object' || Array.isArray(toolOrCall)) return {}
  let args = getToolInputObjectFromRow(toolOrCall)
  if (isEmptyToolInput(args)) {
    const inferred = inferToolInputFromOutput(
      toolOrCall.name ?? toolOrCall.tool_name ?? toolOrCall.toolName,
      toolOrCall.output ?? toolOrCall.output_text ?? toolOrCall.content,
    )
    if (inferred && !isEmptyToolInput(inferred)) args = inferred
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) return { ...args }
  return {}
}

/** UI / 中断落库的 tool_calls 数组 → 可 JSON 化的 { id, name, args } 列表 */
export function serializeToolCallsForPersist(tools) {
  if (!Array.isArray(tools) || !tools.length) return []
  const out = []
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw
    const id = o.id != null ? String(o.id).trim() : String(o.tool_call_id || '').trim()
    const name = String(o.name || o.tool_name || o.toolName || '').trim()
    if (!id && !name) continue
    const args = serializeToolCallArgsForPersist(o)
    out.push({
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      args,
    })
  }
  return out
}

/** 目标方案工具名（含历史别名 propose_hosted_agent） */
export const GOAL_PROPOSAL_TOOL_NAMES = new Set(['propose_goal', 'propose_hosted_agent'])

export function isGoalProposalToolName(name) {
  const nm = String(name || '').trim().toLowerCase()
  return GOAL_PROPOSAL_TOOL_NAMES.has(nm)
}

/**
 * Gateway-side denylist mirror (see evoflow.tools.chat_panel_tools).
 * Live SSE 已在 Gateway 过滤；落库 transcript 仍含完整工具，历史视图须再滤一遍。
 */
export const CHAT_PANEL_HIDDEN_TOOL_NAMES = new Set([
  // ask_clarification / propose_goal：Gateway 仍下发，供询问条与目标确认条
  'present_files',
  'present_file',
  'todo_write',
  'todo_reminder',
  'scenario',
  'scenario_activation',
])

/** 主气泡不展示（侧栏 / 专用 UI）；SSE 与 DB 历史均适用。 */
export function toolOmitFromChatPanel(tool) {
  if (!tool || typeof tool !== 'object') return true
  const n = String(resolveEffectiveToolName(tool) || '').trim().toLowerCase()
  if (!n || n === 'tool') return true
  if (n.startsWith('scheduler:')) return true
  const args = getToolInputObjectFromRow(tool)
  const inv = String(args?.invocation_source || '').trim().toLowerCase()
  if (inv === 'prefetch' || inv === 'scheduler') return true
  if (tool._workerDisplayExpand === true) return false
  if (isWorkerNestedFileTool(tool) || isWorkerNestedSearchTool(tool)) return true
  return CHAT_PANEL_HIDDEN_TOOL_NAMES.has(n)
}

/** worker 派生子行（含 search / file 批次 prefetch；落库保留供 diff / 搜索回填） */
export function isWorkerNestedFileTool(tool) {
  if (!tool || typeof tool !== 'object') return false
  const id = String(tool.tool_call_id ?? tool.id ?? '').trim()
  if (/^worker-\d+-/.test(id)) return true
  if (/^worker-\d+-[^:]+:search:\d+$/.test(id)) return true
  const args = getToolInputObjectFromRow(tool)
  const inv = String(args?.invocation_source || '').trim().toLowerCase()
  if (inv === 'worker') return true
  const parentId = String(args?.parent_worker_tool_call_id || '').trim()
  return Boolean(parentId)
}

/** worker 派生的 search/locate 子行：主列表只展示搜索内容 */
export function isWorkerNestedSearchTool(tool) {
  if (!tool || typeof tool !== 'object') return false
  const id = String(tool.tool_call_id ?? tool.id ?? '').trim()
  if (/^worker-\d+-[^:]+:search:\d+$/.test(id)) return true
  const args = getToolInputObjectFromRow(tool)
  const parentId = String(args?.parent_worker_tool_call_id || '').trim()
  const inv = String(args?.invocation_source || '').trim().toLowerCase()
  if (!parentId && inv !== 'worker') return false
  const action = String(args?.action || '').trim().toLowerCase()
  if (action === 'search' || action === 'locate') return true
  const n = String(resolveEffectiveToolName(tool) || '').trim().toLowerCase()
  return n === 'search_code_index' || n === 'find' || n === 'find_file'
}

/** 按 tool_call_id / id 在 tools 数组中查找工具行 */
export function findToolRowByCallId(tools, id) {
  const want = String(id || '').trim()
  if (!want || !Array.isArray(tools)) return null
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue
    const rid = raw.id != null && String(raw.id).trim() !== '' ? String(raw.id).trim() : ''
    const rtc =
      raw.tool_call_id != null && String(raw.tool_call_id).trim() !== ''
        ? String(raw.tool_call_id).trim()
        : ''
    if (rid === want || rtc === want) return raw
  }
  return null
}

/** tools 段内是否含主气泡可见工具行 */
export function toolsSegmentHasVisibleChatTools(segment, tools) {
  if (!segment || segment.kind !== 'tools' || !Array.isArray(segment.ids)) return false
  for (const raw of segment.ids) {
    const id = String(raw || '').trim()
    if (!id) continue
    const row = findToolRowByCallId(tools, id)
    if (row && !toolOmitFromChatPanel(row)) return true
  }
  return false
}

export function timelineHasVisibleChatTools(segments, tools) {
  if (!Array.isArray(segments)) return false
  return segments.some((s) => toolsSegmentHasVisibleChatTools(s, tools))
}

/** 本轮是否有主气泡可见工具（SSE 已滤；DB 历史须配合 filterToolsForChatPanelDisplay） */
export function turnHasVisibleChatTools(tools, segments) {
  if (
    Array.isArray(tools) &&
    tools.some((raw) => raw && typeof raw === 'object' && !toolOmitFromChatPanel(raw))
  ) {
    return true
  }
  return timelineHasVisibleChatTools(segments, tools)
}

export function activityToolIdsVisibleInChat(ids, tools) {
  if (!Array.isArray(ids)) return false
  for (const raw of ids) {
    const id = String(raw || '').trim()
    if (!id) continue
    const row = findToolRowByCallId(tools, id)
    if (row && !toolOmitFromChatPanel(row)) return true
  }
  return false
}

/** 从 assistant 行 tools 数组去掉侧栏 / 内部专用工具（历史落库回放） */
export function filterToolsForChatPanelDisplay(tools) {
  if (!Array.isArray(tools) || !tools.length) return tools || []
  return tools.filter((t) => t && typeof t === 'object' && !toolOmitFromChatPanel(t))
}

/** 从 display_segments 去掉 hidden 工具 id；空 tools 段丢弃 */
export function filterDisplaySegmentsForChatPanel(segments, tools) {
  if (!Array.isArray(segments) || !segments.length) return segments
  const lookup = Array.isArray(tools) ? tools : []
  return segments
    .map((seg) => {
      if (!seg || seg.kind !== 'tools' || !Array.isArray(seg.ids)) return seg
      const ids = seg.ids.filter((raw) => {
        const id = String(raw || '').trim()
        if (!id) return false
        const row = findToolRowByCallId(lookup, id)
        if (!row) return true
        return !toolOmitFromChatPanel(row)
      })
      if (!ids.length) return null
      if (ids.length === seg.ids.length) return seg
      return { ...seg, ids }
    })
    .filter(Boolean)
}

/** 流式进行中：主对话区隐藏调度内部工具行（用户可见工具一律单行摘要 + 弹窗详情） */
export function toolOmitFromStreamingChatPanel(tool) {
  if (!tool || typeof tool !== 'object') return true
  const n = String(resolveEffectiveToolName(tool) || '').trim().toLowerCase()
  if (!n || n === 'tool') return true
  const id = String(tool.tool_call_id ?? tool.id ?? '').trim()
  if (id.includes(':post-search-read:')) return true
  const args = getToolInputObjectFromRow(tool)
  const inv = String(args?.invocation_source || '').trim().toLowerCase()
  if (inv === 'post_search' || inv === 'prefetch' || inv === 'scheduler') return true
  return false
}

function isEmptyToolInput(x) {
  const v = parseToolInputValue(x)
  if (v == null) return true
  if (Array.isArray(v) && v.length === 0) return true
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return true
  return false
}

/**
 * LangGraph / OpenAI 流式 tool_call：顶层 `args` 常为占位 `{}`，真实参数在 `function.arguments`（JSON 字符串）。
 * 若 `args` 已非空对象则优先用 `args`（避免与已合并字段冲突）。
 */ 
function resolvePrimaryToolCallArgs(tc) {
  if (!tc || typeof tc !== 'object') return null
  const direct = tc.args ?? tc.input ?? tc.parameters ?? tc.arguments ?? tc.kwargs ?? null
  const fn = tc.function && typeof tc.function === 'object' ? tc.function : null
  const fa = fn && Object.prototype.hasOwnProperty.call(fn, 'arguments') ? fn.arguments : undefined
  let resolved
  if (!isEmptyToolInput(direct)) {
    resolved = direct
  } else if (typeof fa === 'string' && fa.trim()) {
    try {
      const parsed = JSON.parse(fa)
      resolved = parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fa
    } catch {
      resolved = fa
    }
  } else if (fa != null && typeof fa === 'object' && !Array.isArray(fa)) {
    resolved = fa
  } else {
    resolved = direct
  }
  return attachTopLevelAndPartialPath(resolved, tc, fa)
}

/** 流式 tool_call：合并 function.arguments 累计 JSON */
function mergeToolFunctionField(prev, next) {
  if (!next || typeof next !== 'object') return prev
  if (!prev || typeof prev !== 'object') return { ...next }
  const fn = { ...prev, ...next }
  const ps = prev.arguments != null ? String(prev.arguments) : ''
  const ns = next.arguments != null ? String(next.arguments) : ''
  const psx = stripAnsi(ps).trimEnd()
  const nsx = stripAnsi(ns).trimEnd()
  if (psx || nsx) {
    let merged
    if (!nsx) merged = psx
    else if (!psx) merged = nsx
    else if (nsx.startsWith(psx)) merged = nsx
    else if (psx.startsWith(nsx)) merged = psx
    else merged = mergeStreamingToolCallArgStrings(psx, nsx)
    fn.arguments = merged
  }
  return fn
}

function mergeToolArgumentsString(prev, next) {
  const ps = stripAnsi(String(prev || '')).trimEnd()
  const ns = stripAnsi(String(next || '')).trimEnd()
  if (!ns) return ps
  if (!ps) return ns
  if (ns.startsWith(ps)) return ns
  if (ps.startsWith(ns)) return ps
  return mergeStreamingToolCallArgStrings(ps, ns)
}

function hydrateToolInputContentFromStreamingRaw(tool) {
  if (!tool || typeof tool !== 'object') return
  const raw = getToolStreamingArgumentsRaw(tool)
  if (!raw) return
  const input = parseToolInputValue(tool.input)
  const base =
    input != null && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {}
  let changed = false

  const looseContent = extractContentLikeFromPartialJsonString(raw)
  if (looseContent?.content) {
    const pc = typeof base.content === 'string' ? base.content.length : 0
    if (looseContent.content.length > pc) {
      base.content = looseContent.content
      changed = true
    }
  }

  const loosePath = extractPathLikeFromPartialJsonString(raw)
  if (loosePath?.path) {
    const pp = String(base.path || base.target_file || base.file_path || '')
    if (loosePath.path.length > pp.length) {
      base.path = loosePath.path
      changed = true
    }
  }

  const looseCommand = extractCommandLikeFromPartialJsonString(raw)
  if (looseCommand?.command) {
    const pc = typeof base.command === 'string' ? base.command.length : 0
    if (looseCommand.command.length > pc) {
      base.command = looseCommand.command
      changed = true
    }
  }

  const looseSession = extractSessionIdLikeFromPartialJsonString(raw)
  if (looseSession?.session_id) {
    const ps = typeof base.session_id === 'string' ? base.session_id.length : 0
    if (looseSession.session_id.length > ps) {
      base.session_id = looseSession.session_id
      changed = true
    }
  }

  if (changed) tool.input = base
}

/** 从流式/多形态 entry 上解析工具名（供 upsert 合并时写回 target.name） */
function resolveEntryToolName(entry) {
  if (!entry || typeof entry !== 'object') return null
  const n = entry.name ?? entry.tool_name ?? entry.toolName
  if (n != null && String(n).trim()) return String(n).trim()
  const fn = entry.function && typeof entry.function === 'object' ? entry.function.name : null
  if (fn != null && String(fn).trim()) return String(fn).trim()
  return null
}

/**
 * LangGraph delta 常把整条 tool_call（args + function.arguments）丢进 upsert，但无 `input` 字段；
 * 仅读 entry.input 会漏掉流式参数，气泡里一直显示空入参。
 */
function pickIncomingToolInputForUpsert(entry) {
  if (!entry || typeof entry !== 'object') return null
  const resolved = resolvePrimaryToolCallArgs(entry)
  if (!isEmptyToolInput(resolved)) return resolved
  if (entry.input !== undefined && entry.input !== null) return entry.input
  if (entry.args !== undefined && entry.args !== null) return entry.args
  return null
}

/**
 * 原始 tool_call 一行诊断（与 normalize / upsert 同源解析），便于区分「网关就没下发参数」还是「合并丢了」。
 * 仅 console：配合 localStorage EVOFLOW_DEBUG_TOOL_STREAM=1。
 */
export function evfDiagnoseRawToolCall(tc) {
  if (!tc || typeof tc !== 'object') return {}
  const raw = _evfBriefRawTc(tc)
  let normInput = resolvePrimaryToolCallArgs(tc)
  if (typeof normInput === 'string') {
    const t = normInput.trim()
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        normInput = JSON.parse(t)
      } catch {
        /* keep string */
      }
    }
  }
  const picked = pickIncomingToolInputForUpsert(tc)
  return {
    ...raw,
    normP: normInput != null ? _evfParamsBrief(normInput) : null,
    pickP: picked != null ? _evfParamsBrief(picked) : null,
    pickHas: picked != null && !isEmptyToolInput(picked),
  }
}

export function evfDiagnoseToolCallsPayload(toolCalls) {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls.map((tc) => evfDiagnoseRawToolCall(tc))
}

/** 合并 tool_call 的 args/input 对象（WS 层 messages-tuple 累积与 upsert 同源） */
export function mergeToolCallArgsObjects(prev, next) {
  return mergeToolInput(prev, next)
}

/**
 * LangGraph tool_call_chunk：arguments 多为 JSON 分片追加（非整串替换）。
 * @param {string} prev
 * @param {string} next
 */
export function mergeStreamingToolCallArgStrings(prev, next) {
  const ps = stripAnsi(String(prev ?? '')).trimEnd()
  const ns = stripAnsi(String(next ?? '')).trimEnd()
  if (!ns) return ps
  if (!ps) return ns
  if (ns.startsWith(ps)) return ns
  if (ps.startsWith(ns)) return ps
  // JSON object extension: prev is {"path":"..."} and delta is ,"content":"..."}
  // (prev's trailing '}' was stripped by sender, delta carries the rest).
  if (ps.endsWith('}') && ns.startsWith(',')) {
    return ps.slice(0, -1) + ns
  }
  // Two complete JSON objects (wrong index merge): keep the later one, not `{...}{...}`.
  if (ps.endsWith('}') && ns.startsWith('{')) {
    try {
      JSON.parse(ps)
      JSON.parse(ns)
      return ns
    } catch {
      /* fall through — likely a single JSON split across chunks */
    }
  }
  return ps + ns
}

/**
 * 终端/进程类工具：从入参对象或拼接 JSON 串中提取 command（避免 scenario 等混入「命令」区）。
 * @param {unknown} rawInput
 * @param {Record<string, unknown> | null | undefined} parsed
 */
export function extractShellCommandFromToolInput(rawInput, parsed) {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const cmd = parsed.command ?? parsed.cmd
    if (typeof cmd === 'string' && cmd.trim()) return cmd.trim()
  }
  const src = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (!src) return null
  const partial = extractCommandLikeFromPartialJsonString(src)
  if (partial?.command?.trim()) return partial.command.trim()
  const blobs = splitConcatenatedJsonObjects(src)
  for (let i = blobs.length - 1; i >= 0; i--) {
    try {
      const p = JSON.parse(blobs[i])
      if (p && typeof p === 'object' && !Array.isArray(p) && typeof p.command === 'string' && p.command.trim()) {
        return p.command.trim()
      }
    } catch {
      /* next blob */
    }
  }
  if (!src.startsWith('{')) return src
  return null
}

/** read_file 等：从入参对象或流式 JSON 片段中提取 path */
export function extractPathFromToolInput(rawInput, parsed) {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const p = parsed.path ?? parsed.file_path ?? parsed.target_file ?? parsed.filepath ?? parsed.filePath
    if (typeof p === 'string' && p.trim()) return p.trim()
  }
  const src = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (!src) return null
  const partial = extractPathLikeFromPartialJsonString(src)
  if (partial?.path?.trim()) return partial.path.trim()
  const blobs = splitConcatenatedJsonObjects(src)
  for (let i = blobs.length - 1; i >= 0; i--) {
    try {
      const p = JSON.parse(blobs[i])
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue
      const path = p.path ?? p.file_path ?? p.target_file ?? p.filepath ?? p.filePath
      if (typeof path === 'string' && path.trim()) return path.trim()
    } catch {
      /* next blob */
    }
  }
  return null
}

const FILE_MUTATION_TOOL_NAMES = new Set([
  'read',
  'read_file',
  'read_files',
  'read_context_slice',
  'write',
  'write_file',
  'write_to_file',
  'replace',
  'str_replace',
  'replace_in_file',
  'delete',
  'delete_file',
])

/** 从 write/replace/delete 等工具返回文本解析文件路径 */
export function extractPathFromToolOutput(toolName, output) {
  const name = String(toolName || '').trim().toLowerCase()
  if (!FILE_MUTATION_TOOL_NAMES.has(name)) return null
  const text =
    typeof output === 'string'
      ? stripAnsi(output).trim()
      : stripAnsi(formatToolOutputForUserDisplay(output, toolName)).trim()
  if (!text) return null
  const wroteM = text.match(/^OK:\s*(?:wrote|appended to)\s+\d+\s+bytes\s+to\s+(.+?)(?:\s*\(|$)/i)
  if (wroteM?.[1]?.trim()) return wroteM[1].trim()
  const replacedM = text.match(/^OK:\s*Replaced\s+\d+\s+occurrence\(s\)\s+in\s+(\S+)/i)
  if (replacedM?.[1]?.trim()) return replacedM[1].trim()
  const deletedM = text.match(/^OK:\s*Deleted\s+(\S+)/i)
  if (deletedM?.[1]?.trim()) return deletedM[1].trim()
  const errPathM = text.match(/Error: (?:Path not found|File not found):\s*(.+?)(?:\r?\n|$)/i)
  if (errPathM?.[1]?.trim()) return errPathM[1].trim()
  return null
}

/** process / process_*：从入参对象或流式 JSON 片段中提取 session_id */
export function extractSessionIdFromToolInput(rawInput, parsed) {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const sid = parsed.session_id ?? parsed.sessionId
    if (typeof sid === 'string' && sid.trim()) return sid.trim()
  }
  const src = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (!src) return null
  const partial = extractSessionIdLikeFromPartialJsonString(src)
  if (partial?.session_id?.trim()) return partial.session_id.trim()
  const blobs = splitConcatenatedJsonObjects(src)
  for (let i = blobs.length - 1; i >= 0; i--) {
    try {
      const p = JSON.parse(blobs[i])
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        const sid = p.session_id ?? p.sessionId
        if (typeof sid === 'string' && sid.trim()) return sid.trim()
      }
    } catch {
      /* next blob */
    }
  }
  return null
}

/** 合并流式/多事件中的工具参数（先到的 {} 不应挡住后到的完整 args） */
function mergeToolInput(prev, next) {
  const p = parseToolInputValue(prev)
  const n = parseToolInputValue(next)
  if (n == null) return p
  if (p == null || isEmptyToolInput(p)) return n
  if (isEmptyToolInput(n)) return p
  if (typeof p === 'object' && typeof n === 'object' && !Array.isArray(p) && !Array.isArray(n)) {
    const merged = { ...p, ...n }
    const pc = typeof p.content === 'string' ? p.content : ''
    const nc = typeof n.content === 'string' ? n.content : ''
    if (pc && nc && nc.length > pc.length) merged.content = nc
    else if (pc && !nc) merged.content = pc
    const pCmd = typeof p.command === 'string' ? p.command.trim() : ''
    const nCmd = typeof n.command === 'string' ? n.command.trim() : ''
    if (nCmd && pCmd && nCmd !== pCmd && !nCmd.startsWith(pCmd) && !pCmd.startsWith(nCmd)) {
      merged.command = nCmd
    }
    return merged
  }
  // 已有对象入参时，后续帧可能是「仍在增长的 JSON 字符串」——勿用半截字符串覆盖掉已解析字段
  if (typeof p === 'object' && p !== null && !Array.isArray(p) && typeof n === 'string') {
    const raw = stripAnsi(String(next).trim())
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ...p, ...parsed }
        }
      } catch {
        /* keep p */
      }
    }
    return p
  }
  // 流式 arguments 常为 JSON 分片追加
  if (typeof p === 'string' && typeof n === 'string') {
    return mergeStreamingToolCallArgStrings(p, n)
  }
  if (typeof p === 'string' && typeof n === 'object' && n !== null && !Array.isArray(n)) {
    return n
  }
  return n != null ? n : p
}

/** 合并流式 tool 输出（累计字符串、终帧覆盖对象） */
function mergeToolOutput(prev, next) {
  if (next == null) return prev
  if (prev == null || prev === '') return next
  if (typeof prev === 'string' && typeof next === 'string') {
    const ps = stripAnsi(String(prev).trimEnd())
    const ns = stripAnsi(String(next).trimEnd())
    if (ns.startsWith(ps)) return next
    if (ps.startsWith(ns)) return prev
    return next
  }
  if (typeof prev === 'object' && typeof next === 'object' && !Array.isArray(prev) && !Array.isArray(next)) {
    return next
  }
  return next
}

/**
 * LangGraph/网关下发的 tool_call 往往只有 id+name、args 为 {}，且无 function.arguments；
 * 工具返回体常为 JSON（如 web_search 含 query）。在 input 仍空时用输出回填，仅用于 UI 展示与合并逻辑。
 */
function inferToolInputFromOutput(nameRaw, output) {
  const name = String(nameRaw || '').trim().toLowerCase()
  if (!name) return null

  const inferPathFromToolSummaryText = (text, toolPattern) => {
    const t = stripAnsi(String(text || '')).trim()
    if (!t) return null
    const summaryM = t.match(
      new RegExp(`\\[tool:summary\\]\\s*tool=(?:${toolPattern})[^\\n]*\\r?\\npath:\\s*(.+?)(?:\\r?\\n|$)`, 'i'),
    )
    if (summaryM?.[1]?.trim()) return summaryM[1].trim()
    return null
  }

  const inferPathFromFileToolOutputText = (text) => {
    const t = stripAnsi(String(text || '')).trim()
    if (!t) return null
    const fromSummary = inferPathFromToolSummaryText(
      t,
      'read_file|read_files|write_file|write_to_file|str_replace|replace_in_file|delete_file',
    )
    if (fromSummary) return fromSummary
    const persistM = t.match(/Full output:\s*(\S+)/i)
    if (persistM?.[1]?.trim()) return persistM[1].trim()
    const deletedM = t.match(/^OK:\s*Deleted\s+(\S+)/i)
    if (deletedM?.[1]?.trim()) return deletedM[1].trim()
    const wroteM = t.match(/^OK:\s*(?:wrote|appended to)\s+\d+\s+bytes\s+to\s+(.+?)(?:\s*\(|$)/i)
    if (wroteM?.[1]?.trim()) return wroteM[1].trim()
    const replacedM = t.match(/^OK:\s*Replaced\s+\d+\s+occurrence\(s\)\s+in\s+(\S+)/i)
    if (replacedM?.[1]?.trim()) return replacedM[1].trim()
    const errM = t.match(/Error: File not found:\s*(.+?)(?:\r?\n|$)/i)
    if (errM?.[1]?.trim()) return errM[1].trim()
    const dirM = t.match(/Error: Path is a directory, not a file:\s*(.+?)(?:\r?\n|$)/i)
    if (dirM?.[1]?.trim()) return dirM[1].trim()
    const notFileM = t.match(/Error: Not a file \(directory\?\):\s*(.+?)(?:\r?\n|\.)/i)
    if (notFileM?.[1]?.trim()) return notFileM[1].trim()
    const permM = t.match(/Error: Permission denied(?::|\s+(?:writing to|for))?\s*(.+?)(?:\r?\n|$)/i)
    if (permM?.[1]?.trim()) return permM[1].trim()
    const failWriteM = t.match(/Error: Failed to write file '([^']+)'/i)
    if (failWriteM?.[1]?.trim()) return failWriteM[1].trim()
    const failDeleteM = t.match(/Error: Failed to delete '([^']+)'/i)
    if (failDeleteM?.[1]?.trim()) return failDeleteM[1].trim()
    const failReplaceM = t.match(/Error: Replace failed in '([^']+)'/i)
    if (failReplaceM?.[1]?.trim()) return failReplaceM[1].trim()
    const replaceInM = t.match(/Error: String not found in file:\s*(.+?)(?:\r?\n|$)/i)
    if (replaceInM?.[1]?.trim()) return replaceInM[1].trim()
    return null
  }

  const FILE_PATH_TOOL_NAMES = new Set([
    'read',
    'read_file',
    'read_files',
    'read_context_slice',
    'write',
    'write_file',
    'write_to_file',
    'replace',
    'str_replace',
    'replace_in_file',
    'delete',
    'delete_file',
    'ls',
    'list_dir',
  ])

  if (FILE_PATH_TOOL_NAMES.has(name)) {
    if (typeof output === 'string') {
      const path = inferPathFromFileToolOutputText(output)
      if (path) return { path }
    }
  }

  let obj = null
  if (typeof output === 'string') {
    const t = stripAnsi(output).trim()
    if (!t || t[0] !== '{') return null
    try {
      obj = JSON.parse(t)
    } catch {
      return null
    }
  } else if (output && typeof output === 'object' && !Array.isArray(output)) {
    obj = output
  }
  if (!obj || typeof obj !== 'object') return null

  if (name === 'web_search') {
    const q = obj.query
    const ad = obj.ai_daily
    const n53 = obj.news_53ai
    const out = {}
    if (typeof q === 'string' && q.trim()) out.query = q.trim()
    if (typeof ad === 'string' && ad.trim()) out.ai_daily = ad.trim()
    if (typeof n53 === 'string' && n53.trim()) out.news_53ai = n53.trim()
    if (Object.keys(out).length) return out
    return null
  }
  if (name === 'web_fetch') {
    const u = obj.url || obj.request_url || obj.fetch_url || obj.source_url
    if (typeof u === 'string' && u.trim()) return { url: u.trim() }
    return null
  }
  if (name === 'read_file' || name === 'read_files' || name === 'read_context_slice') {
    const pathRaw = obj.path ?? obj.file_path ?? obj.target_file ?? obj.filepath ?? obj.filePath
    if (typeof pathRaw === 'string' && pathRaw.trim()) return { path: pathRaw.trim() }
    return null
  }
  if (
    name === 'write_file' ||
    name === 'write_to_file' ||
    name === 'str_replace' ||
    name === 'replace_in_file' ||
    name === 'delete_file' ||
    name === 'ls' ||
    name === 'list_dir'
  ) {
    const pathRaw = obj.path ?? obj.file_path ?? obj.target_file ?? obj.filepath ?? obj.filePath
    if (typeof pathRaw === 'string' && pathRaw.trim()) return { path: pathRaw.trim() }
    return null
  }
  if (name === 'plan') {
    const plan = obj.plan && typeof obj.plan === 'object' ? obj.plan : obj
    const goal = String(plan.goal || obj.goal || '').trim()
    let steps = plan.steps ?? obj.steps
    if (typeof steps === 'string' && steps.trim().startsWith('[')) {
      try {
        steps = JSON.parse(steps)
      } catch {
        steps = null
      }
    }
    if (!goal || !Array.isArray(steps) || !steps.length) return null
    return {
      goal,
      steps,
      flowchart_mermaid: plan.flowchart_mermaid ?? plan.flowchartMermaid ?? obj.flowchart_mermaid,
      validation: plan.validation ?? obj.validation,
      open_questions: plan.open_questions ?? plan.openQuestions ?? obj.open_questions,
    }
  }
  // tasks / knowledge / platform：历史里常见「只有 tool result、assistant.tool_calls 未落库」
  // 从出参回填可读入参，避免侧栏摘要/入参空白。
  if (name === 'tasks' || name === 'knowledge' || name === 'platform') {
    const result = obj.result && typeof obj.result === 'object' && !Array.isArray(obj.result) ? obj.result : {}
    const out = {}
    const action = String(obj.action || result.action || '').trim()
    if (action) out.action = action
    const uiObj = obj.ui && typeof obj.ui === 'object' && !Array.isArray(obj.ui) ? obj.ui : null
    const uiTitle = uiObj && typeof uiObj.title === 'string' ? uiObj.title.trim() : ''
    if (uiTitle) out.ui_title = uiTitle
    const status = String(result.status || obj.status || '').trim()
    if (status) out.status = status
    const statusZh = String(result.status_zh || obj.status_zh || '').trim()
    if (statusZh) out.status_zh = statusZh
    const summary = String(result.summary || obj.summary || '').trim()
    if (summary) out.summary = summary
    const title = String(result.name || result.title || obj.name || obj.title || '').trim()
    if (title) {
      out.name = title
      out.title = title
    }
    if (result.progress != null && result.progress !== '') out.progress = result.progress
    else if (obj.progress != null && obj.progress !== '') out.progress = obj.progress
    const err = String(obj.error || result.error || '').trim()
    if (err) out.error = err
    if (Object.keys(out).length) return out
    return null
  }
  return null
}

/**
 * terminal/bash/execute_command 的 output 通常不包含原始命令（如 git log 输出），
 * 但某些场景下 output 会回显命令（shell echo、错误信息等），尽力提取。
 * 无法提取时返回 null，由渲染层 fallback 从 output 首行显示摘要。
 */
function inferShellCommandFromOutput(output) {
  const text = typeof output === 'string' ? stripAnsi(output).trim() : ''
  if (!text) return null
  // shell prompt echo: "$ command" 或 "> command"
  const echoM = text.match(/^[>$]\s*(.+)/)
  if (echoM?.[1]?.trim()) return { command: echoM[1].trim() }
  // 显式标注: "Command: ..." / "Running: ..." / "Executing: ..."
  const labeledM = text.match(/^(?:Command|Running|Executing):\s*(.+)/i)
  if (labeledM?.[1]?.trim()) return { command: labeledM[1].trim() }
  // 错误信息中包含命令: "Error running 'command'" / "Failed to execute: command"
  const errM = text.match(/(?:Error|Failed)[^:]*:\s*['"]?(.+?)['"]?(?:\r?\n|$)/i)
  if (errM?.[1]?.trim()) return { command: errM[1].trim() }
  return null
}

const SHELL_TOOL_NAMES = new Set(['terminal', 'bash', 'execute_command'])

export function isShellToolName(name) {
  return SHELL_TOOL_NAMES.has(String(name || '').trim().toLowerCase())
}

/** Backend terminal tools append ``[exit code: N]`` to persisted output. */
export function parseTerminalExitCodeFromOutput(output) {
  const text =
    typeof output === 'string'
      ? stripAnsi(output)
      : output != null
        ? stripAnsi(formatToolDisplayValue(output))
        : ''
  const m = text.match(/\[exit code:\s*(-?\d+)\]/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/** PowerShell / git stderr noise — must not become inline tool brief. */
export function isShellToolBriefNoiseLine(line) {
  const s = String(line || '').trim()
  if (!s) return true
  if (/^\[stderr\]$/i.test(s)) return true
  if (/^\[exit code:\s*-?\d+\]$/i.test(s)) return true
  if (/^NativeCommandError$/i.test(s)) return true
  if (/^CategoryInfo\s*:/i.test(s)) return true
  if (/^FullyQualifiedErrorId\s*:/i.test(s)) return true
  if (/^RemoteException$/i.test(s)) return true
  if (/^-----+\s*-----+/i.test(s)) return true
  if (/^=+$/.test(s)) return true
  if (/^Lines\s+Words\s+Characters/i.test(s)) return true
  if (/^\d+\s+\d+\s+\d+/i.test(s) && s.split(/\s+/).length <= 4) return true
  if (/^\d+$/.test(s)) return true
  if (/^所在位置\s/.test(s)) return true
  if (/^\+\s~/.test(s)) return true
  if (/^\+{3,}/.test(s)) return true
  return false
}

/** ``git : …`` / ``error: …`` → user-readable fragment */
export function normalizeShellErrorLine(line) {
  const t = String(line || '').trim()
  const gitM = t.match(/^git\s*:\s*(.+)/i)
  if (gitM?.[1]?.trim()) return gitM[1].trim()
  const errM = t.match(/^error:\s*(.+)/i)
  if (errM?.[1]?.trim()) return errM[1].trim()
  return t
}

/** First user-meaningful line from shell output (skip PS table / stderr wrappers). */
export function firstMeaningfulShellOutputLine(output) {
  const text =
    typeof output === 'string'
      ? stripAnsi(output)
      : output != null
        ? stripAnsi(formatToolDisplayValue(output))
        : ''
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || isShellToolBriefNoiseLine(t)) continue
    return normalizeShellErrorLine(t)
  }
  return null
}

export function extractTerminalErrorSummary(output) {
  const text =
    typeof output === 'string'
      ? stripAnsi(output)
      : output != null
        ? stripAnsi(formatToolDisplayValue(output))
        : ''
  let inStderr = false
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    if (/^\[stderr\]$/i.test(t)) {
      inStderr = true
      continue
    }
    if (/^\[exit code:/i.test(t)) break
    if (isShellToolBriefNoiseLine(t)) continue
    if (
      inStderr ||
      /^error:/i.test(t) ||
      /^git\s*:/i.test(t) ||
      /Too many revisions|command not found|not a git/i.test(t)
    ) {
      const msg = normalizeShellErrorLine(t)
      return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg
    }
  }
  return firstMeaningfulShellOutputLine(output)
}

export function isTerminalToolFailed({ status, output, streamPhase, streamExitCode } = {}) {
  const st = String(status || '').trim().toLowerCase()
  if (st === 'error' || st === 'failed') return true
  if (streamPhase === 'failed') return true
  if (streamExitCode != null && streamExitCode !== 0) return true
  const exit = parseTerminalExitCodeFromOutput(output)
  return exit != null && exit !== 0
}

export function maybeSyncTerminalToolStatusFromOutput(tool) {
  if (!tool || typeof tool !== 'object') return
  const name = String(tool.name ?? tool.tool_name ?? tool.toolName ?? '').trim().toLowerCase()
  if (!isShellToolName(name)) return
  if (isTerminalToolFailed({ status: tool.status, output: tool.output ?? tool.result })) {
    tool.status = 'error'
  }
}

function outputLooksLikePlanPayload(output) {
  let obj = null
  if (typeof output === 'string') {
    const t = stripAnsi(output).trim()
    if (!t || t[0] !== '{') return false
    try {
      obj = JSON.parse(t)
    } catch {
      return false
    }
  } else if (output && typeof output === 'object' && !Array.isArray(output)) {
    obj = output
  }
  if (!obj || typeof obj !== 'object') return false
  const plan = obj.plan && typeof obj.plan === 'object' ? obj.plan : obj
  const goal = String(plan.goal || obj.goal || '').trim()
  const steps = plan.steps ?? obj.steps
  return !!(goal && Array.isArray(steps) && steps.length > 0)
}

function maybeInferToolNameFromOutput(target) {
  if (!target || typeof target !== 'object') return
  if (outputLooksLikePlanPayload(target.output ?? target.output_text)) {
    target.name = 'plan'
    if (!target.tool_name) target.tool_name = 'plan'
  }
}

function maybeBackfillToolInputFromOutput(target) {
  if (!target || typeof target !== 'object') return
  if (!isEmptyToolInput(target.input)) return
  const name = String(target.name ?? target.tool_name ?? target.toolName ?? '').trim().toLowerCase()
  // terminal/bash/execute_command：从 output 尽力提取命令
  if (name === 'terminal' || name === 'bash' || name === 'execute_command') {
    const inferred = inferShellCommandFromOutput(target.output)
    if (inferred && !isEmptyToolInput(inferred)) {
      target.input = mergeToolInput(target.input, inferred)
      return
    }
  }
  const inferred = inferToolInputFromOutput(
    target.name ?? target.tool_name ?? target.toolName,
    target.output,
  )
  if (inferred && !isEmptyToolInput(inferred)) {
    target.input = mergeToolInput(target.input, inferred)
  }
}

function maybeInferToolNameFromInput(target) {
  if (!target || typeof target !== 'object') return
  const inferred = resolveEffectiveToolName(target)
  if (!isGenericToolName(inferred)) target.name = inferred
}

export function upsertTool(tools, entry) {
  if (!entry) return
  const eventTs = Date.now()
  const id = entry.id || entry.tool_call_id
  let target = null
  if (id) target = tools.find((t) => t.id === id || t.tool_call_id === id)
  /* 有 id 却未命中时必须是新工具，禁止按 name 合并到上一条（多段 write_file 会同名） */
  if (!target && entry.name && !id) {
    target = tools.find((t) => t.name === entry.name && !t.output)
    if (!target) target = tools.find((t) => t.name === entry.name && isEmptyToolInput(t.input))
  }
  if (target) {
    if (!target._uiStartedAtMs) {
      target._uiStartedAtMs = entry._uiStartedAtMs || eventTs
    }
    const wasRunning = isToolRunning(target)
    const nextName = resolveEntryToolName(entry)
    if (nextName) target.name = nextName
    if (entry.tool_name != null && String(entry.tool_name).trim()) {
      target.tool_name = String(entry.tool_name).trim()
    }
    const inc = pickIncomingToolInputForUpsert(entry)
    if (inc != null) target.input = mergeToolInput(target.input, inc)
    if (entry.function != null) target.function = mergeToolFunctionField(target.function, entry.function)
    if (typeof entry.arguments === 'string' && entry.arguments.trim()) {
      target.arguments = mergeToolArgumentsString(target.arguments, entry.arguments)
      target.function = mergeToolFunctionField(target.function, { arguments: entry.arguments })
    }
    const incomingOutput =
      entry.output != null
        ? entry.output
        : entry.output_text != null
          ? entry.output_text
          : null
    if (incomingOutput != null) target.output = mergeToolOutput(target.output, incomingOutput)
    if (entry.status) {
      const cur = String(target.status || '').toLowerCase()
      const inc = String(entry.status).toLowerCase()
      const terminal = new Set([
        'ok',
        'completed',
        'done',
        'success',
        'error',
        'failed',
        'cancelled',
        'canceled',
        'pending_approval',
      ])
      const inFlight = inc === 'running' || inc === 'pending' || inc === 'in_progress'
      if (!(terminal.has(cur) && inFlight)) target.status = entry.status
    }
    syncToolStatusFromEnvelope(target)
    maybeSyncTerminalToolStatusFromOutput(target)
    if (wasRunning && !isToolRunning(target) && !target._uiEndedAtMs) {
      target._uiEndedAtMs = entry._uiEndedAtMs || eventTs
    }
    if (entry.time) target.time = entry.time
    if (entry.truncated != null) target.truncated = entry.truncated
    if (entry.content_bytes != null) target.content_bytes = entry.content_bytes
    if (entry.output_truncated != null) target.output_truncated = entry.output_truncated
    if (entry.outputTruncated != null) target.outputTruncated = entry.outputTruncated
    if (entry.output_bytes != null) target.output_bytes = entry.output_bytes
    if (entry.outputBytes != null) target.outputBytes = entry.outputBytes
    maybeBackfillToolInputFromOutput(target)
    maybeInferToolNameFromOutput(target)
    maybeInferToolNameFromInput(target)
    hydrateToolInputContentFromStreamingRaw(target)
    maybeSlimToolOutputForUi(target)
    return
  }
  const row = { ...entry }
  if (!row._uiStartedAtMs) row._uiStartedAtMs = eventTs
  if (!isToolRunning(row) && !row._uiEndedAtMs) row._uiEndedAtMs = eventTs
  if (entry.tool_name != null && String(entry.tool_name).trim()) {
    row.tool_name = String(entry.tool_name).trim()
  }
  if ((row.output == null || row.output === '') && row.output_text != null && row.output_text !== '') {
    row.output = row.output_text
  }
  const incNew = pickIncomingToolInputForUpsert(entry)
  if (incNew != null) row.input = mergeToolInput(row.input, incNew)
  maybeBackfillToolInputFromOutput(row)
  maybeInferToolNameFromOutput(row)
  maybeInferToolNameFromInput(row)
  hydrateToolInputContentFromStreamingRaw(row)
  syncToolStatusFromEnvelope(row)
  maybeSyncTerminalToolStatusFromOutput(row)
  if (!isToolRunning(row) && !row._uiEndedAtMs) row._uiEndedAtMs = eventTs
  maybeSlimToolOutputForUi(row)
  tools.push(row)
}

export function collectToolsFromMessage(message, tools) {
  if (!message || !tools) return
  const view = historyMessageBodyView(message)
  const toolCalls = view.tool_calls || view.toolCalls || view.tools
  if (Array.isArray(toolCalls)) {
    toolCalls.forEach((call) => {
      const fn = call.function || null
      const name = call.name || call.tool || call.tool_name || fn?.name
      let input = resolvePrimaryToolCallArgs(call)
      if (input == null) {
        input = call.input ?? call.args ?? call.parameters ?? call.arguments ?? null
      }
      if (typeof input === 'string') {
        const t = input.trim()
        if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
          try {
            input = JSON.parse(input)
          } catch {
            /* keep */
          }
        }
      }
      const callId = call.id || call.tool_call_id
      upsertTool(tools, {
        id: callId,
        name: name || '工具',
        function: fn || undefined,
        input,
        output: null,
        status: call.status || 'running',
        time: resolveToolTime(callId, message?.timestamp),
      })
    })
  }
  const toolResults = view.tool_results || view.toolResults
  if (Array.isArray(toolResults)) {
    toolResults.forEach((res) => {
      const resId = res.id || res.tool_call_id
      upsertTool(tools, {
        id: resId,
        name: res.name || res.tool || res.tool_name || '工具',
        input: res.input || res.args || null,
        output: res.output || res.result || res.content || null,
        status: res.status || 'ok',
        time: resolveToolTime(resId, message?.timestamp),
      })
    })
  }
}

function isToolResultMessage(msg) {
  if (!msg || typeof msg !== 'object') return false
  const t = msg.type
  const tLower = typeof t === 'string' ? t.toLowerCase() : ''
  return (
    msg.role === 'tool' ||
    msg.role === 'toolResult' ||
    tLower === 'tool' ||
    tLower === 'tool_message' ||
    tLower === 'toolmessage'
  )
}

function resolveToolResultOutput(msg) {
  if (!msg || typeof msg !== 'object') return null
  const body = resolveHistoryMessageContent(msg)
  const output =
    typeof body === 'string'
      ? body
      : body != null && body !== ''
        ? formatToolDisplayValue(body)
        : msg.output != null
          ? msg.output
          : msg.result != null
            ? msg.result
            : null
  return output != null && output !== '' ? output : null
}

/** Attach a tool-role message result to the matching tool row (never blindly tools[0]). */
function attachToolResultOutput(tools, msg) {
  const output = resolveToolResultOutput(msg)
  if (output == null || !Array.isArray(tools)) return
  const toolCallId = msg.tool_call_id || msg.toolCallId || msg.id
  let target = null
  if (toolCallId) {
    const tid = String(toolCallId).trim()
    target = tools.find((t) => t.id === tid || t.tool_call_id === tid) || null
  }
  if (!target && tools.length === 1) target = tools[0]
  if (!target) {
    tools.push({
      id: toolCallId,
      name: msg.name || msg.tool || msg.tool_name || '工具',
      input: msg.input || msg.args || msg.parameters || null,
      output,
      status: msg.status || 'ok',
      time: resolveToolTime(toolCallId, msg.timestamp),
    })
    const row = tools[tools.length - 1]
    syncToolStatusFromEnvelope(row)
    maybeSyncTerminalToolStatusFromOutput(row)
    maybeBackfillToolInputFromOutput(row)
    maybeSlimToolOutputForUi(row)
    return
  }
  if (target.output == null || target.output === '') {
    target.output = output
    syncToolStatusFromEnvelope(target)
    maybeSyncTerminalToolStatusFromOutput(target)
  }
  maybeBackfillToolInputFromOutput(target)
  // Prefer the tool-result message clock so each call has its own time in trail UI.
  const resultTs = resolveToolTime(toolCallId, msg.timestamp)
  if (resultTs) target.time = resultTs
  if (msg.timestamp != null) target.messageTimestamp = msg.timestamp
  if (msg.truncated === true || msg.output_truncated === true) {
    target.truncated = true
    target.output_truncated = true
    target.outputTruncated = true
  }
  if (msg.content_bytes != null) target.content_bytes = msg.content_bytes
  if (msg.output_bytes != null) {
    target.output_bytes = msg.output_bytes
    target.outputBytes = msg.output_bytes
  }
  maybeSlimToolOutputForUi(target)
}

function inferFilesFromToolEntries(_tools) {
  return []
}

export function extractContent(msg) {
  const view = historyMessageBodyView(msg)
  const tools = []
  collectToolsFromMessage(view, tools)
  if (isToolResultMessage(view)) {
    if (!tools.length) {
      const output = resolveToolResultOutput(view)
      upsertTool(tools, {
        id: view.tool_call_id || view.toolCallId || view.id,
        name: view.name || view.tool || view.tool_name || '工具',
        input: view.input || view.args || view.parameters || null,
        output,
        status: view.status || 'ok',
        time: resolveToolTime(view.tool_call_id || view.toolCallId || view.id, view.timestamp),
      })
    } else {
      attachToolResultOutput(tools, view)
    }
    return mergeToolDerivedMedia(
      { text: '', images: [], videos: [], audios: [], files: inferFilesFromToolEntries(tools), tools },
      tools,
    )
  }
  if (Array.isArray(view.content)) {
    const texts = []
    const images = []
    const videos = []
    const audios = []
    const files = []
    for (const block of view.content) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      else if (block.type === 'image' && !block.omitted) {
        if (block.data) images.push({ mediaType: block.mimeType || 'image/png', data: block.data })
        else if (block.source?.type === 'base64' && block.source.data)
          images.push({ mediaType: block.source.media_type || 'image/png', data: block.source.data })
        else if (block.url || block.source?.url)
          images.push({ url: block.url || block.source.url, mediaType: block.mimeType || 'image/png' })
      } else if (block.type === 'image_url' && block.image_url?.url) {
        images.push({ url: block.image_url.url, mediaType: 'image/png' })
      } else if (block.type === 'video') {
        if (block.data) videos.push({ mediaType: block.mimeType || 'video/mp4', data: block.data })
        else if (block.url) videos.push({ url: block.url, mediaType: block.mimeType || 'video/mp4' })
      } else if (block.type === 'audio' || block.type === 'voice') {
        if (block.data)
          audios.push({
            mediaType: block.mimeType || 'audio/mpeg',
            data: block.data,
            duration: block.duration,
          })
        else if (block.url)
          audios.push({ url: block.url, mediaType: block.mimeType || 'audio/mpeg', duration: block.duration })
      } else if (block.type === 'file' || block.type === 'document') {
        files.push({
          url: block.url || '',
          name: block.fileName || block.name || '文件',
          mimeType: block.mimeType || '',
          size: block.size,
          data: block.data,
        })
      } else if (
        block.type === 'tool' ||
        block.type === 'tool_use' ||
        block.type === 'tool_call' ||
        block.type === 'toolCall'
      ) {
        const callId = block.id || block.tool_call_id || block.toolCallId
        let blockInput = resolvePrimaryToolCallArgs(block)
        if (blockInput == null) {
          blockInput = block.input || block.args || block.parameters || block.arguments || null
        }
        if (typeof blockInput === 'string') {
          const t = blockInput.trim()
          if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
            try {
              blockInput = JSON.parse(blockInput)
            } catch {
              /* keep */
            }
          }
        }
        upsertTool(tools, {
          id: callId,
          name: block.name || block.tool || block.tool_name || block.toolName || '工具',
          input: blockInput,
          output: null,
          status: block.status || 'ok',
          time: resolveToolTime(callId, view.timestamp),
        })
      } else if (block.type === 'tool_result' || block.type === 'toolResult') {
        const resId = block.id || block.tool_call_id || block.toolCallId
        let resInput = resolvePrimaryToolCallArgs(block)
        if (resInput == null) {
          resInput = block.input || block.args || null
        }
        upsertTool(tools, {
          id: resId,
          name: block.name || block.tool || block.tool_name || block.toolName || '工具',
          input: resInput,
          output: block.output || block.result || block.content || null,
          status: block.status || 'ok',
          time: resolveToolTime(resId, view.timestamp),
        })
      }
    }
    if (tools.length) {
      tools.forEach((t) => {
        if (typeof t.input === 'string') t.input = stripAnsi(t.input)
        if (typeof t.output === 'string') t.output = stripAnsi(t.output)
      })
    }
    const toolFiles = inferFilesFromToolEntries(tools)
    const mediaUrls = view.mediaUrls || (view.mediaUrl ? [view.mediaUrl] : [])
    for (const url of mediaUrls) {
      if (!url) continue
      if (/\.(mp4|webm|mov|mkv)(\?|$)/i.test(url)) videos.push({ url, mediaType: 'video/mp4' })
      else if (/\.(mp3|wav|ogg|m4a|aac|flac)(\?|$)/i.test(url))
        audios.push({ url, mediaType: 'audio/mpeg' })
      else if (/\.(jpe?g|png|gif|webp|heic|svg)(\?|$)/i.test(url))
        images.push({ url, mediaType: 'image/png' })
      else files.push({ url, name: url.split('/').pop().split('?')[0] || '文件', mimeType: '' })
    }
    return mergeToolDerivedMedia(
      {
        text: stripThinkingTags(joinTextContentParts(texts)),
        images,
        videos,
        audios,
        files: [...files, ...toolFiles],
        tools,
      },
      tools,
    )
  }
  const body = resolveHistoryMessageContent(view)
  let text =
    typeof view.text === 'string'
      ? view.text
      : typeof body === 'string'
        ? body
        : ''
  text = unwrapAssistantContentJsonEnvelope(text)
  return mergeToolDerivedMedia(
    { text: stripThinkingTags(text), images: [], videos: [], audios: [], files: inferFilesFromToolEntries(tools), tools },
    tools,
  )
}

/** LangGraph checkpoint 里部分中间件会用 HumanMessage 注入提醒（Anthropic 限制下不能插 System），刷新后若仍当 user 会占满「用户气泡」。 */
function peekRawTextForRoleHint(msg) {
  const c = resolveHistoryMessageContent(msg)
  if (typeof c === 'string') return c.trimStart()
  /* 少数序列化形态：content 为单对象且带 text（非标准数组块） */
  if (c && typeof c === 'object' && !Array.isArray(c) && typeof c.text === 'string') return c.text.trimStart()
  if (Array.isArray(c)) {
    const texts = []
    for (const block of c) {
      if (typeof block === 'string') {
        texts.push(block)
        continue
      }
      if (!block || typeof block !== 'object') continue
      if (typeof block.text === 'string') {
        texts.push(block.text)
        continue
      }
      if (typeof block.content === 'string') {
        texts.push(block.content)
      }
    }
    return texts.join('\n').trimStart()
  }
  return ''
}

const INJECTED_HUMAN_MESSAGE_NAMES = new Set([
  'todo_reminder',
  'collab_phase_hint',
  'conversation_summary',
  'tool_history',
  'tool_approval_resume',
  'tool_approval_command',
  'xiaomi_ui_context',
  'session_mission_state',
  'session_collab_live',
])

/** 上下文压缩摘要（无 name 的旧 checkpoint 仍靠正文前缀识别） */
export function isContextCompactionContent(text) {
  const s = typeof text === 'string' ? text.trimStart() : ''
  if (!s) return false
  const lower = s.toLowerCase()
  return (
    lower.startsWith('[context compaction') ||
    s.startsWith('[上下文摘要') ||
    s.startsWith('[深度压缩摘要') ||
    s.startsWith('[tool:history]') ||
    s.startsWith('[tool:summary]')
  )
}

const _TOOL_SUMMARY_FIELD_RE = /^(path|lines|status|core|key_facts|refs)\s*[:：]/i

/** 工具 LLM 摘要 / 落盘引用块（仅供模型上下文，不应原样展示给用户） */
export function isStructuredToolSummaryText(text) {
  const s = typeof text === 'string' ? stripAnsi(text).trim() : ''
  if (!s) return false
  if (isContextCompactionContent(s)) return true
  if (/\[tool:summary\]/i.test(s) || /\[tool:history\]/i.test(s)) return true
  if (/\[ToolResult persisted\]/i.test(s) || /\bFull output:/i.test(s) || /\bPersisted output:/i.test(s)) {
    return true
  }
  const fieldHits = ['path', 'lines', 'status', 'core', 'key_facts', 'refs'].filter((k) =>
    new RegExp(`^${k}\\s*[:：]`, 'im').test(s),
  ).length
  return fieldHits >= 3
}

/** 去掉助手正文开头误粘贴的工具摘要字段块，保留其后用户可见句（如「搜索成功」） */
export function stripStructuredToolSummaryFromDisplayText(text) {
  const s = String(text || '')
  if (!isStructuredToolSummaryText(s)) return s
  const lines = s.split(/\r?\n/)
  const kept = []
  let skipping = true
  for (const line of lines) {
    const t = line.trim()
    if (skipping) {
      if (!t) continue
      if (
        _TOOL_SUMMARY_FIELD_RE.test(t) ||
        t.startsWith('[tool:summary]') ||
        t.startsWith('[tool:history]') ||
        /^\[ToolResult/i.test(t)
      ) {
        continue
      }
      skipping = false
    }
    if (!skipping) kept.push(line)
  }
  return kept.join('\n').trim()
}

function _extractSummaryField(text, key) {
  const m = String(text || '').match(new RegExp(`^${key}\\s*[:：]\\s*(.+)$`, 'im'))
  return m ? m[1].trim().split(/\r?\n/)[0] : ''
}

/** Best-effort paths from search_code_index / grep structured or raw listing output. */
function _extractSearchHitPathsFromToolOutput(raw) {
  const paths = []
  const seen = new Set()
  const add = (p) => {
    const rel = String(p || '').trim().replace(/\\/g, '/').split(':')[0]
    if (!rel || seen.has(rel)) return
    seen.add(rel)
    paths.push(rel)
  }
  for (const line of String(raw || '').split('\n')) {
    const catalog = line.match(/^\s*\[\d+\]\s+(\S+)/)
    if (catalog) {
      add(catalog[1])
      continue
    }
    const sym = line.match(/@\s+([^\s]+:\d+)\s*$/)
    if (sym) {
      add(sym[1])
      continue
    }
    const content = line.match(/^\s*-\s+([^:\s]+):/)
    if (content) add(content[1])
    if (paths.length >= 4) break
  }
  return paths
}

const _UI_TOOL_OUTPUT_MAX = 12_000

/** Tools whose result body never stays in page memory — modal loads via /tool-results API. */
const _LAZY_TOOL_RESULT_NAMES = new Set([
  'read',
  'read_file',
  'read_files',
  'read_context_slice',
  'grep',
  'rg',
  'search_code_index',
  'search_content',
  'find_file',
  'web_search',
  'web_fetch',
  'fetch_url',
  'fetch_url_tool',
  'preview_url',
  'ls',
  'list_dir',
  'read_lints',
])

const _READ_TOOL_NAMES = new Set(['read', 'read_file', 'read_files', 'read_context_slice'])
const _READ_UI_PREVIEW_MAX = 480

/** Retired built-in browser tools — history transcript only (see tool-display RETIRED_BROWSER_SKILL_TOOL_NAMES). */
const _RETIRED_BROWSER_TOOL_NAMES = new Set([
  'preview_url',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_back',
  'browser_snapshot',
  'browser_close',
  'browser_press',
  'browser_console',
  'browser_get_images',
])

export function isRetiredBrowserToolName(toolName) {
  return _RETIRED_BROWSER_TOOL_NAMES.has(String(toolName || '').trim().toLowerCase())
}

export function isLazyToolResultName(toolName) {
  const n = String(toolName || '').trim().toLowerCase()
  if (!n) return false
  if (_LAZY_TOOL_RESULT_NAMES.has(n)) return true
  return _RETIRED_BROWSER_TOOL_NAMES.has(n)
}

export function isReadToolName(toolName) {
  return _READ_TOOL_NAMES.has(String(toolName || '').trim().toLowerCase())
}

function _buildReadToolUiPreview(text) {
  const raw = String(text || '')
  if (!raw) return raw
  if (raw.length <= _READ_UI_PREVIEW_MAX) {
    const lines = raw.split('\n')
    if (lines.length > 8) {
      return `${lines.slice(0, 4).join('\n')}\n…（共 ${lines.length.toLocaleString()} 行，点击「查看完整结果」加载）`
    }
    return raw
  }
  const lines = raw.split('\n')
  if (lines.length <= 24) {
    return `${raw.slice(0, _READ_UI_PREVIEW_MAX)}\n…（共 ${raw.length.toLocaleString()} 字符，点击「查看完整结果」加载）`
  }
  const head = lines.slice(0, 12).join('\n')
  const tail = lines.slice(-6).join('\n')
  let preview = `${head}\n…（共 ${lines.length.toLocaleString()} 行 / ${raw.length.toLocaleString()} 字符，点击「查看完整结果」加载）\n${tail}`
  if (preview.length > _READ_UI_PREVIEW_MAX + 400) {
    preview = `${preview.slice(0, _READ_UI_PREVIEW_MAX + 400)}…`
  }
  return preview
}

const _TOOL_OUTPUT_SLIM_EXEMPT_NAMES = new Set(['ask_clarification', 'mind_map', 'session_mind_map'])

function _isBrowserToolName(name) {
  const n = String(name || '').trim().toLowerCase()
  return n === 'browser' || n.startsWith('browser_') || n === 'preview_url'
}

/** Preserve browser screenshot / URL / snapshot text before output slimming clears tool.output. */
function _preserveBrowserUiMeta(target, raw) {
  if (!target || typeof target !== 'object') return
  const name = String(target.name || target.tool_name || '').trim().toLowerCase()
  if (!_isBrowserToolName(name)) return

  const shot = parseBrowserScreenshotToolOutput(raw)
  if (shot?.src) target.browser_screenshot = shot

  const live = parseBrowserLiveToolOutput(raw)
  if (live?.streamWs || live?.pageUrl) target.browser_live = live

  const input = getToolInputObject(target)
  const action = String(input.action || '').trim().toLowerCase()
  if (action) target.browser_action = action
  if (action === 'open') {
    const url = String(input.url || '').trim()
    if (url) target.browser_page_url = url
  }
  if (action === 'snapshot' && raw && !String(raw).trimStart().startsWith('Error:')) {
    const text = String(raw).trim()
    if (text) {
      target.browser_snapshot_text =
        text.length > 16000 ? `${text.slice(0, 16000)}\n…` : text
    }
  }
  if (
    action === 'open' &&
    !target.browser_snapshot_text &&
    raw &&
    !String(raw).trimStart().startsWith('Error:') &&
    !target.browser_screenshot?.src
  ) {
    const body = String(raw)
      .replace(/^Opened\s+\S+\s*\n*/i, '')
      .trim()
    if (body && !body.startsWith('{') && body.length > 40) {
      target.browser_snapshot_text =
        body.length > 16000 ? `${body.slice(0, 16000)}\n…` : body
    }
  }
  if (shot?.pageUrl) target.browser_page_url = shot.pageUrl
  if (live?.pageUrl) target.browser_page_url = live.pageUrl
}

/** Preserve platform ``ui`` feedback before output slimming clears tool.output. */
function _preservePlatformUiMeta(target, raw) {
  if (!target || typeof target !== 'object') return
  const name = String(target.name || target.tool_name || '').trim().toLowerCase()
  if (name !== 'platform') return
  let obj = null
  try {
    if (typeof raw === 'string') {
      const text = raw.trim()
      if (!text || text[0] !== '{') return
      obj = JSON.parse(text)
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      obj = raw
    }
  } catch {
    return
  }
  if (!obj || typeof obj !== 'object' || obj.ok === false || obj.pending_confirm === true) return
  if (obj.ui && typeof obj.ui === 'object' && !Array.isArray(obj.ui)) {
    target.platform_ui = obj.ui
  }
  if (obj.action) target.platform_action = obj.action
  if (obj.item && typeof obj.item === 'object') target.platform_item = obj.item
  if (obj.agent && typeof obj.agent === 'object') target.platform_agent = obj.agent
  if (obj.role && typeof obj.role === 'object') target.platform_role = obj.role
  if (obj.settings && typeof obj.settings === 'object' && !Array.isArray(obj.settings)) {
    target.platform_settings = obj.settings
  }
  if (obj.client_effect) target.platform_client_effect = obj.client_effect
  target.platform_ok = true
}

function _shouldSlimToolOutputForUi(target, text) {
  if (!target || typeof target !== 'object') return false
  const st = String(target.status || '').toLowerCase()
  if (st === 'pending_approval') return false
  const name = String(target.name || target.tool_name || '').trim().toLowerCase()
  if (_TOOL_OUTPUT_SLIM_EXEMPT_NAMES.has(name)) return false
  if (target.browser_screenshot?.src) return false
  if (target.browser_live?.streamWs || target.browser_live?.pageUrl) return false
  return Boolean(String(text || '').trim())
}

/** 所有工具：流缓存不保留大段 output，弹窗经 /tool-results 按需拉取 */
export function maybeSlimToolOutputForUi(target) {
  if (!target || typeof target !== 'object') return
  const raw =
    typeof target.output === 'string'
      ? target.output
      : target.output != null
        ? formatToolDisplayValue(target.output)
        : ''
  _preserveBrowserUiMeta(target, raw)
  _preservePlatformUiMeta(target, raw)
  if (!_shouldSlimToolOutputForUi(target, raw)) return
  const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(raw).length : raw.length
  target.output = ''
  target.output_truncated = true
  target.outputTruncated = true
  target.truncated = true
  target.output_bytes = bytes
  target.outputBytes = bytes
}

/** @deprecated use maybeSlimToolOutputForUi */
export function maybeSlimReadToolOutputForUi(target) {
  maybeSlimToolOutputForUi(target)
}

/** 工具折叠面板：小结果 inline；大结果由 transcript 提供 preview + 按需拉取 */
const _FULL_INLINE_TOOL_OUTPUT_NAMES = new Set([
  'list_agents',
  'list_assignable_tools',
])

/** MediaToolResponse JSON blob (media_* tools). */
export function parseMediaToolOutputBlob(value) {
  if (value == null) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') {
    const t = value.trim()
    if (!t || t[0] !== '{') return null
    try {
      const j = JSON.parse(t)
      return typeof j === 'object' && j != null && !Array.isArray(j) ? j : null
    } catch {
      return null
    }
  }
  return null
}

/** Resolve workspace absolute path or remote URL for <img src> (Gateway serve-file). */
export function resolveMediaAssetSrc(rawPathOrUrl) {
  return resolveChatImageSrc(rawPathOrUrl)
}

function _isVideoLikePath(pathLike) {
  return /\.(mp4|webm|mov|mkv|m4v)(\?|$)/i.test(String(pathLike || ''))
}

function _isAudioLikePath(pathLike) {
  return /\.(mp3|wav|ogg|m4a|aac|flac)(\?|$)/i.test(String(pathLike || ''))
}

/** Successful media image tool output → inline preview metadata. */
export function parseMediaImagePreview(value, toolName) {
  const blob = parseMediaToolOutputBlob(value)
  if (!blob || blob.ok === false) return null
  const status = String(blob.status || '').toLowerCase()
  const absolutePath = typeof blob.absolute_path === 'string' ? blob.absolute_path.trim() : ''
  const localPath = typeof blob.local_path === 'string' ? blob.local_path.trim() : ''
  const url = typeof blob.url === 'string' ? blob.url.trim() : ''
  const urls = Array.isArray(blob.urls) ? blob.urls.map((x) => String(x || '').trim()).filter(Boolean) : []
  const remote = url || urls[0] || ''
  const savedPath = absolutePath || localPath
  const pathHint = savedPath || remote
  if (pathHint && (_isVideoLikePath(pathHint) || _isAudioLikePath(pathHint))) return null
  if (status === 'processing' && !savedPath && !remote) return null
  const rawSrc = savedPath || remote
  if (!rawSrc) return null
  const src = resolveMediaAssetSrc(rawSrc)
  if (!src) return null
  const fileName = savedPath.split(/[\\/]/).pop() || 'generated.png'
  const taskId = typeof blob.task_id === 'string' ? blob.task_id.trim() : ''
  const cacheKey = savedPath || taskId || remote || src
  let srcWithBust = src
  if (src && cacheKey && !/^https?:\/\//i.test(src) && !src.startsWith('data:')) {
    const bust = encodeURIComponent(String(cacheKey).slice(-48))
    srcWithBust = `${src}${src.includes('?') ? '&' : '?'}v=${bust}`
  }
  return {
    src: srcWithBust,
    remoteUrl: /^https?:\/\//i.test(remote) ? remote : '',
    localPath: savedPath,
    message: typeof blob.message === 'string' ? blob.message.trim() : '',
    alt: fileName,
    cacheKey,
  }
}

const _MEDIA_ASSET_TOOL_NAMES = new Set([
  'media_image_generate',
  'media_task_wait',
  'media_video_generate',
])

/** Tool cards already show inline image preview — do not duplicate in message bubble. */
const _MEDIA_INLINE_IMAGE_TOOL_NAMES = new Set(['media_image_generate'])

/** Derive chat bubble images/videos from media_* tool JSON outputs. */
export function inferMediaAssetsFromToolEntries(tools) {
  const images = []
  const videos = []
  const audios = []
  const seen = new Set()
  const pushUnique = (list, item, key) => {
    const k = String(key || '').trim()
    if (!k || seen.has(k)) return
    seen.add(k)
    list.push(item)
  }
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t !== 'object') continue
    const name = String(t.name || t.tool_name || t.toolName || '')
      .trim()
      .toLowerCase()
    if (!_MEDIA_ASSET_TOOL_NAMES.has(name)) continue
    if (_MEDIA_INLINE_IMAGE_TOOL_NAMES.has(name)) continue
    const blob = parseMediaToolOutputBlob(t.output)
    if (!blob || blob.ok === false) continue
    const absolutePath = typeof blob.absolute_path === 'string' ? blob.absolute_path.trim() : ''
    const localPath = typeof blob.local_path === 'string' ? blob.local_path.trim() : ''
    const savedPath = absolutePath || localPath
    const url = typeof blob.url === 'string' ? blob.url.trim() : ''
    const urls = Array.isArray(blob.urls) ? blob.urls.map((x) => String(x || '').trim()).filter(Boolean) : []
    const primary = savedPath || url || urls[0] || ''
    if (
      name === 'media_task_wait'
      && primary
      && !_isVideoLikePath(primary)
      && !_isAudioLikePath(primary)
    ) {
      continue
    }
    if (!primary) {
      const preview = parseMediaImagePreview(t.output, name)
      if (preview?.src) {
        pushUnique(images, { url: preview.src, mediaType: 'image/png' }, preview.src)
      }
      continue
    }
    if (_isVideoLikePath(primary) || name === 'media_video_generate') {
      const src = resolveMediaAssetSrc(savedPath || url || urls[0] || '')
      if (src) pushUnique(videos, { url: src, mediaType: 'video/mp4' }, src)
      continue
    }
    if (_isAudioLikePath(primary)) {
      const src = resolveMediaAssetSrc(primary)
      if (src) pushUnique(audios, { url: src, mediaType: 'audio/mpeg' }, src)
      continue
    }
    const preview = parseMediaImagePreview(t.output, name)
    if (preview?.src) {
      pushUnique(images, { url: preview.src, mediaType: 'image/png' }, preview.src)
    }
  }
  return { images, videos, audios }
}

function mergeToolDerivedMedia(content, tools) {
  if (!content) return content
  const derived = inferMediaAssetsFromToolEntries(tools)
  if (!derived.images.length && !derived.videos.length && !derived.audios.length) return content
  return {
    ...content,
    images: [...(content.images || []), ...derived.images],
    videos: [...(content.videos || []), ...derived.videos],
    audios: [...(content.audios || []), ...derived.audios],
  }
}

/** browser_snapshot / preview_url screenshot JSON or legacy data URI → UI preview metadata */
function _parseBrowserScreenshotJsonObject(o) {
  if (!o || typeof o !== 'object') return null
  if (o.type === 'browser_screenshot' && typeof o.image_url === 'string' && o.image_url) {
    return {
      src: o.image_url,
      summary: typeof o.summary === 'string' ? o.summary : undefined,
      pageUrl: typeof o.page_url === 'string' ? o.page_url : undefined,
    }
  }
  return null
}

function _extractBrowserScreenshotJsonText(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  if (text.startsWith('{') && text.includes('"browser_screenshot"')) return text
  const marker = '"type":"browser_screenshot"'
  const markerSpaced = '"type": "browser_screenshot"'
  let idx = text.lastIndexOf(marker)
  if (idx < 0) idx = text.lastIndexOf(markerSpaced)
  if (idx < 0) return ''
  const start = text.lastIndexOf('{', idx)
  if (start < 0) return ''
  const slice = text.slice(start)
  let depth = 0
  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return slice.slice(0, i + 1)
    }
  }
  return ''
}

export function parseBrowserScreenshotToolOutput(value) {
  if (value == null) return null
  let raw = ''
  if (typeof value === 'string') {
    raw = stripAnsi(value).trim()
  } else if (typeof value === 'object') {
    const fromObj = _parseBrowserScreenshotJsonObject(value)
    if (fromObj) return fromObj
    raw = stripAnsi(formatToolDisplayValue(value)).trim()
  }
  if (!raw) return null
  if (raw.startsWith('data:image/')) {
    return { src: raw.split('\n')[0], summary: undefined, pageUrl: undefined }
  }
  const candidates = [raw, _extractBrowserScreenshotJsonText(raw)]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const o = JSON.parse(candidate)
      const parsed = _parseBrowserScreenshotJsonObject(o)
      if (parsed) return parsed
    } catch {
      /* not JSON */
    }
  }
  return null
}

function _parseBrowserLiveJsonObject(o) {
  if (!o || typeof o !== 'object') return null
  if (o.type === 'browser_live' && (typeof o.stream_ws === 'string' || typeof o.preview_image_url === 'string')) {
    const headedRaw = o.headed
    const embedRaw = o.embed
    const headed =
      headedRaw === true ||
      headedRaw === 'true' ||
      embedRaw === true ||
      embedRaw === 'true' ||
      o.mode === 'headed' ||
      o.mode === 'cdp' ||
      o.mode === 'embed'
    return {
      streamWs: typeof o.stream_ws === 'string' ? o.stream_ws : undefined,
      previewImageUrl: typeof o.preview_image_url === 'string' ? o.preview_image_url : undefined,
      pageUrl: typeof o.page_url === 'string' ? o.page_url : undefined,
      summary: typeof o.summary === 'string' ? o.summary : undefined,
      mode: typeof o.mode === 'string' ? o.mode : undefined,
      headed: headed || undefined,
      embed: o.mode === 'embed' || embedRaw === true || embedRaw === 'true' || undefined,
    }
  }
  return null
}

function _extractBrowserLiveJsonText(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  if (text.startsWith('{') && text.includes('"browser_live"')) return text
  const marker = '"type":"browser_live"'
  const markerSpaced = '"type": "browser_live"'
  let idx = text.lastIndexOf(marker)
  if (idx < 0) idx = text.lastIndexOf(markerSpaced)
  if (idx < 0) return ''
  const start = text.lastIndexOf('{', idx)
  if (start < 0) return ''
  const slice = text.slice(start)
  let depth = 0
  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return slice.slice(0, i + 1)
    }
  }
  return ''
}

/** browser_live JSON from browser(action='open') → EvoPanel live stream metadata */
export function parseBrowserLiveToolOutput(value) {
  if (value == null) return null
  let raw = ''
  if (typeof value === 'string') {
    raw = stripAnsi(value).trim()
  } else if (typeof value === 'object') {
    const fromObj = _parseBrowserLiveJsonObject(value)
    if (fromObj) return fromObj
    raw = stripAnsi(formatToolDisplayValue(value)).trim()
  }
  if (!raw) return null
  const candidates = [raw, _extractBrowserLiveJsonText(raw)]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const o = JSON.parse(candidate)
      const parsed = _parseBrowserLiveJsonObject(o)
      if (parsed) return parsed
    } catch {
      /* not JSON */
    }
  }
  return null
}

function browserScreenshotApiPath(imageUrl) {
  const u = String(imageUrl || '').trim()
  if (!u || u.startsWith('data:image/') || /^https?:\/\//i.test(u)) return u
  if (u.startsWith('/api/')) return u.slice(4)
  return u.startsWith('/') ? u : `/${u.replace(/^\/+/, '')}`
}

/** Resolve Gateway screenshot path for <img src> (Vite proxy or loopback Gateway). */
export function resolveBrowserScreenshotSrc(imageUrl) {
  const path = browserScreenshotApiPath(imageUrl)
  if (!path) return ''
  if (path.startsWith('data:image/') || /^https?:\/\//i.test(path)) return path
  return apiUrl(path)
}

/** Tauri 打包后异步解析 Gateway 端口（sidecar runtime）。 */
export async function resolveBrowserScreenshotSrcAsync(imageUrl) {
  const path = browserScreenshotApiPath(imageUrl)
  if (!path) return ''
  if (path.startsWith('data:image/') || /^https?:\/\//i.test(path)) return path
  return apiUrlAsync(path)
}

/** 工具折叠面板出参：内部摘要 → 一句用户可读说明 */
export function formatToolOutputForUserDisplay(value, toolName) {
  const envMsg = envelopeUserMessageFromToolOutput(value)
  if (envMsg) return envMsg
  const name = String(toolName || '').trim().toLowerCase()
  const raw0 =
    typeof value === 'string' ? stripAnsi(value) : stripAnsi(formatToolDisplayValue(value))
  const raw =
    name === 'rg' || name === 'grep' ? stripToolOutputForDisplay(raw0) : raw0

  if (name === 'subtask_work_checklist') {
    const mapped = formatSubtaskWorkChecklistOutput(value)
    if (mapped) return mapped
  }
  if (name === 'subtask_outcome_report') {
    const mapped = formatSubtaskOutcomeReportOutput(value)
    if (mapped) return mapped
  }

  if (name === 'view_image' || name === 'vision_analyze') {
    try {
      const o = typeof value === 'string' ? JSON.parse(value) : value
      if (o && typeof o === 'object') {
        if (o.mode === 'native') {
          if (o.cached) return '图片已在本会话加载，跳过重复识图'
          const ref = typeof o.image_ref === 'string' ? o.image_ref.trim() : ''
          return ref ? `已加载图片供主模型查看：${ref}` : '已加载图片供主模型查看'
        }
        if (typeof o.analysis === 'string' && o.analysis.trim()) return o.analysis.trim()
        if (typeof o.error === 'string' && o.error.trim()) return `识图失败：${o.error.trim()}`
      }
    } catch {
      /* fall through */
    }
  }

  const browserShot = parseBrowserScreenshotToolOutput(value)
  if (
    browserShot &&
    (name === 'browser' ||
      name === 'browser_snapshot' ||
      name === 'preview_url' ||
      name === 'browser_get_images')
  ) {
    return browserShot.summary || '截图已生成（展开后点击图片可放大查看）'
  }

  const browserLive = parseBrowserLiveToolOutput(value)
  if (browserLive && name === 'browser') {
    return browserLive.summary || (browserLive.pageUrl ? `浏览器已打开：${browserLive.pageUrl}` : '浏览器实时画面已在侧栏显示')
  }

  if (name === 'media_image_generate' || name === 'media_task_wait') {
    const preview = parseMediaImagePreview(value, name)
    if (preview?.src) {
      return '图片已生成'
    }
    const blob = parseMediaToolOutputBlob(value)
    if (blob?.ok === false && typeof blob.message === 'string' && blob.message.trim()) {
      return `生图失败：${blob.message.trim()}`
    }
    if (blob?.status === 'processing') return '图片任务已提交，等待生成…'
  }

  if (isShellToolName(name)) {
    const exit = parseTerminalExitCodeFromOutput(raw)
    if (exit != null && exit !== 0) {
      const errLine = extractTerminalErrorSummary(raw)
      return errLine ? `命令失败 (exit ${exit})：${errLine}` : `命令失败 (exit ${exit})`
    }
  }

  // 微信聊天工具：显示简洁摘要
  if (name === 'wechat_chat' || name === 'wechat_send' || name === 'send_wechat_message') {
    try {
      const o = typeof value === 'string' ? JSON.parse(value) : value
      if (o && typeof o === 'object') {
        const contact = String(o.contact || '').trim()
        const msg = String(o.message || '').trim()
        const ok = o.ok === true
        if (ok && contact) {
          const brief = msg.length > 40 ? `${msg.slice(0, 40)}…` : msg
          return `消息已发送给 ${contact}${brief ? `：${brief}` : ''}`
        }
        if (!ok && o.error) {
          return `微信发送失败：${String(o.error).trim()}`
        }
      }
    } catch {
      /* fall through */
    }
  }

  // 所有工具：主页面不内联大段正文，完整内容走弹窗 /tool-results
  if (raw.trim()) {
    const trimmed = raw.trimStart()
    const isExplicitToolSummary =
      trimmed.startsWith('[tool:summary]') ||
      /^\[ToolResult (summary|persisted)/i.test(trimmed)
    if (isExplicitToolSummary) {
      if (/\[ToolResult persisted\]/i.test(raw) || /\bFull output:/i.test(raw)) {
        const pathM = raw.match(/Full output:\s*(\S+)/i)
        const pathHint = pathM ? pathM[1] : ''
        return pathHint ? `大文件已落盘：${pathHint}（点击查看）` : '（点击查看完整内容）'
      }
      return '（点击查看完整内容）'
    }
    if (raw.length <= 160 && !raw.includes('\n')) {
      return raw
    }
    return ''
  }

  if (_FULL_INLINE_TOOL_OUTPUT_NAMES.has(name)) {
    const trimmed = raw.trimStart()
    const isExplicitToolSummary =
      trimmed.startsWith('[tool:summary]') ||
      /^\[ToolResult (summary|persisted)/i.test(trimmed)
    if (!isExplicitToolSummary) {
      const display = formatToolDisplayValue(value)
      if (display.length <= _UI_TOOL_OUTPUT_MAX) return display
      return `${display.slice(0, _UI_TOOL_OUTPUT_MAX)}\n…（界面预览已截断，完整内容在工具消息中）`
    }
    if (/\[ToolResult persisted\]/i.test(raw) || /\bFull output:/i.test(raw)) {
      const pathM = raw.match(/Full output:\s*(\S+)/i)
      const summary = raw.split(/\n\nFull output:/i)[0].replace(/^\[ToolResult[^\]]*\][^\n]*\n?/i, '').trim()
      const pathHint = pathM ? pathM[1] : ''
      const brief = summary.length > 400 ? `${summary.slice(0, 400)}…` : summary
      return pathHint
        ? `大文件已落盘：${pathHint}\n${brief}\n（助手可用 read_file 指定 offset/limit 分页；单行 JSON 按页约 8k 字符）`
        : brief || raw
    }
  }

  if (!isStructuredToolSummaryText(raw)) return formatToolDisplayValue(value)
  const core = _extractSummaryField(raw, 'core')
  const status = _extractSummaryField(raw, 'status')
  const ok = !status || /success|ok|完成/i.test(status)

  if (name === 'search_code_index' || name === 'search_content' || name === 'grep') {
    const hitPaths = _extractSearchHitPathsFromToolOutput(raw)
    const pathHint = hitPaths.length ? hitPaths.slice(0, 3).join(', ') : ''
    if (core && ok) {
      const brief = core.length > 200 ? `${core.slice(0, 200)}…` : core
      if (pathHint) return `代码检索已完成（${pathHint}）${brief ? `：${brief}` : ''}`
      return `代码检索已完成：${brief}`
    }
    if (pathHint) return `代码检索已完成（${pathHint}）`
    return '代码检索已完成（命中详情已压缩，仅供助手内部推理）。'
  }

  if (core) {
    const brief = core.length > 320 ? `${core.slice(0, 320)}…` : core
    return ok ? `工具执行完成：${brief}` : `工具执行异常：${brief}`
  }
  return '工具返回已压缩（内部摘要，不向用户展示全文）。'
}

/** LangChain SummarizationMiddleware 注入的 HumanMessage（无 name 的旧 checkpoint 仍靠前缀识别） */
function isHandoffSummaryHumanContent(head) {
  const s = typeof head === 'string' ? head.trimStart().toLowerCase() : ''
  return (
    s.startsWith('here is a summary of the conversation to date') ||
    s.startsWith("here's a summary of the conversation to date") ||
    isContextCompactionContent(head)
  )
}

/** 是否应从聊天列表隐藏（压缩摘要、中间件注入 human 等） */
export function isCompactionUiMessage(msg) {
  if (!msg || typeof msg !== 'object') return false
  if (isInjectedHumanUiMessage(msg)) return true
  const head = peekRawTextForRoleHint(msg)
  return isContextCompactionContent(head)
}

/** 非真实用户输入的 HumanMessage（压缩摘要、工具历史合并块、协作 hint 等） */
export function isInjectedCheckpointHuman(msg) {
  return isCompactionUiMessage(msg)
}

/** 模型切换分隔线前缀（与 ChatApp.tsx MODEL_SWITCH_SEPARATOR_PREFIX 保持一致） */
export const MODEL_SWITCH_SEPARATOR_PREFIX = '[MODEL_SWITCH]'

/** 判断文本是否为模型切换分隔线消息 */
export function isModelSwitchSeparatorText(text) {
  const s = typeof text === 'string' ? text.trimStart() : ''
  return s.startsWith(MODEL_SWITCH_SEPARATOR_PREFIX)
}

/** 从模型切换分隔线消息中提取展示文本（去掉前缀） */
export function extractModelSwitchSeparatorDisplayText(text) {
  const s = String(text || '').trimStart()
  if (!s.startsWith(MODEL_SWITCH_SEPARATOR_PREFIX)) return s
  return s.slice(MODEL_SWITCH_SEPARATOR_PREFIX.length).trimStart()
}

function isInjectedHumanUiMessage(msg) {
  if (!msg || typeof msg !== 'object') return false
  const n = msg.name != null ? String(msg.name).trim() : ''
  if (n && INJECTED_HUMAN_MESSAGE_NAMES.has(n)) return true
  const head = peekRawTextForRoleHint(msg)
  if (head.startsWith('<xiaomi_ui_context>')) return true
  if (head.startsWith('[LOOP DETECTED]') || head.startsWith('[FORCED STOP]')) return true
  if (isHandoffSummaryHumanContent(head)) return true
  if (isModelSwitchSeparatorText(head)) return true
  if (head.toLowerCase().startsWith(TOOL_APPROVAL_MARKER.toLowerCase())) return true
  if (head.toLowerCase().startsWith(TOOL_APPROVAL_REPLAY_MARKER.toLowerCase())) return true
  if (head.startsWith('用户工具授权操作：')) return true
  return false
}

export function normalizeHistoryRole(msg) {
  if (!msg || typeof msg !== 'object') return 'assistant'
  if (msg.role === 'tool' || msg.role === 'toolResult') return 'assistant'
  if (msg.role === 'user') return isInjectedHumanUiMessage(msg) ? 'system' : 'user'
  if (msg.role === 'assistant') return 'assistant'
  if (isInjectedHumanUiMessage(msg)) return 'system'
  const t = msg.type
  const tLower = typeof t === 'string' ? t.toLowerCase() : ''
  if (tLower === 'human' || tLower === 'humanmessage' || t === 'user') return 'user'
  if (t === 'ai' || t === 'AIMessage' || t === 'AIMessageChunk' || t === 'assistant') return 'assistant'
  if (tLower === 'tool' || tLower === 'tool_message' || tLower === 'toolmessage') return 'assistant'
  if (t === 'system') return 'assistant'
  return 'assistant'
}

function toolEntryId(t) {
  return String(t.id || t.tool_call_id || '')
}

function buildInitialSegments(c, tools) {
  const segs = []
  if (c?.text) segs.push({ kind: 'text', text: c.text })
  const ids = (tools || []).map((t) => toolEntryId(t)).filter(Boolean)
  if (ids.length) segs.push({ kind: 'tools', ids })
  return segs.length ? segs : undefined
}

function lastToolsSegmentIndexForOrder(segments) {
  let last = -1
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]?.kind === 'tools') last = i
  }
  return last
}

/**
 * 保证思考段在最终汇报正文之前（流式封存误序 / 落库 display_segments 误序时修正）。
 */
export function normalizeAssistantSegmentTimelineOrder(segments) {
  if (!Array.isArray(segments) || segments.length < 2) return segments

  let list = segments.filter(Boolean)
  if (
    list.length >= 2 &&
    list.every((s) => s && typeof s.seq === 'number' && Number.isFinite(s.seq))
  ) {
    const seqs = list.map((s) => s.seq)
    if (new Set(seqs).size === seqs.length) {
      list = [...list].sort((a, b) => a.seq - b.seq)
    }
  }
  const lastTools = lastToolsSegmentIndexForOrder(list)
  let finalTextIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.kind !== 'text') continue
    if (lastTools >= 0 && i <= lastTools) continue
    finalTextIdx = i
    break
  }

  if (finalTextIdx < 0) {
    const firstText = list.findIndex((s) => s?.kind === 'text')
    if (firstText < 0) return list
    const hasReasoningAfter = list.some((s, j) => j > firstText && s?.kind === 'reasoning')
    if (!hasReasoningAfter) return list
    // 工具批次前的短旁白：后面还有 tools 时不前移 reasoning，避免「思考在上、正文卡在下」
    const hasToolsAfterText = list.some((s, j) => j > firstText && s?.kind === 'tools')
    if (hasToolsAfterText) return list
    const misplaced = list.filter((s, j) => j > firstText && s?.kind === 'reasoning')
    const kept = list.filter((s, j) => !(j > firstText && s?.kind === 'reasoning'))
    return [...kept.slice(0, firstText), ...misplaced, ...kept.slice(firstText)]
  }

  const misplaced = list.filter((s, i) => s?.kind === 'reasoning' && i > finalTextIdx)
  if (!misplaced.length) return list

  const kept = list.filter((s, i) => !(s?.kind === 'reasoning' && i > finalTextIdx))
  let insertAt = finalTextIdx
  for (let i = 0; i < kept.length; i++) {
    if (kept[i]?.kind === 'text' && (lastTools < 0 || i > lastTools)) {
      insertAt = i
      break
    }
  }
  return [...kept.slice(0, insertAt), ...misplaced, ...kept.slice(insertAt)]
}

function injectHistoryReasoningList(base, reasoningList) {
  const raw = Array.isArray(base) ? base.filter(Boolean) : []
  const list = (reasoningList || []).map((t) => String(t || '')).filter(Boolean)
  if (!list.length) {
    return raw.length ? normalizeAssistantSegmentTimelineOrder(raw) : undefined
  }
  const cleaned = stripReasoningFromSegments(raw)

  if (list.length === 1) {
    let out = [...cleaned]
    const firstTools = out.findIndex((s) => s?.kind === 'tools')
    if (firstTools > 0) {
      const leadingTexts = out.slice(0, firstTools).filter((s) => s?.kind === 'text')
      const trailingTexts = out.slice(firstTools + 1).filter((s) => s?.kind === 'text')
      if (leadingTexts.length === 1 && trailingTexts.length === 0) {
        // buildInitialSegments 把最终回复正文放在 tools 之前；移到 tools 之后，
        // 得到 [tools, text]（工具→最终回复）的正确时序。
        out = [...out.slice(firstTools, firstTools + 1), ...leadingTexts]
      }
    }
    // reasoning 代表本轮初始思考，放在时间线最前 → [reasoning, tools, text]，
    // 与流式 buildStreamTimelineLayout（思考→工具→正文）顺序一致。
    // 旧代码把 reasoning 插在 tools 之后 → [tools, reasoning, text]，
    // 导致工具顶到最上方、思考正文沉到下方，流式→落库时出现顺序跳变。
    out.unshift({ kind: 'reasoning', text: list[0] })
    return normalizeAssistantSegmentTimelineOrder(out)
  }

  const interleaved = interleaveReasoningIntoSegments(cleaned, list)
  return interleaved ? normalizeAssistantSegmentTimelineOrder(interleaved) : undefined
}

/**
 * 未写入 segments 的工具块：附在时间线末尾（其后若还有 row.text 尾段，由 UI 再渲染）。
 * 勿插在「开头第一段正文」后，否则「正文 → 工具」会变成工具顶到前文上方。
 */
export function insertOrphanToolsIntoSegments(segments, orphanIds) {
  if (!Array.isArray(segments) || !orphanIds?.length) return segments
  const ids = orphanIds.map((id) => String(id).trim()).filter(Boolean)
  if (!ids.length) return segments
  const hasToolsSeg = (segments || []).some((s) => s?.kind === 'tools')
  let insertAt = segments.length
  if (hasToolsSeg) {
    // 已有 tools 段：插在末尾封存正文之前，勿回溯到开头计划段
    while (insertAt > 0 && segments[insertAt - 1]?.kind === 'text') {
      insertAt -= 1
    }
  }
  // 尚无 tools 段：附在时间线末尾，保持「计划正文 → 工具」顺序
  return [...segments.slice(0, insertAt), { kind: 'tools', ids }, ...segments.slice(insertAt)]
}

function isValidHistorySegment(seg) {
  if (!seg || typeof seg !== 'object') return false
  const kind = String(seg.kind || '')
  if (kind === 'text') return typeof seg.text === 'string' && !!String(seg.text).trim()
  if (kind === 'tools') return Array.isArray(seg.ids) && seg.ids.length > 0
  if (kind === 'reasoning') return typeof seg.text === 'string' && !!String(seg.text).trim()
  return false
}

/** API / 落库消息的 ``content_json`` 载荷 */
export function resolveHistoryContentJson(msg) {
  if (!msg || typeof msg !== 'object') return null
  const cj = msg.content_json ?? msg.contentJson
  if (cj && typeof cj === 'object') return cj
  // 兼容 content_json 为 JSON 字符串的情况（部分 API/旧数据可能返回字符串）
  if (typeof cj === 'string' && cj.trim()) {
    try {
      const parsed = JSON.parse(cj)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* keep null */ }
  }
  return null
}

/** 历史 API 正文：优先 ``content_json.content``，兼容旧顶层 ``content`` */
export function resolveHistoryMessageContent(msg) {
  if (!msg || typeof msg !== 'object') return undefined
  const cj = resolveHistoryContentJson(msg)
  if (cj && Object.prototype.hasOwnProperty.call(cj, 'content')) return cj.content
  if (msg.content !== undefined) return msg.content
  return undefined
}

/** 历史 API 工具调用：优先 ``content_json.tool_calls``，兼容旧顶层 ``tool_calls`` */
export function resolveHistoryMessageToolCalls(msg) {
  if (!msg || typeof msg !== 'object') return null
  const cj = resolveHistoryContentJson(msg)
  if (Array.isArray(cj?.tool_calls) && cj.tool_calls.length) return cj.tool_calls
  const top = msg.tool_calls ?? msg.toolCalls
  return Array.isArray(top) && top.length ? top : null
}

function historyMessageBodyView(msg) {
  if (!msg || typeof msg !== 'object') return msg
  const content = resolveHistoryMessageContent(msg)
  const tool_calls = resolveHistoryMessageToolCalls(msg)
  const view = { ...msg }
  if (content !== undefined) view.content = content
  if (tool_calls) view.tool_calls = tool_calls
  return view
}

/** ``content_json.ui.reasoning_segments`` → 多轮思考文本数组（legacy 落库字段，只读兼容） */
export function parseReasoningSegmentsFromHistoryMessage(msg) {
  if (!msg || typeof msg !== 'object') return null
  const cj = resolveHistoryContentJson(msg)
  const arr = cj?.ui?.reasoning_segments
  if (!Array.isArray(arr) || !arr.length) return null
  const list = arr.map((t) => String(t || '').trim()).filter(Boolean)
  return list.length ? list : null
}

/**
 * 将多轮思考按工具段边界插入时间线（与流式 tool_call 后新开思考段一致）。
 * 无 tools 段时全部思考块在开头。
 */
export function interleaveReasoningIntoSegments(segments, reasoningSegments) {
  const base = Array.isArray(segments) ? segments.filter(Boolean) : []
  const list = Array.isArray(reasoningSegments)
    ? reasoningSegments.map((t) => String(t || '')).filter(Boolean)
    : []
  if (!list.length) return base.length ? normalizeAssistantSegmentTimelineOrder(base) : undefined
  if (base.some((s) => s && s.kind === 'reasoning')) {
    return normalizeAssistantSegmentTimelineOrder(base)
  }

  const out = []
  let r = 0
  if (r < list.length) out.push({ kind: 'reasoning', text: list[r++] })

  for (let i = 0; i < base.length; i++) {
    const seg = base[i]
    out.push(seg)
    if (seg.kind === 'tools' && r < list.length) {
      out.push({ kind: 'reasoning', text: list[r++] })
    }
  }
  while (r < list.length) out.push({ kind: 'reasoning', text: list[r++] })
  return out.length ? normalizeAssistantSegmentTimelineOrder(out) : undefined
}

function applyReasoningToHistorySegments(base, msg) {
  const reasoningList = collectReasoningListFromHistoryMessage(msg)
  const raw = Array.isArray(base) ? base.filter(Boolean) : []
  if (!reasoningList?.length) {
    return raw.length ? normalizeAssistantSegmentTimelineOrder(raw) : base
  }
  if (raw.some((s) => s?.kind === 'reasoning')) {
    return normalizeAssistantSegmentTimelineOrder(raw)
  }
  return injectHistoryReasoningList(raw, reasoningList) ?? base
}

function collectReasoningListFromHistoryMessage(msg) {
  const fromJson = parseReasoningSegmentsFromHistoryMessage(msg)
  if (fromJson?.length) return fromJson
  const preview = pickReasoningPreviewFromHistoryMessage(msg)
  return preview ? [preview] : null
}

function stripReasoningFromSegments(segments) {
  if (!Array.isArray(segments)) return []
  return segments.filter((s) => s && s.kind !== 'reasoning')
}

function rebuildSegmentsWithReasoningList(segments, reasoningList) {
  return injectHistoryReasoningList(segments, reasoningList) ?? undefined
}

/** 合并 assistant 行后同步 reasoning 字段与时间线（API 历史多段 AIMessage 合并） */
function syncAssistantRowReasoning(row, msg) {
  if (!row || row.role !== 'assistant' || !msg) return
  const incoming = collectReasoningListFromHistoryMessage(msg)
  if (incoming?.length) {
    row.reasoningSegments = mergeReasoningSegmentArrays(row.reasoningSegments, incoming)
  }
  const preview = pickReasoningPreviewFromHistoryMessage(msg)
  if (preview) row.reasoningPreview = preview
  const list = row.reasoningSegments?.length
    ? row.reasoningSegments
    : row.reasoningPreview
      ? [row.reasoningPreview]
      : null
  if (list?.length) {
    row.segments = rebuildSegmentsWithReasoningList(row.segments, list)
  }
}

/** 展示用思考段：优先 reasoningSegments，其次时间线，最后 reasoningPreview */
export function resolveDisplayReasoningSegments(row) {
  if (!row || typeof row !== 'object') return []
  const fromArr = Array.isArray(row.reasoningSegments)
    ? row.reasoningSegments.map((t) => String(t || '').trim()).filter(Boolean)
    : []
  if (fromArr.length) return fromArr
  const fromTimeline = (Array.isArray(row.segments) ? row.segments : [])
    .filter((s) => s && s.kind === 'reasoning')
    .map((s) => String(s.text || '').trim())
    .filter(Boolean)
  if (fromTimeline.length) return fromTimeline
  const preview = String(row.reasoningPreview || '').trim()
  return preview ? [preview] : []
}

function buildAssistantHistorySegments(c, tools, msg) {
  const base = buildInitialSegments(c, tools)
  return applyReasoningToHistorySegments(base, msg)
}

function mergeReasoningSegmentArrays(prev, next) {
  const a = Array.isArray(prev) ? prev.map((t) => String(t || '').trim()).filter(Boolean) : []
  const b = Array.isArray(next) ? next.map((t) => String(t || '').trim()).filter(Boolean) : []
  if (!b.length) return a.length ? a : undefined
  if (!a.length) return b
  const lastA = a[a.length - 1]
  const firstB = b[0]
  if (lastA === firstB && b.length === 1) return a
  if (lastA && firstB && (lastA.includes(firstB) || firstB.includes(lastA))) {
    a[a.length - 1] = firstB.length >= lastA.length ? firstB : lastA
    if (b.length === 1) return a
    return [...a, ...b.slice(1)]
  }
  return [...a, ...b]
}

/** 交错 segments + 尾部流式文本 → 单行全文（元数据 / 旧逻辑用） */
export function flattenStreamDisplayText(segments, tailText) {
  const parts = []
  for (const s of segments || []) {
    if (s.kind === 'text' && s.text) {
      parts.push(
        unwrapAssistantContentJsonEnvelope(stripLegacyEmbeddedReasoningPrefix(s.text)),
      )
    }
  }
  if (tailText) {
    parts.push(
      unwrapAssistantContentJsonEnvelope(stripLegacyEmbeddedReasoningPrefix(tailText)),
    )
  }
  return parts.join('\n')
}

/** 流式展示/调试：与 joinStreamTextSegments 相同，不对正文做 strip/trim */
export function flattenStreamDisplayTextRaw(segments, tailText) {
  return joinStreamTextSegments(segments, tailText)
}

/** 与 flattenStreamDisplayText 一致：用于流式 delta 前缀比对（勿无换行硬拼） */
export function joinStreamTextSegments(segments, tailText) {
  const parts = []
  for (const s of segments || []) {
    if (s?.kind === 'text' && s.text) parts.push(String(s.text))
  }
  if (tailText) parts.push(String(tailText))
  return parts.join('\n')
}

/** 去空白后比较两段 assistant 正文是否实质相同（流式封存 vs final 全文） */
export function assistantBodiesLooselySame(a, b) {
  const ca = String(a || '').replace(/\s+/g, '')
  const cb = String(b || '').replace(/\s+/g, '')
  if (!ca || !cb) return ca === cb
  if (ca === cb) return true
  if (ca.length < 32 || cb.length < 32) return false
  return ca.includes(cb) || cb.includes(ca)
}

/** 宽松归一化：容忍 \\n 数量与空白差异 */
export function normalizeStreamPlainLoose(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trimEnd()
}

/**
 * 状态行改写（如「删 ✅ | 收工」→「全部删 ✅ | 收工」）：非前缀增长，应覆盖而非追加。
 * @param {string} prev
 * @param {string} incoming
 */
export function isStreamAssistantLineRewrite(prev, incoming) {
  const p = String(prev || '').trimEnd()
  const n = String(incoming || '').trimEnd()
  if (!p || !n) return false
  const pm = p.match(/\|\s*([^\n|]+)\s*$/)
  const nm = n.match(/\|\s*([^\n|]+)\s*$/)
  if (pm && nm && pm[1] === nm[1] && n.length >= 4) return true
  for (let k = Math.min(p.length, n.length, 80); k >= 6; k--) {
    if (p.slice(-k) === n.slice(-k)) return true
  }
  return false
}

/**
 * @param {string} materialized
 * @param {string} inc
 * @returns {string | null} 增量后缀；null 表示无法用前缀规则解析
 */
export function streamTextSuffixAfterPrefix(materialized, inc) {
  const m = String(materialized || '')
  const n = String(inc || '')
  if (!m) return n
  if (n.startsWith(m)) return n.slice(m.length)
  const mL = normalizeStreamPlainLoose(m)
  const nL = normalizeStreamPlainLoose(n)
  if (nL.startsWith(mL)) return nL.slice(mL.length).replace(/^\n+/, '')
  const mNo = m.replace(/\s+/g, '')
  const nNo = n.replace(/\s+/g, '')
  if (nNo.startsWith(mNo)) {
    const extra = nNo.slice(mNo.length)
    return extra ? n.slice(n.length - extra.length) : ''
  }
  return null
}

function findLastTextSegmentIndex(segments) {
  for (let i = (segments || []).length - 1; i >= 0; i--) {
    if (segments[i]?.kind === 'text') return i
  }
  return -1
}

function streamTimelineHasToolsSegment(segments) {
  return (segments || []).some((s) => s?.kind === 'tools')
}

/**
 * 端到端纯 delta：仅把本帧 piece 追加到 tail（Exploring 后禁止整段覆盖）。
 * @param {Array<{ kind: string; text?: string }>} segments
 * @param {string} tailText
 * @param {string} piece
 */
export function appendStreamAssistantTextPiece(segments, tailText, piece) {
  const p = String(piece || '')
  const segs = Array.isArray(segments) ? [...segments] : []
  let tail = String(tailText || '')
  if (!p) return { segments: segs, tailText: tail, changed: false }

  const materialized = joinStreamTextSegments(segs, tail)
  if (materialized.endsWith(p)) return { segments: segs, tailText: tail, changed: false }

  if (tail && isStreamAssistantLineRewrite(tail, p)) {
    return { segments: segs, tailText: p, changed: true }
  }

  const maxOverlap = Math.min(tail.length, p.length, 200)
  for (let k = maxOverlap; k >= 1; k--) {
    if (tail.slice(-k) === p.slice(0, k)) {
      const next = tail + p.slice(k)
      if (next !== tail) {
        return { segments: segs, tailText: next, changed: true }
      }
      return { segments: segs, tailText: tail, changed: false }
    }
  }

  if (streamTimelineHasToolsSegment(segs)) {
    const segPlain = joinStreamTextSegments(segs, '')
    if (segPlain && p.startsWith(segPlain)) {
      const rest = p.slice(segPlain.length).replace(/^\n+/, '')
      if (!rest) return { segments: segs, tailText: tail, changed: false }
      if (tail.endsWith(rest)) return { segments: segs, tailText: tail, changed: false }
      return { segments: segs, tailText: tail + rest, changed: true }
    }
    return { segments: segs, tailText: tail + p, changed: true }
  }

  return { segments: segs, tailText: tail + p, changed: true }
}

/**
 * 气泡 Markdown 展示：去掉尾部多余空行，避免正文与下方工具块之间出现大片空白段落。
 */
export function trimAssistantBubbleMarkdown(text) {
  return String(text || '')
    .replace(/\n{3,}$/, '\n\n')
    .trimEnd()
}

/**
 * 流式气泡底部 tail：去掉已在 segments 封存过的前缀，避免工具间正文重复出现在最下方。
 * @param {Array<{ kind: string; text?: string }>} segments
 * @param {string} tailText
 */
export function streamLiveTailForDisplay(segments, tailText) {
  const tail = String(tailText || '')
  if (!tail.trim()) return ''
  const segPlain = joinStreamTextSegments(segments, '')
  if (!segPlain) return tail
  if (tail === segPlain) return ''
  const suffix = streamTextSuffixAfterPrefix(segPlain, tail)
  if (suffix !== null) return suffix.replace(/^\n+/, '')
  const lastIdx = findLastTextSegmentIndex(segments)
  if (lastIdx >= 0) {
    const lastSeg = String(segments[lastIdx].text || '')
    const lastSuffix = streamTextSuffixAfterPrefix(lastSeg, tail)
    if (lastSuffix !== null && lastSuffix !== tail) {
      // 短封存段 + 仍在增长的 tail（如误封存「好」后流式「好，…」）应保留全文
      if (
        lastSeg.length <= 4 &&
        tail.startsWith(lastSeg) &&
        tail.length > lastSeg.length
      ) {
        return tail
      }
      return lastSuffix.replace(/^\n+/, '')
    }
  }
  return tail
}

/**
 * 时间线已有 tools 段：只单调扩展 tail，禁止整段 replace / 拼接导致覆盖或重复。
 */
function applyStreamAssistantTextDeltaAfterTools(segments, tailText, incoming) {
  const inc = String(incoming || '')
  const segs = Array.isArray(segments) ? [...segments] : []
  let tail = String(tailText || '')
  if (!inc) return { segments: segs, tailText: tail, changed: false }

  const materialized = joinStreamTextSegments(segs, tail)
  if (inc === materialized) return { segments: segs, tailText: tail, changed: false }
  if (materialized.startsWith(inc)) return { segments: segs, tailText: tail, changed: false }

  const appendSuffixToTail = (suffixRaw) => {
    const suffix = String(suffixRaw || '')
    if (!suffix) return false
    if (!tail && segs.some((s) => s?.kind === 'text')) {
      tail = suffix.replace(/^\n+/, '')
    } else {
      tail = `${tail}${suffix}`
    }
    return true
  }

  const suffix = streamTextSuffixAfterPrefix(materialized, inc)
  if (suffix !== null) {
    if (!suffix) return { segments: segs, tailText: tail, changed: false }
    if (!appendSuffixToTail(suffix)) return { segments: segs, tailText: tail, changed: false }
    return { segments: segs, tailText: tail, changed: true }
  }

  const segPlain = joinStreamTextSegments(segs, '')
  if (segPlain) {
    const segSuffix = streamTextSuffixAfterPrefix(segPlain, inc)
    if (segSuffix !== null) {
      const nextTail = segSuffix.replace(/^\n+/, '')
      if (nextTail === tail) return { segments: segs, tailText: tail, changed: false }
      return { segments: segs, tailText: nextTail, changed: true }
    }
    if (inc.startsWith(segPlain) && inc.length > segPlain.length) {
      const nextTail = inc.slice(segPlain.length).replace(/^\n+/, '')
      if (nextTail !== tail) return { segments: segs, tailText: nextTail, changed: true }
    }
    const lastIdx = findLastTextSegmentIndex(segs)
    const lastSegText = lastIdx >= 0 ? String(segs[lastIdx].text || '') : ''
    if (lastSegText) {
      const lastSuffix = streamTextSuffixAfterPrefix(lastSegText, inc)
      if (lastSuffix !== null) {
        const nextTail = lastSuffix.replace(/^\n+/, '')
        if (nextTail !== tail) return { segments: segs, tailText: nextTail, changed: true }
      }
      if (inc.startsWith(lastSegText) && inc.length > lastSegText.length) {
        const nextTail = inc.slice(lastSegText.length).replace(/^\n+/, '')
        if (nextTail !== tail) return { segments: segs, tailText: nextTail, changed: true }
      }
    }
  }

  if (tail && inc.startsWith(tail) && inc.length > tail.length) {
    return { segments: segs, tailText: inc, changed: true }
  }
  if (tail.startsWith(inc)) return { segments: segs, tailText: tail, changed: false }

  const lastIdx = findLastTextSegmentIndex(segs)
  const lastSegText = lastIdx >= 0 ? String(segs[lastIdx].text || '') : ''
  if (lastSegText && isStreamAssistantLineRewrite(lastSegText, inc)) {
    segs[lastIdx] = { kind: 'text', text: inc }
    return { segments: segs, tailText: '', changed: true }
  }
  if (tail && isStreamAssistantLineRewrite(tail, inc)) {
    return { segments: segs, tailText: inc, changed: true }
  }

  // ws 仅推送工具后的新段落（不含已封存 segPlain）：允许写入 tail
  if (!tail.trim() && segPlain) {
    const segLoose = normalizeStreamPlainLoose(segPlain)
    const incLoose = normalizeStreamPlainLoose(inc)
    if (!incLoose.startsWith(segLoose) && inc.length > 0) {
      return { segments: segs, tailText: inc, changed: true }
    }
  }

  return { segments: segs, tailText: tail, changed: false }
}

/**
 * 流式 assistant 正文合并进 segments + tail（ChatApp streamRef 用）。
 * @param {Array<{ kind: string; text?: string }>} segments
 * @param {string} tailText
 * @param {string} incoming
 * @returns {{ segments: typeof segments; tailText: string; changed: boolean }}
 */
export function applyStreamAssistantTextDelta(segments, tailText, incoming) {
  const inc = String(incoming || '')
  const segs = Array.isArray(segments) ? [...segments] : []
  let tail = String(tailText || '')
  if (!inc) return { segments: segs, tailText: tail, changed: false }

  if (streamTimelineHasToolsSegment(segs)) {
    return applyStreamAssistantTextDeltaAfterTools(segs, tail, inc)
  }

  const materialized = joinStreamTextSegments(segs, tail)
  if (inc === materialized) return { segments: segs, tailText: tail, changed: false }

  const suffix = streamTextSuffixAfterPrefix(materialized, inc)
  if (suffix !== null) {
    if (!suffix) return { segments: segs, tailText: tail, changed: false }
    if (!tail && segs.some((s) => s?.kind === 'text')) {
      // segment 与 tail 展示时已用 \n 连接，去掉后缀前导换行避免空行堆叠
      tail = suffix.replace(/^\n+/, '')
    } else {
      // 累计全文后缀原样拼接（如 " world"），不可插入换行
      tail = `${tail}${suffix}`
    }
    return { segments: segs, tailText: tail, changed: true }
  }

  // ws 累积全文已含封存 segments，但 materialized 因换行/空白与 inc 前缀未对齐：只把差分写入 tail
  const segPlain = joinStreamTextSegments(segs, '')
  if (segPlain) {
    const segSuffix = streamTextSuffixAfterPrefix(segPlain, inc)
    if (segSuffix !== null) {
      const nextTail = segSuffix.replace(/^\n+/, '')
      if (nextTail !== tail) {
        return { segments: segs, tailText: nextTail, changed: true }
      }
      return { segments: segs, tailText: tail, changed: false }
    }
    if (inc.startsWith(segPlain) && inc.length > segPlain.length) {
      const nextTail = inc.slice(segPlain.length).replace(/^\n+/, '')
      if (nextTail !== tail) {
        return { segments: segs, tailText: nextTail, changed: true }
      }
    }
  }

  // 末行补全：已有「读」，上行再发「读 ✅\n\n」时覆盖末行，避免「读读 ✅」
  const lastNl = materialized.lastIndexOf('\n')
  const lastLine = lastNl >= 0 ? materialized.slice(lastNl + 1) : materialized
  if (lastLine && inc.startsWith(lastLine) && inc.length > lastLine.length) {
    const extension = inc.slice(lastLine.length).replace(/^\n+/, '')
    if (tail === lastLine) {
      return { segments: segs, tailText: inc, changed: true }
    }
    const lastIdx = findLastTextSegmentIndex(segs)
    const lastSegText = lastIdx >= 0 ? String(segs[lastIdx].text || '') : ''
    if (!tail && lastSegText === lastLine) {
      if (extension) {
        return { segments: segs, tailText: extension, changed: true }
      }
      return { segments: segs, tailText: tail, changed: false }
    }
  }

  const prevText = tail
  if (prevText && inc.startsWith(prevText)) {
    tail = inc
    return { segments: segs, tailText: tail, changed: true }
  }
  if (prevText.startsWith(inc)) return { segments: segs, tailText: tail, changed: false }

  const lastIdx = findLastTextSegmentIndex(segs)
  const lastSegText = lastIdx >= 0 ? String(segs[lastIdx].text || '') : ''
  if (lastSegText && isStreamAssistantLineRewrite(lastSegText, inc)) {
    segs[lastIdx] = { kind: 'text', text: inc }
    return { segments: segs, tailText: '', changed: true }
  }

  const maxOverlap = Math.min(prevText.length, inc.length, 240)
  for (let k = maxOverlap; k >= 40; k--) {
    if (prevText.endsWith(inc.slice(0, k))) {
      const next = prevText + inc.slice(k)
      if (next !== prevText) {
        return { segments: segs, tailText: next, changed: true }
      }
      return { segments: segs, tailText: tail, changed: false }
    }
  }

  // 仅状态行改写（| 尾标 / 末段重叠），禁止「前 48 字相同」就把长文 tail 整段替换（Exploring 后常见）
  if (prevText && isStreamAssistantLineRewrite(prevText, inc)) {
    return { segments: segs, tailText: inc, changed: true }
  }

  if (!prevText && !lastSegText) {
    return { segments: segs, tailText: inc, changed: true }
  }

  tail = prevText + inc
  return { segments: segs, tailText: tail, changed: true }
}

/** 从落库/API 消息恢复思考区（``content_json.reasoning`` 或流式 thinking 块） */
export function pickReasoningPreviewFromHistoryMessage(msg) {
  if (!msg || typeof msg !== 'object') return null
  const cj = resolveHistoryContentJson(msg)
  if (typeof cj?.reasoning === 'string' && cj.reasoning) {
    return cj.reasoning.slice(0, 8000)
  }
  const ak = msg.additional_kwargs
  if (ak && typeof ak.reasoning_content === 'string' && ak.reasoning_content) {
    return ak.reasoning_content.slice(0, 8000)
  }
  const content = resolveHistoryMessageContent(msg)
  if (typeof content === 'string') {
    const env = parseAssistantContentJsonEnvelope(content)
    if (env?.reasoning) return env.reasoning.slice(0, 8000)
  }
  if (Array.isArray(content)) {
    const think = content.find((p) => p && p.type === 'thinking' && typeof p.thinking === 'string')
    if (think?.thinking) return think.thinking.slice(0, 8000)
  }
  return null
}

/**
 * 按「轮次」补齐展示行 runId：user 定锚 → 其后 assistant 与合并进来的 tools 同源。
 */
export function enrichDisplayRowsRunIds(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows
  let current = null
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row
    const role = row.role
    const rid = String(row.runId || row.run_id || '').trim() || null
    if (role === 'user') {
      if (rid) current = rid
      else if (current) return { ...row, runId: current }
      return row
    }
    const nextRid = rid || current
    const next = nextRid ? { ...row, runId: nextRid } : { ...row }
    if (nextRid) current = nextRid
    if (Array.isArray(next.tools) && next.tools.length) {
      next.tools = next.tools.map((t) => {
        if (!t || typeof t !== 'object') return t
        const tr = String(t.runId || t.run_id || '').trim()
        return tr ? t : { ...t, runId: nextRid }
      })
    }
    return next
  })
}

/**
 * 多工具轮次落库回放：row.text 只保留「首轮说明 + 末轮总结」，中间工具旁白仅在 segments/Exploring 展示。
 * 避免 dedupe 把每轮短 status 拼成一大段正文（刷新历史后气泡底部重复串联）。
 */
export function syncAssistantRowTextForHistoryDisplay(row) {
  if (!row || row.role !== 'assistant') return row
  const segs = Array.isArray(row.segments) ? row.segments : []
  const hasToolSeg = segs.some((s) => s?.kind === 'tools')
  const hasTools = hasToolSeg || (Array.isArray(row.tools) && row.tools.length > 0)
  if (!hasTools) return row

  let firstToolsIdx = -1
  let lastToolsIdx = -1
  for (let i = 0; i < segs.length; i++) {
    if (segs[i]?.kind === 'tools') {
      if (firstToolsIdx < 0) firstToolsIdx = i
      lastToolsIdx = i
    }
  }
  if (lastToolsIdx < 0) return row

  const introParts = []
  if (firstToolsIdx > 0) {
    for (let i = 0; i < firstToolsIdx; i++) {
      if (segs[i]?.kind === 'text') {
        const t = String(segs[i].text || '').trim()
        if (t) introParts.push(t)
      }
    }
  }

  let finalReply = ''
  for (let i = segs.length - 1; i > lastToolsIdx; i--) {
    if (segs[i]?.kind === 'text') {
      const t = String(segs[i].text || '').trim()
      if (t) {
        finalReply = t
        break
      }
    }
  }

  const parts = [...introParts]
  if (finalReply && finalReply !== introParts[introParts.length - 1]) parts.push(finalReply)
  row.text = parts.length ? parts.join('\n\n') : ''
  return row
}

/** Legacy mirror/frontend partial rows (``partial-abort-*`` / ``partial_*``). */
export function isPartialAbortHistoryMessage(msg) {
  if (!msg || typeof msg !== 'object') return false
  const mid = String(msg.id || msg.message_id || msg.messageId || '').trim()
  return mid.startsWith('partial-abort-') || mid.startsWith('partial_')
}

/** Drop partial-abort assistant rows when the same user turn has a real middleware row. */
export function dropSupersededPartialAbortMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages
  const roles = messages.map((m) => normalizeHistoryRole(m))
  const drop = new Set()
  let turnStart = 0
  for (let i = 0; i <= messages.length; i++) {
    const atEnd = i === messages.length
    const isUserBoundary = !atEnd && roles[i] === 'user' && i > turnStart
    if (!atEnd && !isUserBoundary) continue
    const turnEnd = atEnd ? messages.length : i
    const hasRealAssistant = messages
      .slice(turnStart, turnEnd)
      .some((m, j) => roles[turnStart + j] === 'assistant' && !isPartialAbortHistoryMessage(m))
    if (hasRealAssistant) {
      for (let j = turnStart; j < turnEnd; j++) {
        if (roles[j] === 'assistant' && isPartialAbortHistoryMessage(messages[j])) {
          drop.add(j)
        }
      }
    }
    turnStart = i
  }
  return drop.size ? messages.filter((_, idx) => !drop.has(idx)) : messages
}

export function dedupeHistory(messages) {
  const deduped = []
  const seenMessageIds = new Set()
  const normalizeAssistantText = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  for (const msg of dropSupersededPartialAbortMessages(messages)) {
    const msgId = msg && typeof msg === 'object' ? (msg.id || msg.message_id || msg.messageId) : null
    if (msgId) {
      const key = String(msgId)
      if (seenMessageIds.has(key)) continue
      seenMessageIds.add(key)
    }
    if (isCompactionUiMessage(msg)) continue
    const role = normalizeHistoryRole(msg)
    /* 中间件注入的 human 会归一为 system；MessageRow 仍会渲染 msg-system，对用户等于「还是看到一大段」——直接不出现在列表里 */
    /* 例外：模型切换分隔线（[MODEL_SWITCH] 前缀）需要保留并渲染为分隔线 */
    const isModelSwitchSep = role === 'system' && isModelSwitchSeparatorText(peekRawTextForRoleHint(msg))
    if (role === 'system' && !isModelSwitchSep) continue
    const c = extractContent(msg)
    /* 模型切换分隔线：去掉前缀，只保留展示文本 */
    if (isModelSwitchSep) {
      c.text = extractModelSwitchSeparatorDisplayText(String(c.text || ''))
    }
    /* 角色判定漏网时：已抽出正文仍明显是摘要/压缩块，不展示 */
    if (role === 'user' && isContextCompactionContent(String(c.text || '').trimStart())) continue
    if (role === 'user' && isHandoffSummaryHumanContent(String(c.text || '').trimStart())) continue
    if (role === 'assistant' && c.text) {
      const cleaned = stripStructuredToolSummaryFromDisplayText(c.text)
      if (cleaned !== c.text) c.text = cleaned
      if (!String(c.text || '').trim() && !(c.tools && c.tools.length)) continue
    }
    let historyRunId =
      msg && typeof msg === 'object'
        ? String(msg.run_id || msg.runId || '').trim() || undefined
        : undefined
    const tools = (c.tools || [])
      .map((t) => {
        const id = t.id || t.tool_call_id
        const time = t.time || resolveToolTime(id, msg.timestamp)
        const nm = String(t?.name || t?.tool_name || t?.toolName || '').trim()
        let output = t.output
        const outStr = typeof output === 'string' ? output : output != null ? formatToolDisplayValue(output) : ''
        if (outStr && isStructuredToolSummaryText(outStr)) {
          output = formatToolOutputForUserDisplay(output, nm)
        }
        return {
          ...t,
          output,
          time,
          messageTimestamp: msg.timestamp,
          ...(historyRunId ? { runId: t.runId || t.run_id || historyRunId } : {}),
        }
      })
      .filter((t) => {
        const nm = String(t?.name || t?.tool_name || t?.toolName || '').trim().toLowerCase()
        if (nm === 'ask_clarification') {
          const status = String(t?.status || '').toLowerCase()
          if (status === 'error' || status === 'failed' || status === 'cancelled') return false
          // 保留未失败 ask；已结束的在 stripResolvedAskClarificationFromRows 中剥离
          return true
        }
        if (isGoalProposalToolName(nm)) return true
        /* worker 子行不在主列表展示，但需落库供刷新后回填 diff */
        if (isWorkerNestedFileTool(t)) return true
        const name = String(t?.name || '').trim()
        const status = String(t?.status || '').toLowerCase()
        const hasOutput = !(t?.output == null || t?.output === '')
        const hasInput = !(t?.input == null || t?.input === '' || (typeof t?.input === 'object' && !Array.isArray(t?.input) && Object.keys(t.input || {}).length === 0))
        // 过滤“占位型工具项”：running + 无输入无输出，不论工具名。
        // 这些通常是流式中间态，不应在历史落库里作为独立工具块展示。
        if ((status === 'running' || status === 'in_progress') && !hasInput && !hasOutput) {
          return false
        }
        return true
      })
    /* 去掉编排/询问类工具后若无可展示内容则跳过（避免仅 supervisor 的 tool 消息变空泡） */
    if (!c.text && !c.images.length && !c.videos.length && !c.audios.length && !c.files.length && !tools.length) continue
    const last = deduped[deduped.length - 1]
    if (last && last.role === role) {
      if (role === 'user' && last.text === c.text) continue
      if (role === 'assistant') {
        if (c.text && last.text === c.text) continue
        const prevIds = new Set((last.tools || []).map((t) => toolEntryId(t)))
        const newIds = []
        for (const t of tools) {
          const id = toolEntryId(t)
          if (id && !prevIds.has(id)) {
            newIds.push(id)
            prevIds.add(id)
          }
        }
        if (c.text) {
          const prevText = String(last.text || '')
          const nextText = String(c.text || '')
          const prevNorm = normalizeAssistantText(prevText)
          const nextNorm = normalizeAssistantText(nextText)
          let textChanged = false
          // Web 工程做法：assistant 的累计快照应“覆盖更新”，而不是不断 append 造成重复。
          if (!prevText) {
            last.text = nextText
            textChanged = Boolean(nextNorm)
          } else if (nextText && nextText.startsWith(prevText)) {
            last.text = nextText
            textChanged = Boolean(nextNorm)
          } else if (prevText && prevText.startsWith(nextText)) {
            // ignore
          } else if (nextNorm && prevNorm && nextNorm.includes(prevNorm)) {
            last.text = nextText
            textChanged = true
          } else if (nextNorm && prevNorm && prevNorm.includes(nextNorm)) {
            // ignore
          } else if (newIds.length > 0) {
            // 新工具批次前的短旁白只写入 segments，不拼进 row.text（历史刷新避免串联）
            textChanged = Boolean(nextNorm)
          } else {
            last.text = mergeStreamReplicaAssistantText(prevText, nextText)
            textChanged = Boolean(nextNorm)
          }
          if (textChanged) {
            if (!last.segments) last.segments = []
            const prevSeg = last.segments[last.segments.length - 1]
            if (prevSeg && prevSeg.kind === 'text') {
              const prevSegNorm = normalizeAssistantText(prevSeg.text)
              if (nextNorm && prevSegNorm && nextNorm.startsWith(prevSegNorm)) {
                prevSeg.text = nextText
              } else if (nextNorm && prevSegNorm && prevSegNorm.startsWith(nextNorm)) {
                // ignore
              } else if (nextNorm && prevSegNorm && nextNorm === prevSegNorm) {
                // ignore
              } else {
                last.segments.push({ kind: 'text', text: nextText })
              }
            } else {
              last.segments.push({ kind: 'text', text: nextText })
            }
          }
        }
        for (const t of tools) {
          upsertTool(last.tools, t)
        }
        const mergedSub = mergeSubagentTasksMaps(
          last.subagentTasks,
          buildSubagentTasksFromTools(tools),
        )
        if (mergedSub) last.subagentTasks = mergedSub
        if (newIds.length) {
          if (!last.segments) last.segments = []
          last.segments.push({ kind: 'tools', ids: newIds })
        }
        last.images = [...(last.images || []), ...c.images]
        last.videos = [...(last.videos || []), ...c.videos]
        last.audios = [...(last.audios || []), ...c.audios]
        last.files = [...(last.files || []), ...c.files]
        if (historyRunId && !last.runId) last.runId = historyRunId
        if (msgId && !last.messageId) last.messageId = String(msgId)
        syncAssistantRowReasoning(last, msg)
        continue
      }
    }
    const subagentTasks = mergeSubagentTasksMaps(undefined, buildSubagentTasksFromTools(tools))
    const reasoningPreview =
      role === 'assistant' ? pickReasoningPreviewFromHistoryMessage(msg) : null
    const segments =
      role === 'assistant' ? buildAssistantHistorySegments(c, tools, msg) : buildInitialSegments(c, tools)
    const reasoningSegments =
      role === 'assistant' ? resolveDisplayReasoningSegments({ segments, reasoningPreview }) : null
    if (role === 'user' && !historyRunId) {
      const prevUser = [...deduped].reverse().find((r) => r?.role === 'user' && r.runId)
      if (prevUser?.runId) historyRunId = prevUser.runId
    }
    deduped.push({
      role,
      text: c.text,
      images: c.images,
      videos: c.videos,
      audios: c.audios,
      files: c.files,
      tools,
      ...(subagentTasks ? { subagentTasks } : {}),
      segments,
      timestamp: normalizeTime(msg.timestamp) ?? normalizeTime(msg.created_at_ms) ?? undefined,
      ...(msgId ? { messageId: String(msgId) } : {}),
      ...(historyRunId ? { runId: historyRunId } : {}),
      ...(reasoningPreview ? { reasoningPreview } : {}),
      ...(reasoningSegments?.length ? { reasoningSegments } : {}),
    })
  }
  const out = enrichDisplayRowsRunIds(stripResolvedAskClarificationFromRows(deduped))
  for (const row of out) syncAssistantRowTextForHistoryDisplay(row)
  return out
}

function unwrapChatTupleLike(x) {
  if (!Array.isArray(x)) return x
  if (x.length === 2 && x[1] && typeof x[1] === 'object' && !Array.isArray(x[1])) return x[1]
  if (x.length === 1 && x[0] && typeof x[0] === 'object' && !Array.isArray(x[0])) return x[0]
  return x
}

/** 与 normalizeChatToolPayloadToEntries 相同的 data 根对象解析（供 UI 诊断 raw tool_calls） */
export function extractChatPayloadDataRoot(payload) {
  const root = unwrapChatTupleLike(payload)
  const msg = unwrapChatTupleLike(payload?.message)
  const data = unwrapChatTupleLike(payload?.data)
  return (
    (data && typeof data === 'object' && !Array.isArray(data) && data) ||
    (msg && typeof msg === 'object' && !Array.isArray(msg) && msg) ||
    (root && typeof root === 'object' && !Array.isArray(root) && root) ||
    {}
  )
}

export function extractRawToolCallsFromChatPayload(payload) {
  const d = extractChatPayloadDataRoot(payload)
  const toolCalls = d.tool_calls || d.toolCalls
  return Array.isArray(toolCalls) ? toolCalls : null
}

export function normalizeChatToolPayloadToEntries(payload) {
  const d = extractChatPayloadDataRoot(payload)
  const dTypeLower = typeof d.type === 'string' ? d.type.toLowerCase() : ''
  const nameHint = payload?.name || d.name || d.tool_name || '工具'
  const toolCalls = d.tool_calls || d.toolCalls
  // 显式返回空tool_calls数组时直接返回空，不要创建默认空工具
  if (Array.isArray(toolCalls)) {
    if (toolCalls.length === 0) return []
    evfToolStreamDebug('norm:diag', { t: toolCalls.map((tc) => evfDiagnoseRawToolCall(tc)) })
    const entries = toolCalls.map((tc) => {
      const id = tc.id || tc.tool_call_id
      const nm = tc.name || tc.tool_name || (tc.function && tc.function.name) || nameHint
      let input = resolvePrimaryToolCallArgs(tc)
      if (typeof input === 'string') {
        const t = input.trim()
        if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
          try {
            input = JSON.parse(t)
          } catch {
            /* keep */
          }
        }
      }
      const resolvedName = inferToolNameFromArgs(
        typeof input === 'object' && input != null && !Array.isArray(input) ? input : null,
        nm || nameHint,
      )
      const fnRaw = tc.function && typeof tc.function === 'object' ? tc.function.name : null
      const fnLower = fnRaw != null ? String(fnRaw).trim().toLowerCase() : ''
      const writeToolNames = new Set([
        'write_to_file',
        'write_file',
        'str_replace',
        'replace_in_file',
      ])
      let entryName = isGenericToolName(resolvedName) ? nm || nameHint || 'tool' : resolvedName
      if (fnLower && writeToolNames.has(fnLower)) {
        entryName = String(fnRaw).trim()
      }
      const toolNameField =
        tc.tool_name != null && String(tc.tool_name).trim()
          ? String(tc.tool_name).trim()
          : fnRaw != null && String(fnRaw).trim()
            ? String(fnRaw).trim()
            : undefined
      return {
        id: id || uuid(),
        name: entryName,
        tool_name: toolNameField,
        function: tc.function,
        input: input ?? null,
        output: null,
        status: 'running',
      }
    })
    evfToolStreamDebug('norm:merged', { t: entries.map((e) => evfBriefToolRow(e)) })
    return entries
  }
  const toolCallId = payload?.toolCallId || d.tool_call_id || d.id
  const isToolNode = dTypeLower === 'tool' || dTypeLower === 'toolmessage' || d.role === 'tool'
  let output
  if (isToolNode && d.content != null) {
    output = d.content
    if (typeof output === 'string') {
      const t = output.trim()
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try {
          output = JSON.parse(t)
        } catch {
          /* keep */
        }
      }
    }
  }
  let input = d.args ?? d.input ?? d.arguments ?? null
  let status = 'running'
  const isEmptyOutput = output == null || output === '' || (typeof output === 'object' && !Array.isArray(output) && Object.keys(output).length === 0) || (Array.isArray(output) && output.length === 0)
  const isEmptyInput = input == null || input === '' || (typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0) || (Array.isArray(input) && input.length === 0)
  const explicitStatus = d.status != null ? String(d.status).trim().toLowerCase() : ''
  const terminalOkStatuses = new Set(['ok', 'completed', 'done', 'success'])
  const slimResultHint =
    d.truncated === true ||
    d.output_truncated === true ||
    (d.content_bytes != null && Number(d.content_bytes) > 0) ||
    (d.output_bytes != null && Number(d.output_bytes) > 0) ||
    (d.outputBytes != null && Number(d.outputBytes) > 0)

  if (explicitStatus === 'error' || (isToolNode && d.isError === true)) {
    status = 'error'
  } else if (
    isToolNode &&
    !isEmptyOutput &&
    envelopeStatusFromToolOutput(output) === 'pending_approval'
  ) {
    status = 'pending_approval'
  } else if (
    isToolNode &&
    (terminalOkStatuses.has(explicitStatus) || slimResultHint || payload?.status === 'ok')
  ) {
    // Gateway slim 后的 tool_result：content 为空但 status/truncated 表示已结束
    status = 'ok'
  } else if (!isEmptyOutput) {
    const shellExit = isShellToolName(nameHint) ? parseTerminalExitCodeFromOutput(output) : null
    if (shellExit != null && shellExit !== 0) {
      status = 'error'
    } else {
      const mediaSt = mediaToolStatusFromOutput(output)
      if (mediaSt === 'error') status = 'error'
      else if (mediaSt === 'ok') status = 'ok'
      else {
        const envSt = envelopeStatusFromToolOutput(output)
        if (envSt === 'pending_approval') status = 'pending_approval'
        else if (envSt === 'error') status = 'error'
        else status = 'ok'
      }
    }
  }
  // 空输入+空输出且无明确结束信号时保持 running（避免 tool_call 增量被误标完成）
  const toolEntry = {
    id: toolCallId || uuid(),
    name: nameHint,
    input,
    output: output !== undefined ? output : undefined,
    status,
  }
  if (d.truncated === true || d.output_truncated === true) {
    toolEntry.output_truncated = true
    toolEntry.outputTruncated = true
  }
  const byteHint = d.content_bytes ?? d.output_bytes ?? d.outputBytes
  if (byteHint != null && Number(byteHint) > 0) {
    toolEntry.output_bytes = Number(byteHint)
    toolEntry.outputBytes = Number(byteHint)
  }
  maybeBackfillToolInputFromOutput(toolEntry)
  maybeInferToolNameFromOutput(toolEntry)
  maybeInferToolNameFromInput(toolEntry)

  // 过滤完全空的无效工具：默认名称+空输入+空输出+非running状态，避免final事件多出来的空工具气泡
  const isDefaultName = nameHint === '工具' || nameHint === ''
  const isNotRunning = status !== 'running'

  // 只过滤已经结束的完全空工具，保留进行中的空工具（用户需要显示进行中状态）
  if (isDefaultName && isEmptyInput && isEmptyOutput && isNotRunning) {
    return []
  }

  return [toolEntry]
}

export function extractChatContent(message) {
  if (!message || typeof message !== 'object') return null
  const view = historyMessageBodyView(message)
  const tools = []
  collectToolsFromMessage(view, tools)
  if (isToolResultMessage(view)) {
    if (!tools.length) {
      const output = resolveToolResultOutput(view)
      tools.push({
        id: view.tool_call_id || view.toolCallId || view.id,
        name: view.name || view.tool || view.tool_name || '工具',
        input: view.input || view.args || view.parameters || null,
        output,
        status: view.status || 'ok',
      })
      const row = tools[tools.length - 1]
      syncToolStatusFromEnvelope(row)
      maybeSyncTerminalToolStatusFromOutput(row)
      maybeBackfillToolInputFromOutput(row)
      maybeSlimToolOutputForUi(row)
    } else {
      attachToolResultOutput(tools, view)
    }
    return mergeToolDerivedMedia(
      { text: '', images: [], videos: [], audios: [], files: inferFilesFromToolEntries(tools), tools },
      tools,
    )
  }
  const content = resolveHistoryMessageContent(view)
  if (typeof content === 'string')
    return {
      text: stripThinkingTagsPreserveNewlines(unwrapAssistantContentJsonEnvelope(content)),
      images: [],
      videos: [],
      audios: [],
      files: [],
      tools,
    }
  if (Array.isArray(content)) {
    const texts = []
    const images = []
    const videos = []
    const audios = []
    const files = []
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      else if (block.type === 'image' && !block.omitted) {
        if (block.data) images.push({ mediaType: block.mimeType || 'image/png', data: block.data })
        else if (block.source?.type === 'base64' && block.source.data)
          images.push({ mediaType: block.source.media_type || 'image/png', data: block.source.data })
        else if (block.url || block.source?.url)
          images.push({ url: block.url || block.source.url, mediaType: block.mimeType || 'image/png' })
      } else if (block.type === 'image_url' && block.image_url?.url) {
        images.push({ url: block.image_url.url, mediaType: 'image/png' })
      } else if (block.type === 'video') {
        if (block.data) videos.push({ mediaType: block.mimeType || 'video/mp4', data: block.data })
        else if (block.url) videos.push({ url: block.url, mediaType: block.mimeType || 'video/mp4' })
      } else if (block.type === 'audio' || block.type === 'voice') {
        if (block.data)
          audios.push({
            mediaType: block.mimeType || 'audio/mpeg',
            data: block.data,
            duration: block.duration,
          })
        else if (block.url)
          audios.push({ url: block.url, mediaType: block.mimeType || 'audio/mpeg', duration: block.duration })
      } else if (block.type === 'file' || block.type === 'document') {
        files.push({
          url: block.url || '',
          name: block.fileName || block.name || '文件',
          mimeType: block.mimeType || '',
          size: block.size,
          data: block.data,
        })
      } else if (
        block.type === 'tool' ||
        block.type === 'tool_use' ||
        block.type === 'tool_call' ||
        block.type === 'toolCall'
      ) {
        const callId = block.id || block.tool_call_id || block.toolCallId
        let blockInput = resolvePrimaryToolCallArgs(block)
        if (blockInput == null) {
          blockInput = block.input || block.args || block.parameters || block.arguments || null
        }
        if (typeof blockInput === 'string') {
          const t = blockInput.trim()
          if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
            try {
              blockInput = JSON.parse(blockInput)
            } catch {
              /* keep */
            }
          }
        }
        upsertTool(tools, {
          id: callId,
          name: block.name || block.tool || block.tool_name || block.toolName || '工具',
          input: blockInput,
          output: null,
          status: block.status || 'ok',
          time: resolveToolTime(callId, view.timestamp),
        })
      } else if (block.type === 'tool_result' || block.type === 'toolResult') {
        const resId = block.id || block.tool_call_id || block.toolCallId
        upsertTool(tools, {
          id: resId,
          name: block.name || block.tool || block.tool_name || block.toolName || '工具',
          input: block.input || block.args || null,
          output: block.output || block.result || block.content || null,
          status: block.status || 'ok',
          time: resolveToolTime(resId, message.timestamp),
        })
      }
    }
    if (tools.length) {
      tools.forEach((t) => {
        if (typeof t.input === 'string') t.input = stripAnsi(t.input)
        if (typeof t.output === 'string') t.output = stripAnsi(t.output)
      })
    }
    const toolFiles = inferFilesFromToolEntries(tools)
    const mediaUrls = message.mediaUrls || (message.mediaUrl ? [message.mediaUrl] : [])
    for (const url of mediaUrls) {
      if (!url) continue
      if (/\.(mp4|webm|mov|mkv)(\?|$)/i.test(url)) videos.push({ url, mediaType: 'video/mp4' })
      else if (/\.(mp3|wav|ogg|m4a|aac|flac)(\?|$)/i.test(url))
        audios.push({ url, mediaType: 'audio/mpeg' })
      else if (/\.(jpe?g|png|gif|webp|heic|svg)(\?|$)/i.test(url))
        images.push({ url, mediaType: 'image/png' })
      else files.push({ url, name: url.split('/').pop().split('?')[0] || '文件', mimeType: '' })
    }
    /* 流式 piece 常为 "\\n\\n**" 等；stripThinkingTags 会 trim 掉片段首尾换行 */
    const text = texts.length ? stripThinkingTagsPreserveNewlines(texts.join('\n')) : ''
    return mergeToolDerivedMedia(
      { text, images, videos, audios, files: [...files, ...toolFiles], tools },
      tools,
    )
  }
  if (typeof message.text === 'string')
    return mergeToolDerivedMedia(
      {
        text: stripThinkingTagsPreserveNewlines(message.text),
        images: [],
        videos: [],
        audios: [],
        files: inferFilesFromToolEntries(tools),
        tools,
      },
      tools,
    )
  return null
}

/** LangGraph 流式：单调合并展示文本（与 ws-client 一致） */
export function accumulateStreamAssistantText(prev, incoming) {
  if (incoming == null || incoming === '') return prev || ''
  const inc = typeof incoming === 'string' ? incoming : ''
  if (!inc) return prev || ''
  if (!prev) return inc
  // 有些链路会重复发送同一段增量，避免重复追加
  if (prev.endsWith(inc)) return prev
  /* 丢弃比当前更短的旧快照，避免与增量拼接成重复段落 */
  if (inc.length < prev.length && prev.startsWith(inc)) return prev
  if (inc.length >= prev.length && inc.startsWith(prev)) return inc
  const prevL = normalizeStreamPlainLoose(prev)
  const incL = normalizeStreamPlainLoose(inc)
  if (incL.startsWith(prevL)) return inc
  if (isStreamAssistantLineRewrite(prev, inc)) return inc
  // 防御：values 全量快照包含已累积的 delta 文本时，从匹配位置切出真正增量，
  // 避免 baseline 前缀失配后 fallback prev+inc 把全文重复拼接。
  if (inc.length > prev.length && prev.length <= 2000) {
    const idx = inc.indexOf(prev)
    if (idx >= 0) {
      const suffix = inc.slice(idx + prev.length)
      if (suffix) return prev + suffix
      return prev
    }
  }
  return prev + inc
}

export function pickUsageObject(source) {
  if (!source || typeof source !== 'object') return null
  const candidates = [
    source.usage,
    source.usage_metadata,
    source.token_usage,
    source.response_metadata?.usage,
    source.response_metadata?.usage_metadata,
    source.response_metadata?.token_usage,
    source.additional_kwargs?.usage,
    source.additional_kwargs?.usage_metadata,
    source.additional_kwargs?.token_usage,
    source.message?.usage,
    source.message?.usage_metadata,
    source.message?.token_usage,
    source.message?.response_metadata?.usage,
    source.message?.response_metadata?.usage_metadata,
    source.message?.response_metadata?.token_usage,
  ]
  return candidates.find((x) => x && typeof x === 'object') || null
}

function pickFlatUsageTokenFields(source) {
  if (!source || typeof source !== 'object') return {}
  const out = {}
  for (const [src, dst] of [
    ['input_tokens', 'input_tokens'],
    ['inputTokens', 'input_tokens'],
    ['prompt_tokens', 'prompt_tokens'],
    ['output_tokens', 'output_tokens'],
    ['outputTokens', 'output_tokens'],
    ['completion_tokens', 'completion_tokens'],
    ['total_tokens', 'total_tokens'],
    ['totalTokens', 'total_tokens'],
    ['cache_read_tokens', 'cache_read_tokens'],
    ['cacheReadTokens', 'cache_read_tokens'],
    ['cache_creation_tokens', 'cache_creation_tokens'],
    ['cacheCreationTokens', 'cache_creation_tokens'],
    ['cache_miss_tokens', 'cache_miss_tokens'],
    ['cacheMissTokens', 'cache_miss_tokens'],
  ]) {
    if (source[src] != null) out[dst] = source[src]
  }
  return out
}

/** Canonical token usage across OpenAI / Anthropic / Bailian / Volcengine shapes. */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null

  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0

  const cachedTokens = Math.max(
    Number(usage.cache_read_tokens ?? 0) || 0,
    Number(usage.cache_read_input_tokens ?? 0) || 0,
    Number(usage.cached_tokens ?? 0) || 0,
    Number(usage.prompt_tokens_details?.cached_tokens ?? 0) || 0,
    Number(usage.input_tokens_details?.cached_tokens ?? 0) || 0,
    Number(usage.input_token_details?.cached_tokens ?? 0) || 0,
    Number(usage.input_token_details?.cache_read ?? 0) || 0,
  )

  const cacheCreationTokens = Math.max(
    Number(usage.cache_creation_tokens ?? 0) || 0,
    Number(usage.cache_creation_input_tokens ?? 0) || 0,
    Number(usage.prompt_tokens_details?.cache_creation_input_tokens ?? 0) || 0,
    Number(usage.prompt_tokens_details?.cache_creation_tokens ?? 0) || 0,
    Number(usage.input_tokens_details?.cache_creation_input_tokens ?? 0) || 0,
    Number(usage.input_token_details?.cache_creation_tokens ?? 0) || 0,
    Number(usage.input_token_details?.cache_creation ?? 0) || 0,
  )

  const isAnthropicStyle =
    usage.cache_read_input_tokens !== undefined ||
    usage.cache_creation_input_tokens !== undefined

  const inputTotalTokens = isAnthropicStyle
    ? promptTokens + cachedTokens + cacheCreationTokens
    : promptTokens

  const inputUncachedTokens = isAnthropicStyle
    ? promptTokens
    : Math.max(0, inputTotalTokens - cachedTokens - cacheCreationTokens)

  const totalTokens =
    Number(usage.total_tokens ?? inputTotalTokens + outputTokens) || inputTotalTokens + outputTokens

  if (!inputTotalTokens && !outputTokens && !totalTokens) return null

  const cacheMiss =
    cachedTokens > 0 || cacheCreationTokens > 0
      ? !isAnthropicStyle && usage.cache_miss_tokens != null
        ? Math.max(0, Number(usage.cache_miss_tokens) || 0)
        : inputUncachedTokens
      : 0

  return {
    input_total_tokens: inputTotalTokens,
    input_uncached_tokens: cacheMiss,
    cache_read_tokens: cachedTokens,
    cache_write_tokens: cacheCreationTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens: inputTotalTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_miss_tokens: cacheMiss,
  }
}

export function parseUsageToStats(raw) {
  if (!raw || typeof raw !== 'object') return null
  const nested = pickUsageObject(raw)
  const usage = nested ? { ...nested, ...pickFlatUsageTokenFields(raw) } : pickFlatUsageTokenFields(raw)
  const norm = normalizeUsage(usage)
  if (!norm || !norm.total_tokens) return null
  const stats = {
    input: norm.input_total_tokens,
    output: norm.output_tokens,
    total: norm.total_tokens,
  }
  if (norm.cache_read_tokens > 0) stats.cacheRead = norm.cache_read_tokens
  if (norm.cache_write_tokens > 0) stats.cacheCreation = norm.cache_write_tokens
  if ((norm.cache_read_tokens > 0 || norm.cache_write_tokens > 0) && norm.input_uncached_tokens > 0) {
    stats.cacheMiss = norm.input_uncached_tokens
  }
  return stats
}

/** Wire-format usage object for chat events / SSE (includes cache when present). */
export function usageWirePayloadFromTriplet(triplet) {
  if (!triplet || typeof triplet !== 'object') return null
  const input = Number(triplet.input_tokens ?? 0) || 0
  const output = Number(triplet.output_tokens ?? 0) || 0
  const total = Number(triplet.total_tokens ?? input + output) || input + output
  if (!input && !output && !total) return null
  const out = { input_tokens: input, output_tokens: output, total_tokens: total }
  const cacheRead = Number(triplet.cache_read_tokens ?? 0) || 0
  const cacheCreation = Number(triplet.cache_creation_tokens ?? 0) || 0
  const cacheMiss = Number(triplet.cache_miss_tokens ?? 0) || 0
  if (cacheRead > 0) out.cache_read_tokens = cacheRead
  if (cacheCreation > 0) out.cache_creation_tokens = cacheCreation
  if (cacheMiss > 0) out.cache_miss_tokens = cacheMiss
  return out
}

export function usageEmitSignature(triplet) {
  if (!triplet || typeof triplet !== 'object') return ''
  return [
    triplet.input_tokens ?? 0,
    triplet.output_tokens ?? 0,
    triplet.total_tokens ?? 0,
    triplet.cache_read_tokens ?? 0,
    triplet.cache_creation_tokens ?? 0,
    triplet.cache_miss_tokens ?? 0,
  ].join(':')
}

/** LangGraph streaming AI part → normalized usage triplet (checks response_metadata). */
export function usageTripletFromStreamPart(part) {
  if (!part || typeof part !== 'object') return null
  const usage = pickUsageObject(part) || part.usage_metadata
  return usageWirePayloadFromTriplet(normalizeUsage(usage))
}

/** Tooltip for prompt-cache breakdown. */
export function formatUsageTokenTitle(stats) {
  if (!stats || typeof stats !== 'object') return ''
  const parts = []
  if (stats.cacheRead > 0) parts.push(`缓存命中 ${stats.cacheRead}`)
  if (stats.cacheCreation > 0) parts.push(`写入缓存 ${stats.cacheCreation}`)
  if (stats.cacheMiss > 0) parts.push(`未命中 ${stats.cacheMiss}`)
  return parts.join(' · ')
}

/** Chat bubble / meta token string (`↑in ↓out · ⚡cacheHit`). */
export function formatUsageTokenStr(stats) {
  if (!stats || typeof stats !== 'object' || !stats.total) return ''
  const base =
    stats.input && stats.output
      ? `↑${stats.input} ↓${stats.output}`
      : `${stats.total} tokens`
  if (stats.cacheRead > 0) return `${base} · ⚡${stats.cacheRead}`
  return base
}

/** MediaToolResponse JSON: ``ok: false`` / ``status: error`` → UI 应显示失败而非成功。 */
export function mediaToolStatusFromOutput(output) {
  if (output == null) return null
  let obj = output
  if (typeof output === 'string') {
    const t = output.trim()
    if (!t || t[0] !== '{') return null
    try {
      obj = JSON.parse(t)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  if (!('ok' in obj) && !('status' in obj) && !('message' in obj)) return null
  if (obj.ok === false || String(obj.status || '').toLowerCase() === 'error') return 'error'
  if (obj.ok === true) {
    const st = String(obj.status || '').toLowerCase()
    if (st === 'error' || st === 'failed') return 'error'
    return 'ok'
  }
  return null
}

/** User-visible message from ``_evoflow_tool`` envelope (avoids showing duplicate JSON fields). */
export function envelopeUserMessageFromToolOutput(output) {
  if (output == null) return null
  let obj = output
  if (typeof output === 'string') {
    const t = output.trim()
    if (!t || t[0] !== '{') return null
    try {
      obj = JSON.parse(t)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const meta = obj._evoflow_tool
  if (!meta || typeof meta !== 'object') return null
  const st = String(meta.status || '').trim().toLowerCase()
  const msg = typeof meta.message === 'string' ? meta.message.trim() : ''
  if (st === 'error' && msg) return msg
  if (st === 'ok' && msg) return msg
  return null
}

/** Parse ``_evoflow_tool.status`` from tool output JSON (string or object). */
export function envelopeStatusFromToolOutput(output) {
  if (output == null) return null
  let obj = output
  if (typeof output === 'string') {
    const t = output.trim()
    if (!t || t[0] !== '{') return null
    try {
      obj = JSON.parse(t)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const meta = obj._evoflow_tool
  if (!meta || typeof meta !== 'object') return null
  const st = String(meta.status || '').trim().toLowerCase()
  return st || null
}

export function syncToolStatusFromEnvelope(tool) {
  if (!tool || typeof tool !== 'object') return
  const mediaSt = mediaToolStatusFromOutput(tool.output)
  if (mediaSt) {
    tool.status = mediaSt
    return
  }
  const envSt = envelopeStatusFromToolOutput(tool.output)
  if (!envSt) return
  if (envSt === 'pending_approval') tool.status = 'pending_approval'
  else if (envSt === 'error') tool.status = 'error'
  else if (envSt === 'ok' || envSt === 'success') tool.status = 'ok'
}

export function isToolRunning(tool) {
  if (!tool) return false
  const status = String(tool.status || '').toLowerCase()
  // 只有 running/in_progress 状态才显示为运行中
  // ok/completed/done/error/pending_approval 等状态都不显示为运行中
  return status === 'running' || status === 'in_progress'
}

export function toolLabel(tool) {
  return formatToolDisplayTitle(tool)
}

export function safeStringify(value) {
  if (value == null) return ''
  const seen = new WeakSet()
  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (typeof val === 'bigint') return val.toString()
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]'
          seen.add(val)
        }
        return val
      },
      2,
    )
  } catch {
    try {
      return String(value)
    } catch {
      return ''
    }
  }
}

/**
 * 工具入参/出参展示：字符串若可解析为 JSON（对象/数组/合法 JSON 字面量）则格式化为缩进文本，否则原样；非字符串走 safeStringify。结果统一 stripAnsi，与原先展示行为一致。
 */
export function formatToolDisplayValue(value) {
  if (value == null) return ''
  if (typeof value === 'string') {
    const s = stripAnsi(value)
    const t = s.trim()
    if (!t) return ''
    try {
      const parsed = JSON.parse(t)
      return stripAnsi(safeStringify(parsed))
    } catch {
      return s
    }
  }
  return stripAnsi(safeStringify(value))
}

export function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

/** 与后端 ``normalize_scenario_key`` / 顶栏场景一致 */
const _SCENARIO_KEYS_UI = new Set(['ask', 'plan', 'agent', 'chat', 'workspace'])

export function normalizeScenarioKeyForUi(raw) {
  const r = String(raw || '').trim().toLowerCase()
  if (!r) return null
  if (r === 'chat') return 'ask'
  if (r === 'workspace') return 'agent'
  if (_SCENARIO_KEYS_UI.has(r)) return r
  if (r === 'dialogue' || r === 'dialog') return 'ask'
  if (
    ['creative', 'media', 'video', 'image', 'art', 'design', 'short_video', 'short-video', 'media_production'].includes(
      r,
    )
  )
    return 'ask'
  if (['trae', 'trae_window', 'trae-runtime', 'trae_runtime'].includes(r)) return 'ask'
  if (['evolve', 'evolution', 'self_evolve', 'self-improve', 'self_improve', 'improve', 'optimize'].includes(r))
    return 'ask'
  if (['work', 'do', 'task', 'execute', 'plan'].includes(r)) return 'plan'
  if (['agent', 'workspace', 'workspaces', 'file', 'files', 'file_ops', 'filesystem', 'edit_file'].includes(r)) return 'agent'
  if (['web', 'search', 'research', 'browse'].includes(r)) return 'agent'
  if (['manage', 'admin', 'govern'].includes(r)) return 'ask'
  if (['ask', 'qa', 'question'].includes(r)) return 'ask'
  if (
    [
      'planning',
      'debug',
      'debugging',
      'troubleshoot',
      'implement',
      'coding',
      'code',
      'edit',
      'review',
      'audit',
      'general',
    ].includes(r)
  )
    return 'plan'
  return null
}

/** 解析 scenario 工具返回的 JSON（与后端 scenario_activation 载荷对齐） */
export function parseScenarioToolOutputBlob(output) {
  if (output == null) return null
  if (typeof output === 'object' && !Array.isArray(output)) return output
  if (typeof output === 'string') {
    const t = output.trim()
    if (!t) return null
    try {
      const j = JSON.parse(t)
      return typeof j === 'object' && j != null && !Array.isArray(j) ? j : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * 从 scenario 工具单次调用推导顶栏场景键。
 * @param {object|null|undefined} o - 解析后的 output JSON（可能缺 action，如 noop）
 * @param {object|undefined} inputFallback - 工具入参（含 action / scenario_key），与网关/落库一致
 *
 * 说明：activate chat / deactivate 清空后 output 可能只有 all_active_scenarios: []，须合并 input 的 action/scenario_key。
 */
export function pickDisplayChatSceneFromScenarioResult(o, inputFallback) {
  const inp = inputFallback && typeof inputFallback === 'object' && !Array.isArray(inputFallback) ? inputFallback : {}
  const base = o && typeof o === 'object' && !Array.isArray(o) ? o : {}

  const action = String(base.action || inp.action || '').toLowerCase()
  const skFromOut = typeof base.scenario_key === 'string' ? normalizeScenarioKeyForUi(base.scenario_key) : null
  const skFromIn =
    typeof inp.scenario_key === 'string' ? normalizeScenarioKeyForUi(String(inp.scenario_key)) : null
  const sk = skFromOut || skFromIn

  const rawAll = base.all_active_scenarios
  const list = []
  if (Array.isArray(rawAll)) {
    for (const x of rawAll) {
      const c = normalizeScenarioKeyForUi(String(x))
      if (c) list.push(c)
    }
  }

  const st = String(base.status || '').toLowerCase()

  // deactivate：必须以剩余活跃场景为准；勿在已全部清空时仍用被停用的 scenario_key
  if (action === 'deactivate') {
    if (list.length) {
      const nonAsk = list.filter((x) => x !== 'ask')
      if (nonAsk.includes('plan')) return 'plan'
      return nonAsk.length ? nonAsk[nonAsk.length - 1] : 'ask'
    }
    return 'ask'
  }

  if (action === 'activate' && sk) return sk

  if (list.length) {
    const nonAsk = list.filter((x) => x !== 'ask')
    if (nonAsk.includes('plan')) return 'plan'
    return nonAsk.length ? nonAsk[nonAsk.length - 1] : 'ask'
  }

  if (action === 'activate' && sk === 'ask') return 'ask'

  if (sk) return sk
  return null
}

/**
 * 从落库原始消息（未经过 dedupeHistory 过滤）按时间顺序扫描，取最后一次可解析的 scenario 工具结果。
 * 历史展示行不渲染 scenario 工具；原始 API 消息里仍保留，供顶栏恢复。
 */
export function extractLatestScenarioSceneKeyFromHistoryMessages(rawMessages) {
  let latest = null
  for (const msg of rawMessages || []) {
    const c = extractContent(msg)
    const tools = c?.tools || []
    for (const t of tools) {
      const nm = String(t?.name || t?.tool_name || t?.toolName || '').trim().toLowerCase()
      if (nm !== 'scenario') continue
      const blob = parseScenarioToolOutputBlob(t.output)
      const picked = pickDisplayChatSceneFromScenarioResult(blob, t.input)
      if (picked) latest = picked
    }
  }
  return latest
}

/** checkpoint messages → 展示行（已去重合并） */
export function messagesToDisplayRows(rawMessages) {
  const base = dedupeHistory(rawMessages || [])
  if (!base.length) return base
  const normalizeForDedupe = (text) => {
    const t = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ') // 去掉代码块
      .replace(/\|[^\n]*\|/g, ' ') // 去掉表格行（粗略）
      .replace(/\*\*([^*]+)\*\*/g, '$1') // 粗略去掉加粗
      .replace(/[`*_#>-]+/g, ' ') // 去掉常见 markdown 符号
      .replace(/\s+/g, ' ')
      .trim()
    // 只对“明显是解释段落”的长文本做指纹去重，避免把合法的短回复（如 abc/ccc）误判为重复。
    if (t.length < 80) return ''
    // 用开头片段作为指纹：相同开头的“解释型回复”保留最新一条
    return t.slice(0, 120)
  }

  // 先做一次“完全相同连续项”去重（保守）
  const compact = []
  for (const row of base) {
    const last = compact[compact.length - 1]
    if (
      last &&
      row.role === 'assistant' &&
      last.role === 'assistant' &&
      row.text &&
      last.text &&
      row.text.trim() === last.text.trim()
    ) {
      continue
    }
    compact.push(row)
  }

  // 再做一次“同类解释保留最后一次”：倒序遍历，只保留最新出现的那条
  const seen = new Set()
  const outRev = []
  for (let i = compact.length - 1; i >= 0; i--) {
    const row = compact[i]
    if (
      row.role === 'assistant' &&
      row.text &&
      (!row.tools || row.tools.length === 0) &&
      (!row.images || row.images.length === 0) &&
      (!row.videos || row.videos.length === 0) &&
      (!row.audios || row.audios.length === 0) &&
      (!row.files || row.files.length === 0)
    ) {
      const fp = normalizeForDedupe(row.text)
      if (fp && seen.has(fp)) continue
      if (fp) seen.add(fp)
    }
    outRev.push(row)
  }
  outRev.reverse()
  return outRev
}

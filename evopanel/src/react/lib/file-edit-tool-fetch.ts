import { fetchToolResultFull } from '../../lib/tool-result-fetch.js'
import type { FileEditDiffModalPayload } from '../components/FileEditDiffModal.js'

export function fileEditActionFromToolName(toolName: string, fallbackAction: string): string {
  const n = String(toolName || '').trim().toLowerCase()
  if (n.includes('delete')) return 'delete'
  if (n.includes('write')) return 'write'
  if (n.includes('replace') || n === 'str_replace' || n === 'edit') return 'replace'
  return fallbackAction || 'replace'
}

export function resolveFileEditPayloadFromToolApi(
  data: Record<string, unknown>,
  fallback: FileEditDiffModalPayload,
): FileEditDiffModalPayload {
  const args =
    data.args && typeof data.args === 'object' && !Array.isArray(data.args)
      ? (data.args as Record<string, unknown>)
      : {}
  const toolName = String(data.toolName || data.tool_name || '')
  const path = String(
    args.path || args.file_path || args.target_file || fallback.path || '',
  ).trim()
  const action = fileEditActionFromToolName(toolName, fallback.action)
  const output = typeof data.content === 'string' ? data.content : ''
  return {
    ...fallback,
    title: fallback.title || path,
    path: path || fallback.path,
    action,
    content: typeof args.content === 'string' ? args.content : fallback.content,
    old_string: typeof args.old_string === 'string' ? args.old_string : fallback.old_string,
    new_string: typeof args.new_string === 'string' ? args.new_string : fallback.new_string,
    running: false,
    ok: fallback.ok ?? (output ? !/^error/i.test(output.trim()) : undefined),
    result: fallback.ok === false ? fallback.result || output : undefined,
  }
}

export async function fetchFileEditPayloadForToolCall(
  sessionKey: string,
  toolCallId: string,
  fallback: FileEditDiffModalPayload,
): Promise<FileEditDiffModalPayload> {
  const data = (await fetchToolResultFull(sessionKey, toolCallId)) as Record<string, unknown>
  return resolveFileEditPayloadFromToolApi(data, fallback)
}

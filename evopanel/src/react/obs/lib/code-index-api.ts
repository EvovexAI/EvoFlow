import { api } from '../../../lib/tauri-api.js'
import type { CodeIndexStatus, IndexSearchResponse } from '../types/code-index'

export type { CodeIndexStatus }

export async function fetchCodeIndexSearch(
  query: string,
  limit = 50,
  root?: string,
  threadId?: string
): Promise<IndexSearchResponse> {
  return (await api.searchCodeIndex(root || '', query, limit, threadId || undefined)) as IndexSearchResponse
}

export async function fetchCodeIndexStatus(
  root?: string,
  threadId?: string
): Promise<CodeIndexStatus> {
  return (await api.codeIndexStatus(root || '', threadId || undefined)) as CodeIndexStatus
}

export async function fetchCodeIndexBuild(
  root?: string,
  force = false,
  threadId?: string
): Promise<CodeIndexStatus> {
  return (await api.warmCodeIndex(root || '', force, threadId || undefined)) as CodeIndexStatus
}

export async function waitForCodeIndexReady(
  root: string,
  opts?: {
    threadId?: string
    timeoutMs?: number
    intervalMs?: number
    onProgress?: (st: CodeIndexStatus) => void
  }
): Promise<CodeIndexStatus> {
  const timeoutMs = opts?.timeoutMs ?? 15 * 60 * 1000
  const intervalMs = opts?.intervalMs ?? 2000
  const deadline = Date.now() + timeoutMs
  let last: CodeIndexStatus = {}
  while (Date.now() < deadline) {
    last = await fetchCodeIndexStatus(root, opts?.threadId)
    opts?.onProgress?.(last)
    if (last.ready && !last.building) {
      return last
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return last
}

export async function startCodeIndexWatch(root?: string, threadId?: string): Promise<unknown> {
  return api.startCodeIndexWatch(root || '', threadId || undefined)
}

export async function stopCodeIndexWatch(root?: string, threadId?: string): Promise<unknown> {
  return api.stopCodeIndexWatch(root || '', threadId || undefined)
}

function mapRelations(res: IndexSearchResponse): import('../types/code-index').IndexRelation[] {
  const mapRow = (rows: IndexSearchResponse['imports'], kind: string) =>
    (rows || []).map((r) => ({
      from_path: r.from_path || '',
      to_path: r.to_path || '',
      kind: r.kind || kind,
      symbol: r.symbol,
      line: r.line,
    }))

  return [
    ...mapRow(res.imported_by, 'imported_by'),
    ...mapRow(res.imports, 'imports'),
    ...mapRow(res.internal_ref_users, 'internal_ref'),
    ...mapRow(res.type_supertypes, 'type_supertype'),
    ...mapRow(res.type_subtypes, 'type_subtype'),
  ]
}

export { mapRelations as relationsFromSearchResponse }

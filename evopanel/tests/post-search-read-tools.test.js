import { describe, it, expect } from 'vitest'
import {
  dedupeToolsByCallId,
  expandToolsWithPostSearchReads,
} from '../src/react/post-search-read-tools.ts'

describe('dedupeToolsByCallId', () => {
  it('drops later rows with the same tool_call_id', () => {
    const tools = [
      { id: 'search-read-9-abc', name: 'read_file', input: { path: '/a.py' } },
      { tool_call_id: 'search-read-9-abc', name: 'read_file', output: 'done' },
    ]
    const out = dedupeToolsByCallId(tools)
    expect(out).toHaveLength(1)
    expect(out[0].output).toBeUndefined()
  })
})

describe('expandToolsWithPostSearchReads', () => {
  it('dedupes input and skips synthetic read when streamed read_file already exists', () => {
    const searchId = 'call_search_1'
    const readId = 'search-read-9-e8afa0aad1'
    const path = '/workspace/foo.py'
    const tools = [
      { id: searchId, name: 'search_code_index', output: '' },
      { id: readId, name: 'read_file', input: { path, invocation_source: 'post_search' } },
      {
        id: readId,
        tool_call_id: readId,
        name: 'read_file',
        input: { path, invocation_source: 'post_search' },
        output: 'file body',
      },
      {
        id: searchId,
        name: 'search_code_index',
        output: [
          '<post_search_reads>',
          '[tool:summary] tool=read_file',
          `path: ${path}`,
          'core: embedded body',
          '</post_search_reads>',
        ].join('\n'),
      },
    ]
    const out = expandToolsWithPostSearchReads(tools)
    const readRows = out.filter((t) => String(t.name).toLowerCase() === 'read_file')
    expect(readRows).toHaveLength(1)
    expect(readRows[0].id).toBe(readId)
    const ids = out.map((t) => String(t.id || t.tool_call_id || ''))
    expect(new Set(ids).size).toBe(ids.length)
  })
})

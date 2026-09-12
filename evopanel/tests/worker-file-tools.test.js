import { describe, expect, it } from 'vitest'
import {
  collectWorkerFileEntries,
  expandWorkerFilterIds,
  omitWorkerParentWhenExpanded,
  prepareWorkerToolsForDisplayRow,
  workerFileProgress,
} from '../src/react/worker-file-tools.ts'
import { slimWorkerFileProgressEntry } from '../src/react/lib/stream-turn-engine.ts'

describe('worker-file-tools streaming state', () => {
  it('treats in-flight progress as running without payload', () => {
    const parent = {
      id: 'tc-worker',
      name: 'worker',
      status: 'running',
      input: {
        tasks: [{ path: 'src/App.tsx', action: 'write' }],
      },
      _workerFileProgress: {
        0: { index: 0, path: 'src/App.tsx', action: 'write', content: 'x'.repeat(8000) },
      },
    }
    const [entry] = collectWorkerFileEntries(parent, [])
    expect(entry.running).toBe(true)
    expect(entry.filled).toBe(false)
    expect(entry.content).toBeUndefined()
    expect(workerFileProgress([entry])).toEqual({ done: 0, total: 1 })
  })

  it('slims bulky worker_file SSE payloads', () => {
    const slim = slimWorkerFileProgressEntry({
      index: 0,
      path: 'a.ts',
      content: 'hello world',
    })
    expect(slim.content).toBeUndefined()
    expect(slim._content_bytes).toBe(11)
    expect(slim.path).toBe('a.ts')
  })

  it('prepareWorkerToolsForDisplayRow expands worker segment ids to inner tools', () => {
    const parentId = 'call_worker'
    const tools = [
      {
        id: parentId,
        name: 'worker',
        input: {
          tasks: [
            { action: 'search', query: 'foo' },
            { action: 'search', query: 'bar' },
          ],
        },
      },
      {
        id: 'worker-0-child',
        name: 'search_code_index',
        input: { query: 'foo', parent_worker_tool_call_id: parentId, invocation_source: 'worker' },
      },
      {
        id: 'worker-1-child',
        name: 'search_code_index',
        input: { query: 'bar', parent_worker_tool_call_id: parentId, invocation_source: 'worker' },
      },
    ]
    const segments = [{ kind: 'tools', ids: [parentId] }]
    const prepared = prepareWorkerToolsForDisplayRow(tools, segments)
    expect(prepared.segments?.[0]?.ids).toEqual(['worker-0-child', 'worker-1-child'])
    const panel = omitWorkerParentWhenExpanded(prepared.tools)
    expect(panel.some((t) => String((t as { id?: string }).id) === parentId)).toBe(false)
    expect(expandWorkerFilterIds([parentId], prepared.tools)).toEqual([
      'worker-0-child',
      'worker-1-child',
    ])
  })
})

import { describe, expect, it } from 'vitest'
import { resolveFileEditPayloadFromToolApi } from '../src/react/lib/file-edit-tool-fetch.ts'

describe('file-edit-tool-fetch', () => {
  it('prefers API args over inline fallback', () => {
    const fallback = {
      title: 'old.ts',
      path: 'old.ts',
      action: 'write',
      content: 'stale',
    }
    const next = resolveFileEditPayloadFromToolApi(
      {
        toolName: 'write_to_file',
        content: 'OK: wrote',
        args: {
          path: 'src/new.ts',
          content: 'fresh\ncontent',
        },
      },
      fallback,
    )
    expect(next.path).toBe('src/new.ts')
    expect(next.content).toBe('fresh\ncontent')
    expect(next.action).toBe('write')
    expect(next.running).toBe(false)
  })
})

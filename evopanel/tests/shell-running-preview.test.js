import { describe, expect, it } from 'vitest'
import { SHELL_RUNNING_PREVIEW_INTERVAL_MS } from '../src/react/hooks/useShellSessionRunningPreview.ts'

describe('useShellSessionRunningPreview', () => {
  it('refreshes sidebar running preview at most once per second', () => {
    expect(SHELL_RUNNING_PREVIEW_INTERVAL_MS).toBe(1000)
  })
})

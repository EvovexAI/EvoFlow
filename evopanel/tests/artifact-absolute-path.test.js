import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveArtifactAbsolutePath,
  withAbsoluteArtifactPaths,
  clearArtifactAbsolutePathCache,
} from '../src/lib/artifact-absolute-path.js'

const resolveTarget = vi.fn()
const resolveWorkspacePath = vi.fn()

vi.mock('../src/lib/tauri-api.js', () => ({
  api: {
    resolveWorkspaceTarget: (...args) => resolveTarget(...args),
    resolveWorkspacePath: (...args) => resolveWorkspacePath(...args),
    workspaceRuntimeInfo: async () => ({}),
  },
}))

describe('artifact absolute path', () => {
  beforeEach(() => {
    resolveTarget.mockReset()
    resolveWorkspacePath.mockReset()
    clearArtifactAbsolutePathCache()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps an already-absolute host path as-is', async () => {
    const abs = await resolveArtifactAbsolutePath('D:/dev/proj/out/report.md')
    expect(abs).toBe('D:/dev/proj/out/report.md')
  })

  it('keeps http(s) urls empty (no host path)', async () => {
    expect(await resolveArtifactAbsolutePath('https://example.com/a.png')).toBe('')
  })

  it('leaves relative paths untouched when nothing resolves', async () => {
    resolveTarget.mockResolvedValue({ resolved: '', exists: false })
    expect(await resolveArtifactAbsolutePath('outputs/x.md')).toBe('')
  })

  it('upgrades item.path to an absolute path when the backend resolves it', async () => {
    resolveTarget.mockResolvedValue({
      resolved: 'D:/dev/proj/outputs/x.md',
      exists: true,
    })
    const out = await withAbsoluteArtifactPaths(
      [{ id: 'a', type: 'file', name: 'x.md', path: 'outputs/x.md' }],
      { threadId: 't-1' },
    )
    expect(out[0].path).toBe('D:/dev/proj/outputs/x.md')
    // id / name 不受影响
    expect(out[0].id).toBe('a')
    expect(out[0].name).toBe('x.md')
  })

  it('falls back to the original path when resolution fails', async () => {
    resolveTarget.mockRejectedValue(new Error('boom'))
    const out = await withAbsoluteArtifactPaths([
      { id: 'a', type: 'file', name: 'x.md', path: 'outputs/x.md' },
    ])
    expect(out[0].path).toBe('outputs/x.md')
  })

  it('ignores items without a path', async () => {
    const out = await withAbsoluteArtifactPaths([{ id: 'a', type: 'url', name: 'x', url: 'https://e.com' }])
    expect(out[0].path).toBeUndefined()
  })

  it('caches a successful resolution (backend hit only once)', async () => {
    resolveTarget.mockResolvedValue({ resolved: 'D:/dev/proj/outputs/x.md', exists: true })
    const first = await resolveArtifactAbsolutePath('outputs/x.md', { threadId: 't-1' })
    const second = await resolveArtifactAbsolutePath('outputs/x.md', { threadId: 't-1' })
    expect(first).toBe('D:/dev/proj/outputs/x.md')
    expect(second).toBe(first)
    expect(resolveTarget).toHaveBeenCalledTimes(1)
  })

  it('does not cache failures (backend state may change later)', async () => {
    resolveTarget.mockResolvedValue({ resolved: '', exists: false })
    await resolveArtifactAbsolutePath('outputs/missing.md', { threadId: 't-1' })
    await resolveArtifactAbsolutePath('outputs/missing.md', { threadId: 't-1' })
    expect(resolveTarget).toHaveBeenCalledTimes(2)
  })
})

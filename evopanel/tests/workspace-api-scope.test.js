import { describe, it, expect } from 'vitest'
import {
  absoluteHostPathToWorkspaceRel,
  effectiveLocalWorkspaceRoot,
  formatWorkspacePathForDisplay,
  normalizeWorkspaceReadPath,
  normalizeWorkspaceRelPath,
  stripEmbeddedWorkspaceRootPrefix,
  workspaceApiArgs,
} from '../src/lib/workspace-api-scope.js'
import {
  pickPrimaryDeliverableEntry,
  resolveWritePreviewPath,
  resolveWorkspacePreviewTarget,
} from '../src/lib/workspace-preview-path.js'

describe('workspace path normalization', () => {
  it('strips workspace/ prefix for API read', () => {
    expect(normalizeWorkspaceReadPath('workspace/ai_reflection.md')).toBe('ai_reflection.md')
    expect(normalizeWorkspaceReadPath('/workspace/foo.txt')).toBe('foo.txt')
  })

  it('keeps outputs/ prefix', () => {
    expect(normalizeWorkspaceReadPath('outputs/report.html')).toBe('outputs/report.html')
  })

  it('keeps uploads/ prefix', () => {
    expect(normalizeWorkspaceReadPath('uploads/a.png')).toBe('uploads/a.png')
  })

  it('formatWorkspacePathForDisplay hides workspace prefix', () => {
    expect(formatWorkspacePathForDisplay('workspace/draft.md')).toBe('draft.md')
    expect(formatWorkspacePathForDisplay('outputs/x.md')).toBe('outputs/x.md')
  })

  it('resolveWritePreviewPath aligns with bound root', () => {
    expect(resolveWritePreviewPath('workspace/ai_reflection.md')).toBe('ai_reflection.md')
    expect(resolveWritePreviewPath('/mnt/user-data/workspace/foo.md')).toBe('foo.md')
  })

  it('strips workspace segment from Windows absolute paths when root is bound', () => {
    const root = 'D:/gh/git/project/llmops/gh-ai-fastgpt'
    const win = 'D:\\gh\\git\\project\\llmops\\gh-ai-fastgpt\\workspace\\demo_crud.md'
    expect(absoluteHostPathToWorkspaceRel(win, root)).toBe('demo_crud.md')
    // Read API keeps host absolute (backend flattens workspace/ under root)
    expect(normalizeWorkspaceReadPath(win, root)).toBe(
      'D:/gh/git/project/llmops/gh-ai-fastgpt/workspace/demo_crud.md',
    )
    expect(resolveWritePreviewPath(win)).toBe(
      'D:/gh/git/project/llmops/gh-ai-fastgpt/workspace/demo_crud.md',
    )
  })

  it('keeps Windows absolute path without workspace segment', () => {
    const win = 'D:\\proj\\gh-ai-fastgpt\\demo_crud.md'
    expect(absoluteHostPathToWorkspaceRel(win)).toBe(null)
    expect(normalizeWorkspaceReadPath(win)).toBe('D:/proj/gh-ai-fastgpt/demo_crud.md')
  })

  it('keeps chat @@绝对路径@@ outside the bound workspace for preview read', () => {
    const bound = 'D:/dev/github/EvoFlow'
    const cited =
      'D:/github/temp/doc/direct-model-call/FastGPT LLM 驱动智能文档拆分方案设计文档.md'
    expect(absoluteHostPathToWorkspaceRel(cited, bound)).toBe(null)
    expect(normalizeWorkspaceReadPath(cited, bound)).toBe(cited)
    expect(normalizeWorkspaceRelPath(cited, bound)).toBe(cited)
  })

  it('picks index/report markdown as primary deliverable in a directory', () => {
    const pick = pickPrimaryDeliverableEntry([
      { name: 'check.py', is_dir: false },
      { name: '测试执行日志.md', is_dir: false },
      { name: '交付物索引.md', is_dir: false },
      { name: '测试报告-x.md', is_dir: false },
      { name: 'workspace', is_dir: true },
    ])
    expect(pick?.name).toBe('交付物索引.md')
  })

  it('does not re-embed employee root via /outputs/ heuristic', () => {
    const root = 'D:/dev/github/EvoFlow/outputs/smart-employee-test/workspace/qa-engineer'
    const abs =
      'D:/dev/github/EvoFlow/outputs/smart-employee-test/workspace/qa-engineer/docs/roles/qa-engineer/20260808-17/test_report.md'
    // Must stay absolute — never become outputs/smart-employee-test/workspace/…
    expect(normalizeWorkspaceReadPath(abs, root)).toBe(abs)
    expect(absoluteHostPathToWorkspaceRel(abs, root)).toBe(
      'docs/roles/qa-engineer/20260808-17/test_report.md',
    )
    const bogusRel =
      'outputs/smart-employee-test/workspace/qa-engineer/docs/roles/qa-engineer/20260808-17/test_report.md'
    expect(stripEmbeddedWorkspaceRootPrefix(bogusRel, root)).toBe(
      'docs/roles/qa-engineer/20260808-17/test_report.md',
    )
    expect(normalizeWorkspaceReadPath(bogusRel, root)).toBe(
      'docs/roles/qa-engineer/20260808-17/test_report.md',
    )
  })

  it('heals drive-stripped Windows absolute paths instead of joining root', async () => {
    const { setChatWorkspaceRoot } = await import('../src/lib/chat-workspace-context.js')
    const { healStrippedAbsolutePath } = await import('../src/lib/workspace-abs-path.js')
    const root = 'D:/dev/github/EvoFlow'
    setChatWorkspaceRoot(root)
    expect(healStrippedAbsolutePath(':/dev/github/EvoFlow/output/smart-employee-test/', root)).toBe(
      'D:/dev/github/EvoFlow/output/smart-employee-test/',
    )
    expect(healStrippedAbsolutePath('/dev/github/EvoFlow/output/x', root)).toBe(
      'D:/dev/github/EvoFlow/output/x',
    )
    expect(normalizeWorkspaceReadPath(':/dev/github/EvoFlow/output/smart-employee-test/', root)).toBe(
      'D:/dev/github/EvoFlow/output/smart-employee-test/',
    )
    expect(normalizeWorkspaceReadPath('D:/dev/github/EvoFlow/output/smart-employee-test/', root)).toBe(
      'D:/dev/github/EvoFlow/output/smart-employee-test/',
    )
    expect(normalizeWorkspaceRelPath('D:/dev/github/EvoFlow/output/x', root)).toBe(
      'D:/dev/github/EvoFlow/output/x',
    )
    expect(resolveWorkspacePreviewTarget(':/dev/github/EvoFlow/output/smart-employee-test/')).toEqual({
      path: 'D:/dev/github/EvoFlow/output/smart-employee-test/',
      name: 'smart-employee-test',
    })
    expect(resolveWorkspacePreviewTarget('D:/dev/github/EvoFlow/output/x.md')).toEqual({
      path: 'D:/dev/github/EvoFlow/output/x.md',
      name: 'x.md',
    })
    setChatWorkspaceRoot('')
  })

  it('keeps POSIX absolute paths (does not strip leading slash)', () => {
    expect(normalizeWorkspaceReadPath('/Users/a/.evoflow/out/a.md')).toBe(
      '/Users/a/.evoflow/out/a.md',
    )
    expect(normalizeWorkspaceRelPath('/Users/a/.evoflow/out/a.md')).toBe(
      '/Users/a/.evoflow/out/a.md',
    )
  })

  it('normalizeWorkspaceRelPath strips lone workspace', () => {
    expect(normalizeWorkspaceRelPath('workspace')).toBe('')
    expect(normalizeWorkspaceRelPath('ai.md')).toBe('ai.md')
  })

  it('effectiveLocalWorkspaceRoot prefers session then configured', () => {
    expect(effectiveLocalWorkspaceRoot('D:/session', 'D:/panel', false)).toBe('D:/session')
    expect(effectiveLocalWorkspaceRoot('', 'D:/panel', false)).toBe('D:/panel')
    expect(effectiveLocalWorkspaceRoot('D:/session', 'D:/panel', true)).toBe('')
  })

  it('workspaceApiArgs omits thread_id when host root is available', () => {
    expect(workspaceApiArgs('D:/proj', 'uuid', { useVirtualPaths: false })).toEqual({
      root: 'D:/proj',
      threadId: undefined,
    })
    expect(
      workspaceApiArgs('', 'uuid', { configuredRoot: 'D:/proj', useVirtualPaths: false }),
    ).toEqual({ root: 'D:/proj', threadId: undefined })
    expect(workspaceApiArgs('', 'uuid', { useVirtualPaths: true })).toEqual({
      root: '',
      threadId: 'uuid',
    })
  })
})

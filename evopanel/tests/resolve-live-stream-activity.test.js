import { describe, expect, it } from 'vitest'
import {
  mergeRunningSessionPreview,
  resolveComposerDockActivity,
  resolveLiveStreamActivity,
} from '../src/react/lib/resolve-live-stream-activity.ts'

describe('resolveLiveStreamActivity', () => {
  it('prefers stream activity over panel when both present', () => {
    const r = resolveLiveStreamActivity({
      activityKind: 'tools',
      activityDetail: '调用：read_file',
      streamSystemActivity: '准备中…',
    })
    expect(r.detail).toBe('准备中…')
    expect(r.kind).toBe('tools')
    expect(r.dockLabel).toBe('准备中')
    expect(r.cursorLabel).toBe('准备中')
  })

  it('keeps pre_model as 准备中 (生成中 only for kind=model)', () => {
    const prep = resolveLiveStreamActivity({
      activityKind: 'pre_model',
      activityDetail: '准备中…',
      streamSystemActivity: '',
    })
    expect(prep.detail).toBe('准备中…')
    expect(prep.dockLabel).toBe('准备中')
    const gen = resolveLiveStreamActivity({
      activityKind: 'model',
      activityDetail: '生成中…',
      streamSystemActivity: '',
    })
    expect(gen.detail).toBe('生成中…')
    expect(gen.dockLabel).toBe('生成中')
  })

  it('uses panel tool detail when stream is idle', () => {
    const r = resolveLiveStreamActivity({
      activityKind: 'tools',
      activityDetail: '调用：read_file',
      streamSystemActivity: '',
    })
    expect(r.detail).toBe('调用：read_file')
    expect(r.runningToolSummary).toBe('调用：read_file')
    expect(r.dockLabel).toBe('调用：read_file')
  })

  it('ignores stale tool stream activity when panel is thinking', () => {
    const r = resolveLiveStreamActivity({
      activityKind: 'thinking',
      activityDetail: '推理中',
      streamSystemActivity: '调用：read_file',
      elapsedSec: 3,
    })
    expect(r.kind).toBe('thinking')
    expect(r.detail).toBe('推理中')
    expect(r.cursorLabel).toBe('推理中 · 3s')
  })

  it('falls back to stream activity when panel is idle', () => {
    const r = resolveLiveStreamActivity({
      activityKind: 'idle',
      activityDetail: '',
      streamSystemActivity: '准备中…',
    })
    expect(r.detail).toBe('准备中…')
    expect(r.kind).toBe('thinking')
    expect(r.runningPreview).toBe('准备中')
    expect(r.dockLabel).toBe('准备中')
  })

  it('uses compacting copy for dock and cursor', () => {
    const r = resolveLiveStreamActivity({
      activityKind: 'compacting',
      activityDetail: '整理中',
    })
    expect(r.dockLabel).toBe('整理中')
    expect(r.cursorLabel).toBe('整理中')
  })

  it('falls back to default compacting label when detail empty', () => {
    const r = resolveLiveStreamActivity({
      activityKind: 'compacting',
      activityDetail: '',
    })
    expect(r.dockLabel).toBe('正在压缩上下文')
    expect(r.cursorLabel).toBe('正在压缩上下文')
  })

  it('hides generic supervisor tool line', () => {
    const r = resolveLiveStreamActivity({
      activityKind: 'tools',
      activityDetail: '调用：supervisor',
    })
    expect(r.dockLabel).toBe('运行中')
    expect(r.cursorLabel).toBe('运行中')
  })

  it('appends elapsed suffix to cursor and dock labels', () => {
    const r = resolveLiveStreamActivity({
      activityKind: 'thinking',
      activityDetail: '推理中',
      elapsedSec: 12,
    })
    expect(r.dockLabel).toBe('推理中 · 12s')
    expect(r.cursorLabel).toBe('推理中 · 12s')
    expect(r.runningPreview).toBe('推理中 · 12s')
    expect(r.elapsedSec).toBe(12)
  })

  it('formats minute elapsed as mss', () => {
    const r = resolveLiveStreamActivity({
      activityKind: 'thinking',
      activityDetail: '推理中',
      elapsedSec: 65,
    })
    expect(r.dockLabel).toBe('推理中 · 1m05s')
    expect(r.cursorLabel).toBe('推理中 · 1m05s')
  })

  it('shows zero second elapsed when provided', () => {
    const r = resolveLiveStreamActivity({
      activityKind: 'thinking',
      activityDetail: '推理中',
      elapsedSec: 0,
    })
    expect(r.cursorLabel).toBe('推理中 · 0s')
  })

  it('keeps busy fallback during active turn when panel activity goes idle', () => {
    const r = resolveLiveStreamActivity({
      activityKind: 'idle',
      activityDetail: '',
      activeTurn: true,
      elapsedSec: 42,
    })
    expect(r.dockLabel).toBe('运行中 · 42s')
    expect(r.cursorLabel).toBe('运行中 · 42s')
    expect(r.runningPreview).toBe('运行中 · 42s')
  })

  it('shows tool approval pause copy instead of 运行中', () => {
    const r = resolveLiveStreamActivity({
      activityKind: 'tool_approval',
      activityDetail: '等待工具授权…',
      activeTurn: false,
      elapsedSec: 9,
    })
    expect(r.kind).toBe('tool_approval')
    expect(r.dockLabel).toBe('等待工具授权')
    expect(r.cursorLabel).toBe('等待工具授权')
    expect(r.runningPreview).toBe('等待工具授权')
  })

  it('falls back to tool approval label when detail empty', () => {
    const r = resolveLiveStreamActivity({
      activityKind: 'tool_approval',
      activityDetail: '',
      activeTurn: false,
    })
    expect(r.dockLabel).toBe('等待工具授权')
    expect(r.cursorLabel).toBe('等待工具授权')
  })
})

describe('resolveComposerDockActivity', () => {
  it('matches composer dock (dockLabel with elapsed)', () => {
    const r = resolveComposerDockActivity({
      activityKind: 'tools',
      activityDetail: '调用：read_file',
      elapsedSec: 5,
    })
    expect(r.dockLabel).toBe('调用：read_file · 5s')
    expect(r.dockLabel).toBe(r.cursorLabel)
  })
})

describe('mergeRunningSessionPreview', () => {
  it('overrides base preview with resolved activity detail', () => {
    const resolved = resolveLiveStreamActivity({
      activityKind: 'tools',
      activityDetail: '调用：write_file',
    })
    const merged = mergeRunningSessionPreview(
      { runningPreview: 'partial text', runningToolSummary: 'old_tool' },
      resolved,
    )
    expect(merged.runningPreview).toBe('')
    expect(merged.runningToolSummary).toBe('调用：write_file')
  })
})

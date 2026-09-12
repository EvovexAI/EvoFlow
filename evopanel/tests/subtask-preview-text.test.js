import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isGenericSubtaskWaitHint,
  resolveSubtaskLivePreview,
} from '../src/lib/subtask-preview-text.ts'

describe('resolveSubtaskLivePreview', () => {
  it('prefers live stream over generic wait hints', () => {
    const r = resolveSubtaskLivePreview({
      subtaskId: 'Subtask_a',
      fallbackTitle: '子任务 #1',
      running: true,
      terminal: false,
      subagentTasks: {
        t1: {
          taskId: 't1',
          collabSubtaskId: 'Subtask_a',
          phase: 'running',
          liveOutput: '正在写入配置文件…',
        },
      },
      statusHint: '已派发，等待流式输出…',
    })
    assert.equal(r.previewText, '正在写入配置文件…')
    assert.equal(r.hasLiveContent, true)
  })

  it('shows 运行中 when stream matched without text', () => {
    const r = resolveSubtaskLivePreview({
      subtaskId: 'Subtask_b',
      fallbackTitle: '子任务 #2',
      running: true,
      terminal: false,
      subagentTasks: {
        t2: {
          taskId: 't2',
          collabSubtaskId: 'Subtask_b',
          phase: 'running',
          liveOutput: '',
        },
      },
      statusHint: 'Subagent executing (await subtask_outcome_report)',
    })
    assert.equal(r.previewText, '运行中…')
    assert.equal(r.streamMatched, true)
  })

  it('detects generic wait hints', () => {
    assert.equal(isGenericSubtaskWaitHint('已派发，等待流式输出…'), true)
    assert.equal(isGenericSubtaskWaitHint('正在分析代码结构'), false)
  })
})

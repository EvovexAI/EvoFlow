import { describe, expect, it } from 'vitest'
import {
  resolveTurnDisplayPhase,
  turnDisplayPhaseForceExpanded,
  turnDisplayPhaseIsStreamingUi,
  turnDisplayPhaseLabel,
  turnDisplayPhaseMayCollapseWhenIdle,
  turnDisplayPhaseShowSemanticProgress,
} from '../src/react/lib/turn-display-phase.ts'
import { buildSemanticRunSteps, formatSemanticFileChange } from '../src/react/lib/semantic-run-steps.ts'

describe('resolveTurnDisplayPhase', () => {
  it('exploring while streaming without final below', () => {
    expect(
      resolveTurnDisplayPhase({ isStreaming: true, hasFinalReplyBelow: false }),
    ).toBe('exploring')
  })

  it('final_streaming while streaming with final below', () => {
    expect(
      resolveTurnDisplayPhase({ isStreaming: true, hasFinalReplyBelow: true }),
    ).toBe('final_streaming')
  })

  it('done when idle with final below', () => {
    expect(
      resolveTurnDisplayPhase({ isStreaming: false, hasFinalReplyBelow: true }),
    ).toBe('done')
  })

  it('done_no_final when idle without final below', () => {
    expect(
      resolveTurnDisplayPhase({ isStreaming: false, hasFinalReplyBelow: false }),
    ).toBe('done_no_final')
  })

  it('forceCollapsed standalone fold when idle', () => {
    expect(
      resolveTurnDisplayPhase({
        isStreaming: false,
        hasFinalReplyBelow: false,
        forceCollapsed: true,
      }),
    ).toBe('done')
  })
})

describe('turn display phase helpers', () => {
  it('label falls back to Ran tools', () => {
    expect(turnDisplayPhaseLabel('exploring', false)).toBe('Ran tools')
    expect(turnDisplayPhaseLabel('exploring', true)).toBe('Ran tools')
    expect(turnDisplayPhaseLabel('done', false)).toBe('Ran tools')
  })

  it('may collapse on all phases (tech trace default hidden)', () => {
    expect(turnDisplayPhaseMayCollapseWhenIdle('done')).toBe(true)
    expect(turnDisplayPhaseMayCollapseWhenIdle('done_no_final')).toBe(true)
    expect(turnDisplayPhaseMayCollapseWhenIdle('exploring')).toBe(true)
    expect(turnDisplayPhaseMayCollapseWhenIdle('final_streaming')).toBe(true)
  })

  it('never force-expands tech trace', () => {
    expect(turnDisplayPhaseForceExpanded('exploring')).toBe(false)
    expect(turnDisplayPhaseForceExpanded('done_no_final')).toBe(false)
    expect(turnDisplayPhaseForceExpanded('done')).toBe(false)
    expect(turnDisplayPhaseForceExpanded('final_streaming')).toBe(false)
  })

  it('streaming ui class on active phases', () => {
    expect(turnDisplayPhaseIsStreamingUi('exploring')).toBe(true)
    expect(turnDisplayPhaseIsStreamingUi('final_streaming')).toBe(true)
    expect(turnDisplayPhaseIsStreamingUi('done')).toBe(false)
    expect(turnDisplayPhaseIsStreamingUi('done_no_final')).toBe(false)
  })

  it('semantic progress while exploring / done_no_final', () => {
    expect(turnDisplayPhaseShowSemanticProgress('exploring')).toBe(true)
    expect(turnDisplayPhaseShowSemanticProgress('done_no_final')).toBe(true)
    expect(turnDisplayPhaseShowSemanticProgress('done')).toBe(false)
    expect(turnDisplayPhaseShowSemanticProgress('final_streaming')).toBe(false)
  })
})

describe('buildSemanticRunSteps', () => {
  it('maps read tools to human labels without absolute paths', () => {
    const steps = buildSemanticRunSteps([
      {
        id: '1',
        name: 'Read',
        status: 'ok',
        input: { path: 'D:/dev/github/EvoFlow/evopanel/src/react/components/MessageRow.tsx' },
      },
      {
        id: '2',
        name: 'Grep',
        status: 'running',
        input: { pattern: 'msg-turn' },
      },
    ])
    expect(steps[0].label).toBe('检查 MessageRow.tsx')
    expect(steps[0].label).not.toContain('D:/')
    expect(steps[0].status).toBe('done')
    expect(steps[1].label).toBe('检索相关代码')
    expect(steps[1].status).toBe('active')
  })

  it('compresses consecutive identical labels with count', () => {
    const steps = buildSemanticRunSteps([
      { id: '1', name: 'Grep', status: 'ok', input: { pattern: 'a' } },
      { id: '2', name: 'Grep', status: 'ok', input: { pattern: 'b' } },
      { id: '3', name: 'Grep', status: 'ok', input: { pattern: 'c' } },
      {
        id: '4',
        name: 'Read',
        status: 'ok',
        input: { path: 'SkillPickerModal.tsx' },
      },
      {
        id: '5',
        name: 'Read',
        status: 'ok',
        input: { path: 'AgentPickerModal.tsx' },
      },
    ])
    expect(steps).toHaveLength(3)
    expect(steps[0].label).toBe('检索相关代码')
    expect(steps[0].count).toBe(3)
    expect(steps[1].label).toBe('检查 SkillPickerModal.tsx')
    expect(steps[1].count).toBe(1)
    expect(steps[2].label).toBe('检查 AgentPickerModal.tsx')
    expect(steps[2].count).toBe(1)
  })

  it('window-merges same file across intervening different labels', () => {
    const steps = buildSemanticRunSteps([
      { id: '1', name: 'Read', status: 'ok', input: { path: 'react-chat.css' } },
      { id: '2', name: 'Read', status: 'ok', input: { path: 'react-chat.css' } },
      { id: '3', name: 'Grep', status: 'ok', input: { pattern: 'a' } },
      { id: '4', name: 'Shell', status: 'ok', input: { command: 'echo hi' } },
      { id: '5', name: 'Read', status: 'ok', input: { path: 'react-chat.css' } },
      { id: '6', name: 'Read', status: 'ok', input: { path: 'react-chat.css' } },
    ])
    const css = steps.find((s) => s.label === '检查 react-chat.css')
    expect(css).toBeTruthy()
    expect(css.count).toBe(4)
    expect(steps.some((s) => s.label === '检索相关代码')).toBe(true)
    expect(steps.some((s) => s.label === '执行命令')).toBe(true)
    expect(steps.filter((s) => s.label === '检查 react-chat.css')).toHaveLength(1)
  })

  it('does not merge different files or error with done', () => {
    const steps = buildSemanticRunSteps([
      { id: '1', name: 'Read', status: 'ok', input: { path: 'a.css' } },
      { id: '2', name: 'Grep', status: 'ok', input: { pattern: 'x' } },
      { id: '3', name: 'Read', status: 'ok', input: { path: 'b.css' } },
      { id: '4', name: 'Read', status: 'error', input: { path: 'a.css' } },
    ])
    expect(steps.map((s) => s.label)).toEqual([
      '检查 a.css',
      '检索相关代码',
      '检查 b.css',
      '检查 a.css',
    ])
    expect(steps[0].status).toBe('done')
    expect(steps[3].status).toBe('error')
    expect(steps[0].count).toBe(1)
    expect(steps[3].count).toBe(1)
  })

  it('uses action-like shell labels and never 处理当前步骤', () => {
    const steps = buildSemanticRunSteps([
      { id: '1', name: 'Shell', status: 'ok', input: { command: 'npm test' } },
      { id: '2', name: 'Shell', status: 'ok', input: { command: 'ls -la' } },
      { id: '3', name: 'mystery_tool', status: 'ok', input: {} },
    ])
    expect(steps[0].label).toBe('执行验证命令')
    expect(steps[1].label).toBe('执行命令')
    expect(steps[2].label).toBe('继续执行任务')
    expect(steps.every((s) => !String(s.label).includes('处理当前步骤'))).toBe(true)
  })

  it('keeps running status when compressing into an active step', () => {
    const steps = buildSemanticRunSteps([
      { id: '1', name: 'Grep', status: 'ok', input: { pattern: 'a' } },
      { id: '2', name: 'Grep', status: 'running', input: { pattern: 'b' } },
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0].count).toBe(2)
    expect(steps[0].status).toBe('active')
  })

  it('prefers backend activity_label when present without inventing stages', () => {
    const steps = buildSemanticRunSteps([
      {
        id: '1',
        name: 'Grep',
        status: 'ok',
        activity_id: 'inspect-style',
        activity_label: '检查 Picker 样式',
        input: { pattern: 'x' },
      },
      {
        id: '2',
        name: 'Read',
        status: 'ok',
        activity_id: 'inspect-style',
        activity_label: '检查 Picker 样式',
        input: { path: 'a.css' },
      },
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0].label).toBe('检查 Picker 样式')
    expect(steps[0].activityId).toBe('inspect-style')
    expect(steps[0].count).toBe(2)
  })

  it('attaches write/edit line stats for file steps', () => {
    const steps = buildSemanticRunSteps([
      {
        id: '1',
        name: 'write',
        status: 'ok',
        input: {
          path: 'src/foo.ts',
          content: 'a\nb\nc',
        },
      },
      {
        id: '2',
        name: 'str_replace',
        status: 'ok',
        input: {
          path: 'src/bar.ts',
          old_string: 'old1\nold2',
          new_string: 'new1\nnew2\nnew3',
        },
      },
      {
        id: '3',
        name: 'delete_file',
        status: 'ok',
        input: { path: 'src/gone.ts' },
      },
    ])
    expect(steps[0].label).toBe('写入 foo.ts')
    expect(steps[0].fileChange).toEqual({ action: 'write', added: 3, removed: 0 })
    expect(formatSemanticFileChange(steps[0].fileChange)).toBe('写入 3 行')

    expect(steps[1].label).toBe('修改 bar.ts')
    expect(steps[1].fileChange).toEqual({ action: 'replace', added: 3, removed: 2 })
    expect(formatSemanticFileChange(steps[1].fileChange)).toBe('新增 3 行 · 删除 2 行')

    expect(steps[2].label).toBe('删除 gone.ts')
    expect(steps[2].fileChange).toEqual({ action: 'delete', added: 0, removed: 0 })
    expect(formatSemanticFileChange(steps[2].fileChange)).toBe('已删除')
  })

  it('sums line stats when merging same-file edits', () => {
    const steps = buildSemanticRunSteps([
      {
        id: '1',
        name: 'str_replace',
        status: 'ok',
        _writeProgress: { lines_added: 2, lines_removed: 1 },
        input: { path: 'ChatApp.tsx', old_string: 'a', new_string: 'bb' },
      },
      {
        id: '2',
        name: 'str_replace',
        status: 'ok',
        _writeProgress: { lines_added: 5, lines_removed: 3 },
        input: { path: 'ChatApp.tsx', old_string: 'c', new_string: 'ddddd' },
      },
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0].label).toBe('修改 ChatApp.tsx')
    expect(steps[0].count).toBe(2)
    expect(steps[0].fileChange).toEqual({ action: 'replace', added: 7, removed: 4 })
  })
})

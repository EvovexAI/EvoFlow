import { describe, expect, it } from 'vitest'
import {
  cloneTerminalStreamsMap,
  isTerminalStreamEvent,
  mergeTerminalStreamEvent,
  pickTerminalDisplayCommand,
  resolveTerminalStreamTask,
  stripTerminalHarnessCommand,
} from '../src/react/terminal-stream-merge.js'
import { extractShellCommandFromToolInput } from '../src/lib/chat-normalize.js'

describe('terminal-stream-merge', () => {
  it('recognizes terminal stream events', () => {
    expect(isTerminalStreamEvent({ type: 'terminal_start' })).toBe(true)
    expect(isTerminalStreamEvent({ type: 'terminal_stdout' })).toBe(true)
    expect(isTerminalStreamEvent({ type: 'task_running' })).toBe(false)
  })

  it('merges start, stdout, stderr, and exit', () => {
    const map = {}
    mergeTerminalStreamEvent(map, {
      type: 'terminal_start',
      tool_call_id: 'tc-1',
      command: 'npm run build',
    })
    mergeTerminalStreamEvent(map, {
      type: 'terminal_stdout',
      tool_call_id: 'tc-1',
      text: 'building...\n',
    })
    mergeTerminalStreamEvent(map, {
      type: 'terminal_stderr',
      tool_call_id: 'tc-1',
      text: 'warn: deprecated\n',
    })
    mergeTerminalStreamEvent(map, {
      type: 'terminal_exit',
      tool_call_id: 'tc-1',
      exit_code: 0,
      success: true,
    })

    expect(map['tc-1'].command).toBe('npm run build')
    expect(map['tc-1'].stdout).toContain('building')
    expect(map['tc-1'].stderr).toContain('warn')
    expect(map['tc-1'].phase).toBe('success')
    expect(map['tc-1'].exitCode).toBe(0)
    expect(map['tc-1'].chunks?.length).toBe(2)
  })

  it('resolves stream by tool_call_id before id', () => {
    const map = {
      'sse-id': { toolCallId: 'sse-id', phase: 'success', stdout: 'live', chunks: [] },
    }
    const hit = resolveTerminalStreamTask(map, {
      id: 'row-id',
      tool_call_id: 'sse-id',
    })
    expect(hit?.stdout).toBe('live')
  })

  it('does not fall back to tool.id when tool_call_id misses map (prevents cross-terminal bleed)', () => {
    const map = {
      'new-stream': { toolCallId: 'new-stream', phase: 'running', stdout: 'new output\n', chunks: [] },
    }
    const hit = resolveTerminalStreamTask(map, {
      id: 'new-stream',
      tool_call_id: 'old-call',
    })
    expect(hit).toBeUndefined()
  })

  it('deep-clones map so later merges do not mutate snapshots', () => {
    const map = {}
    mergeTerminalStreamEvent(map, {
      type: 'terminal_start',
      tool_call_id: 'tc-a',
      command: 'echo a',
    })
    mergeTerminalStreamEvent(map, {
      type: 'terminal_stdout',
      tool_call_id: 'tc-a',
      text: 'aaa\n',
    })
    const snap = cloneTerminalStreamsMap(map)
    mergeTerminalStreamEvent(map, {
      type: 'terminal_stdout',
      tool_call_id: 'tc-b',
      text: 'bbb\n',
    })
    expect(snap['tc-a'].stdout).toBe('aaa\n')
    expect(map['tc-b'].stdout).toBe('bbb\n')
  })

  it('stripTerminalHarnessCommand removes encoding wrapper', () => {
    const raw =
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; rg --version 2>&1'
    expect(stripTerminalHarnessCommand(raw)).toBe('rg --version 2>&1')
  })

  it('pickTerminalDisplayCommand prefers terminal stream over stale tool args', () => {
    const stream = {
      toolCallId: 'tc-2',
      phase: 'success',
      command:
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $rgDir = "$env:USERPROFILE\\.rg"',
      stdout: '',
      stderr: '',
      chunks: [],
    }
    const cmd = pickTerminalDisplayCommand(
      stream,
      '{"command":"rg --version2>&1"}',
      { command: 'rg --version2>&1' },
      extractShellCommandFromToolInput,
    )
    expect(cmd).toContain('$rgDir')
    expect(cmd).not.toBe('rg --version2>&1')
  })
})

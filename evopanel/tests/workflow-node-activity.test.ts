import { describe, expect, it } from 'vitest'
import {
  pickLatestTool,
  pickLiveProse,
  resolveNodeActivity,
  shortToolLabel,
} from '../src/lib/workflow-node-activity.js'

describe('workflow node activity', () => {
  it('shortens tool names and mcp names', () => {
    expect(shortToolLabel('read_file')).toBe('读取')
    expect(shortToolLabel('mcp__node_repl__js')).toBe('脚本')
    expect(shortToolLabel('Bash')).toBe('终端')
    expect(shortToolLabel('')).toBe('工具')
  })

  it('picks the running tool as the latest activity', () => {
    const { line, activeToolLabel } = pickLatestTool([
      { name: 'read_file', status: 'done' },
      { name: 'web_search', status: 'done' },
      { name: 'bash', status: 'running' },
    ])
    expect(line?.text).toBe('终端')
    expect(line?.isTool).toBe(true)
    expect(line?.running).toBe(true)
    expect(activeToolLabel).toBe('终端')
  })

  it('falls back to the last tool when none is running', () => {
    const { line } = pickLatestTool([
      { name: 'read_file', status: 'done' },
      { name: 'write_file', status: 'done' },
    ])
    expect(line?.text).toBe('写入')
    expect(line?.running).toBe(false)
  })

  it('marks failed tools', () => {
    const { line } = pickLatestTool([{ name: 'bash', status: 'failed' }])
    expect(line?.failed).toBe(true)
    expect(line?.running).toBe(false)
  })

  it('treats tools without status as running unless they have output', () => {
    const { line } = pickLatestTool([{ name: 'read_file' }])
    expect(line?.running).toBe(true)
    const done = pickLatestTool([{ name: 'write_file', output: 'done' }])
    expect(done.line?.running).toBe(false)
  })

  it('returns no line for empty tools', () => {
    expect(pickLatestTool([]).line).toBeNull()
    expect(pickLatestTool(undefined).line).toBeNull()
  })

  it('picks the last prose segment and drops tool json noise', () => {
    const text = '第一段正文\n\n───\n\n{"ok":true}\n\n───\n\n最后这段是结论'
    expect(pickLiveProse(text)).toBe('最后这段是结论')
  })

  it('truncates long prose to a single line', () => {
    const long = 'x'.repeat(200)
    const out = pickLiveProse(long)
    expect(out.length).toBeLessThanOrEqual(68)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns empty string for empty prose', () => {
    expect(pickLiveProse('')).toBe('')
    expect(pickLiveProse('   ')).toBe('')
  })

  it('prefers the running tool over prose', () => {
    const activity = resolveNodeActivity({
      tools: [{ name: 'web_search', status: 'running' }],
      liveOutput: '正在搜索相关资料',
      running: true,
    })
    expect(activity.latest?.text).toBe('搜索')
    expect(activity.latest?.isTool).toBe(true)
  })

  it('shows prose when no tool is running', () => {
    const activity = resolveNodeActivity({
      tools: [{ name: 'web_search', status: 'done' }],
      liveOutput: '正在搜索相关资料',
      running: true,
    })
    expect(activity.latest?.text).toBe('正在搜索相关资料')
    expect(activity.latest?.isTool).toBe(false)
  })

  it('reports no activity when nothing is available', () => {
    const activity = resolveNodeActivity({ running: false })
    expect(activity.hasActivity).toBe(false)
    expect(activity.latest).toBeNull()
  })
})

import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import {
  annotateLiveWorkProcessEvents,
  formatWorkProcessLiveBanner,
  formatWorkProcessLiveLine,
  pickLatestWorkProcessLive,
} from '../src/lib/proactive-work-process.js'

function ev(partial) {
  return {
    id: 'e',
    kind: 'step',
    action: '步骤',
    title: '',
    status: '完成',
    statusKey: 'completed',
    summary: '',
    output: '',
    isError: false,
    isSystemPrompt: false,
    ...partial,
  }
}

describe('work process live progress', () => {
  it('picks running tool over later completed model', () => {
    const latest = pickLatestWorkProcessLive([
      ev({ id: 't', kind: 'tool', action: 'web_search', toolTitle: '搜索资料', statusKey: 'running' }),
      ev({ id: 'm', kind: 'model', action: '模型回复', summary: '先看一下', statusKey: 'completed' }),
    ])
    assert.equal(latest?.id, 't')
    assert.match(formatWorkProcessLiveLine(latest), /正在调用：搜索资料/)
  })

  it('annotates last model as running when the round is live', () => {
    const out = annotateLiveWorkProcessEvents(
      [
        ev({ id: 'u', action: '值班节拍', kind: 'step', summary: '本轮值班开始 · 小V' }),
        ev({
          id: 'm',
          kind: 'model',
          action: '模型回复',
          statusKey: 'completed',
          summary: '正在核对看板里的未结任务',
          output: '正在核对看板里的未结任务',
        }),
      ],
      { live: true },
    )
    assert.equal(out[1].statusKey, 'running')
    assert.match(formatWorkProcessLiveBanner(pickLatestWorkProcessLive(out), { live: true }), /正在回复/)
  })

  it('annotates unfinished tool as running when live', () => {
    const out = annotateLiveWorkProcessEvents(
      [ev({ id: 't', kind: 'tool', action: 'read_file', toolTitle: '读取文件 · a.md', statusKey: 'completed', output: '' })],
      { live: true },
    )
    assert.equal(out[0].statusKey, 'running')
    assert.match(formatWorkProcessLiveLine(out[0]), /正在调用/)
  })

  it('does not mark wrap-up reply as running', () => {
    const out = annotateLiveWorkProcessEvents(
      [ev({ id: 'm', kind: 'model', action: '模型回复', summary: '本轮值班结束 · 暂无未结', output: '本轮值班结束' })],
      { live: true },
    )
    assert.equal(out[0].statusKey, 'completed')
  })

  it('shows latest completed line with live prefix when still executing', () => {
    const line = formatWorkProcessLiveBanner(
      ev({ kind: 'tool', toolTitle: '搜索资料', summary: '搜索资料', statusKey: 'completed' }),
      { live: true },
    )
    assert.match(line, /正在推进 · 最新：搜索资料/)
  })
})

/**
 * 接线测试：LangGraph custom 流 → applyRightStageAgUiCustom 这一层必须把 key / target 带下去。
 *
 * 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】新建。
 *
 * 为什么必须有这一份（现有 right-stage-close-move.test.ts 咬不住这个缺陷）：
 * 重启后真机实测（日志 right-stage-2026-11-21.log）：
 *   00:33:21.655 [py] emit sent action=activate key=employeeProcess:process:live:release-engineer
 *   00:34:48.977 [py] emit sent action=close    key=shell-page:shell:/tasks
 *   两条之后前端 [web-state] 一行都没有，activeKey 仍停 /tasks、tabs 仍 3 个。
 * 抓 dist bundle 发现 ws-client 里是：
 *   applyRightStageAgUiCustom(t, { action: chunk.action, surface: chunk.surface })
 * —— 只搬 action + surface，把 key 丢了。这是同一类缺陷的第三处
 * （后端 agui_stream_normalizer 一处、right-stage-agui.ts 一处、这里上游分发层一处）。
 *
 * 现有 close-move 测试直接调 applyRightStageAgUiCustom，**绕过了这一层**，
 * 所以它一直全绿，而真机一直不动。本文件走真实生产入口
 * ``dispatchCollabCustomEvent`` → ``dispatchLangGraphCustomStreamChunk``，
 * 判据是「只喂 chunk，key 有没有到达 store」。
 *
 * 反证要求：把 ws-client.js 里那段 key 透传删掉，本文件必须红。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { rightStageStore } from '../src/lib/right-stage/right-stage-store.js'
import { dispatchCollabCustomEvent } from '../src/lib/ws-client.js'

const SK = 'proactive:self-evolution-bot:chat:test-102'

function resetStore() {
  for (const t of [...(rightStageStore.getSnapshot().tabs || [])]) {
    rightStageStore.closeTab(rightStageStore.keyOf(t))
  }
}

function seed() {
  rightStageStore.show({ kind: 'shell-page', id: 'a', title: 'A', data: { path: '/tasks' } })
  rightStageStore.show({ kind: 'shell-page', id: 'b', title: 'B', data: { path: '/proactive' } })
  rightStageStore.show({ kind: 'shell-page', id: 'c', title: 'C', data: { path: '/notes' } })
}

function keys(): string[] {
  return (rightStageStore.getSnapshot().tabs || []).map((t) => rightStageStore.keyOf(t))
}

describe('custom 流分发层：key / target 必须透传到 store', () => {
  beforeEach(() => {
    resetStore()
    seed()
  })

  it('activate：chunk 里只有 key 时也要真的切签', () => {
    const target = keys()[0]!
    rightStageStore.activateTab(keys()[2]!) // 先停在别的签上
    expect(rightStageStore.getSnapshot().activeKey).toBe(keys()[2])

    dispatchCollabCustomEvent(SK, {
      type: 'right_stage',
      action: 'activate',
      surface: null,
      key: target,
    })

    expect(rightStageStore.getSnapshot().activeKey).toBe(target)
  })

  it('close：关单个签，签数减 1 且被关的 key 消失', () => {
    const before = keys()
    const victim = before[1]!
    expect(before).toHaveLength(3)

    dispatchCollabCustomEvent(SK, {
      type: 'right_stage',
      action: 'close',
      surface: null,
      key: victim,
    })

    const after = keys()
    expect(after).toHaveLength(2)
    expect(after).not.toContain(victim)
  })

  it('move：调换两个签的先后顺序（签数不变）', () => {
    const before = keys()
    const src = before[0]!
    const dst = before[2]!

    dispatchCollabCustomEvent(SK, {
      type: 'right_stage',
      action: 'move',
      surface: null,
      key: src,
      target: dst,
    })

    const after = keys()
    expect(after).toHaveLength(3)
    // 源签不再在原位，目标签前移：只要顺序真变了就算生效
    expect(after).not.toEqual(before)
    expect(after.indexOf(src)).not.toBe(0)
  })

  it('反证对照组：不带 key 的 activate 不许静默改变任何东西', () => {
    const activeBefore = rightStageStore.getSnapshot().activeKey
    const keysBefore = keys()

    dispatchCollabCustomEvent(SK, {
      type: 'right_stage',
      action: 'activate',
      surface: null,
      // 故意不给 key —— 前端应拒绝而不是乱切
    })

    expect(keys()).toEqual(keysBefore)
    expect(rightStageStore.getSnapshot().activeKey).toBe(activeBefore)
  })
})

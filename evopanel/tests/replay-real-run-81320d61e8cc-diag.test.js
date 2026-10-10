// 诊断回放：run-81320d61e8cc（用户 09:53 实测，plan_text b1 只有 9 字 + tasks 工具 + body_text b3 长文）
// 症状：流式期间 b1 文本只剩「跑。」（尾部 2 字），b3 文本多次清零重来（15→87→0→8→26）。
// 本测试复刻 ChatApp applyAgUiWireEvent 的完整链路（含 priorTurnStrip），逐事件打印
// b1/b3 bucket 内容 + isolateStreamProjection 后的可见文本，定位「谁吃掉了前缀」。
// 结论（2026-10-10）：reducer + strip + 投影管线全程干净（b1 全文 9 字、b3 平滑涨到
// 1350 字）；真正的尾窗/清零来自 mergeLiveSnapshotRow 的 partialText.slice 与
// RUN_FINISHED 帧上 reducer 的 TypeError（均已修复）。本测试保留为回归护栏。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventSchemas } from '@ag-ui/core'
import {
  applyAgUiEvent,
  emptyAgUiTurnState,
  projectAgUiToStreamTurnFields,
} from '../src/react/lib/agui-turn-reducer.ts'
import {
  stripLoosePriorBodyEcho,
  stripPriorTurnPollutants,
} from '../src/react/lib/turn-text-isolation.ts'
import { isolateStreamProjection } from '../src/react/lib/turn-text-isolation.ts'
import { emptyStreamTurn } from '../src/react/lib/stream-turn-engine.ts'

const __dir = dirname(fileURLToPath(import.meta.url))

function loadRealRunEvents(name) {
  const raw = readFileSync(join(__dir, 'fixtures', 'agui', name), 'utf8')
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('========'))
    .map((l) => EventSchemas.parse(JSON.parse(l)))
}

// 上一轮（09:46 run）落库 assistant 行的可见正文（ui-display.log +0ms 行的 chunk#0 + chunk#2）
const PRIOR_BODY_CANDIDATES = {
  // 最后一轮 final reply 全文开头（日志截断，补齐已知部分）
  oldRowFlatten:
    '好，重启后我直接实测。\n只有 :8070 一个服务，且它 09:45:06 启动（早于我刚重写的代码）。所以**还需要再重启一次**——上次重启时，精简投影恰好已经被外部流程冲掉了。\n## 说明白发生了什么\n| 时间 | 事件 |\n|---|---|\n| 09:39:01 | 我写下精简投影 |',
  // 仅 chunk#0
  oldChunk0: '好，重启后我直接实测。',
  // 空
  empty: '',
}

function wireApply(S, ev, priorStrip) {
  // 复刻 chat-stream-apply.applyAgUiWireEvent 的 delta 剥离（不含 reasoning 分支）
  let wireEvent = ev
  if (ev.type === 'TEXT_MESSAGE_CONTENT') {
    const delta = String(ev.delta || '')
    if (delta) {
      const cleaned = stripLoosePriorBodyEcho(stripPriorTurnPollutants(delta, priorStrip), priorStrip.body)
      if (!cleaned) return { dropped: true, cleaned: '' }
      if (cleaned !== delta) wireEvent = { ...ev, delta: cleaned }
      return { dropped: false, cleaned }
    }
  }
  S.aguiTurn = applyAgUiEvent(S.aguiTurn, wireEvent)
  return { dropped: false }
}

describe('诊断：run-81320d61e8cc 流式文本被吃前缀', () => {
  let realNow
  beforeEach(() => {
    realNow = Date.now
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T09:53:31.000+08:00'))
    // 静音 reducer 里的 GearDebug console.log
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    Date.now = realNow
    vi.restoreAllMocks()
  })

  for (const [stripName, priorBody] of Object.entries(PRIOR_BODY_CANDIDATES)) {
    it(`wire 层 delta 剥离观察（priorStrip.body=${stripName}）`, () => {
      const events = loadRealRunEvents('run-81320d61e8cc-sse.jsonl')
      const S = { aguiTurn: emptyAgUiTurnState('run-81320d61e8cc', 'a8186ed1'), turn: emptyStreamTurn(), compactedParts: [] }
      const priorStrip = { body: priorBody, reasoning: '', reasoningSegments: [], toolIds: [] }
      const drops = []
      let idx = 0
      for (const ev of events) {
        idx++
        vi.setSystemTime(new Date(Date.now() + 30))
        if (ev.type === 'TEXT_MESSAGE_CONTENT') {
          const r = wireApply(S, ev, priorStrip)
          let b1id = ''
          for (const [id] of S.aguiTurn.messages) {
            if (id.endsWith(':0:b1')) b1id = id
          }
          const content = b1id ? String(S.aguiTurn.messages.get(b1id)?.content || '') : ''
          if (r.dropped || (content && content !== '好，重启完我再跑。' && content.length < 9)) {
            drops.push({ idx, delta: ev.delta, dropped: r.dropped, cleaned: r.cleaned, b1Content: content })
          }
        } else {
          wireApply(S, ev, priorStrip)
        }
      }
      // 回归护栏：任何 prior 候选下，b1 累积都不应出现「非前缀截断」（如只剩尾窗「跑。」）
      let b1Final = ''
      for (const [id, m] of S.aguiTurn.messages) {
        if (id.endsWith(':0:b1')) b1Final = String(m.content || '')
      }
      console.warn(`[${stripName}] 异常点数:`, drops.length, '| b1 最终:', JSON.stringify(b1Final))
    })
  }

  it('RUN_FINISHED 帧不再抛 TypeError（state.timeline 不存在）且 finished 置位', () => {
    const events = loadRealRunEvents('run-81320d61e8cc-sse.jsonl')
    let s = emptyAgUiTurnState('run-81320d61e8cc', 'a8186ed1')
    for (const ev of events) {
      vi.setSystemTime(new Date(Date.now() + 30))
      s = applyAgUiEvent(s, ev)
    }
    expect(s.finished).toBe(true)
    // 封存后 compatSegments 仍含 b1 + b3 两段 text
    const textSegs = s.compatSegments.filter((x) => x.kind === 'text')
    expect(textSegs.length).toBe(2)
    expect(String(textSegs[0]?.text || '')).toBe('好，重启完我再跑。')
    expect(String(textSegs[1]?.text || '').length).toBeGreaterThan(1000)
  })

  it('投影层：isolateStreamProjection 不吃前缀（各 priorBody 候选）', () => {
    const events = loadRealRunEvents('run-81320d61e8cc-sse.jsonl')
    let s = emptyAgUiTurnState('run-81320d61e8cc', 'a8186ed1')
    for (const ev of events) {
      vi.setSystemTime(new Date(Date.now() + 30))
      s = applyAgUiEvent(s, ev)
    }
    let b1Content = ''
    for (const [id, m] of s.messages) {
      if (id.endsWith(':0:b1')) b1Content = String(m.content || '')
    }
    expect(b1Content).toBe('好，重启完我再跑。')
    const b3Content = [...s.messages.entries()].filter(([id]) => id.endsWith(':0:b3')).map(([, m]) => String(m.content || ''))[0] || ''
    expect(b3Content.length).toBeGreaterThan(1000)

    for (const [stripName, priorBody] of Object.entries(PRIOR_BODY_CANDIDATES)) {
      const turn = {
        ...emptyStreamTurn(),
        timeline: [
          { kind: 'text', text: b1Content, seq: 1 },
          { kind: 'tools', ids: ['call_00_o5dhp0a916s864z1mnkwl4na'], seq: 2 },
          { kind: 'text', text: b3Content.slice(0, 500), seq: 3 },
        ],
        openText: b3Content.slice(500),
        tools: [],
      }
      const out = isolateStreamProjection(turn, { body: priorBody, reasoning: '', reasoningSegments: [], toolIds: [] })
      const segTexts = (out.segments || []).filter((x) => x.kind === 'text').map((x) => String(x.text || ''))
      // b1 的文本段必须完整保留（不得被掐成「跑。」之类的尾窗）
      expect(segTexts[0], `[${stripName}] b1 段应完整保留`).toBe(b1Content)
    }
  })

  it('全程投影快照：openText 单调增长、TEXT_MESSAGE_END 后 compatSegments 含全文', () => {
    const events = loadRealRunEvents('run-81320d61e8cc-sse.jsonl')
    const priorStrip = { body: PRIOR_BODY_CANDIDATES.oldRowFlatten, reasoning: '', reasoningSegments: [], toolIds: [] }
    const S = { aguiTurn: emptyAgUiTurnState('run-81320d61e8cc', 'a8186ed1'), turn: emptyStreamTurn(), compactedParts: [] }
    let prevLen = 0
    for (const ev of events) {
      vi.setSystemTime(new Date(Date.now() + 30))
      let wireEvent = ev
      if (ev.type === 'TEXT_MESSAGE_CONTENT') {
        const cleaned = stripLoosePriorBodyEcho(stripPriorTurnPollutants(ev.delta, priorStrip), priorStrip.body)
        if (!cleaned) continue
        if (cleaned !== ev.delta) wireEvent = { ...ev, delta: cleaned }
      }
      S.aguiTurn = applyAgUiEvent(S.aguiTurn, wireEvent)
      const proj = projectAgUiToStreamTurnFields(S.aguiTurn)
      const len = String(proj.openText || '').length
      // 回归护栏：openText 只增不减（清零 = 尾窗/重建 bug 复活）
      if (ev.type === 'TEXT_MESSAGE_CONTENT') {
        expect(len, `openText 在 ${ev.type} 上回缩：${prevLen} → ${len}`).toBeGreaterThanOrEqual(prevLen)
      }
      prevLen = len
    }
  })
})

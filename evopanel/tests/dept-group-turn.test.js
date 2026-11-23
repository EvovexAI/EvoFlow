import { describe, expect, it } from 'vitest'
import {
  buildDeptGroupTurnUserText,
  extractDeptGroupVisibleUserText,
  looksLikeDeptGroupTurnUserText,
  sanitizeDeptGroupTextForRecentContext,
} from '../src/react/lib/dept-group-turn.ts'
import { buildRecentGroupContext } from '../src/react/lib/dept-group-context.ts'

describe('buildDeptGroupTurnUserText', () => {
  it('包一层 turn，分层 hint / recent / instruction', () => {
    const out = buildDeptGroupTurnUserText({
      instruction: '把进度说一下',
      stewardMode: false,
      recent: '用户：在吗\n小V：在',
      hints: [{ kind: 'behavior', text: '把该你说的说完' }],
    })
    expect(out).toContain('<dept_group_turn version="1">')
    expect(out).toContain('<dept_group_hint kind="behavior">')
    expect(out).toContain('<dept_group_recent trim="full">')
    expect(out).toContain('<dept_group_instruction steward="0">')
    expect(out).toContain('把进度说一下')
    expect(out).toContain('用户：在吗')
  })
})

describe('extractDeptGroupVisibleUserText', () => {
  it('只露出 instruction 正文，不露标签与 hint/recent', () => {
    const raw = buildDeptGroupTurnUserText({
      instruction: '群里有谁',
      stewardMode: true,
      recent: '用户：哈喽\n小V：收到',
      hints: [{ kind: 'steward', text: '请以群管家接住' }],
    })
    const visible = extractDeptGroupVisibleUserText(raw)
    expect(visible).toBe('群里有谁')
    expect(visible).not.toContain('dept_group')
    expect(visible).not.toContain('哈喽')
    expect(visible).not.toContain('群管家')
  })

  it('兼容旧版【群近期】/【本条消息】', () => {
    const legacy =
      '（群聊提示：把该你说的说完即可。）\n\n【群近期】\n用户：hi\n\n【本条消息】\n请汇报'
    expect(extractDeptGroupVisibleUserText(legacy)).toBe('请汇报')
  })

  it('普通用户消息原样返回', () => {
    expect(extractDeptGroupVisibleUserText('普通一句话')).toBe('普通一句话')
  })
})

describe('sanitize + recent context', () => {
  it('群近期只带用户 instruction，不带脚手架', () => {
    const injected = buildDeptGroupTurnUserText({
      instruction: '最新指令',
      recent: '不该回灌的旧脚手架',
      hints: [{ kind: 'behavior', text: '内部提示' }],
    })
    const out = buildRecentGroupContext([
      { kind: 'user', text: injected },
      { kind: 'agent', agentName: '研发', text: '收到' },
    ])
    expect(out).toContain('用户：最新指令')
    expect(out).toContain('研发：收到')
    expect(out).not.toContain('内部提示')
    expect(out).not.toContain('不该回灌')
    expect(out).not.toContain('dept_group')
  })

  it('sanitizeDeptGroupTextForRecentContext 对 user 走 extract', () => {
    expect(
      sanitizeDeptGroupTextForRecentContext(
        'user',
        '<dept_group_instruction>可见</dept_group_instruction>',
      ),
    ).toBe('可见')
  })
})

describe('looksLikeDeptGroupTurnUserText', () => {
  it('识别新旧格式', () => {
    expect(looksLikeDeptGroupTurnUserText('<dept_group_turn>x</dept_group_turn>')).toBe(true)
    expect(looksLikeDeptGroupTurnUserText('【本条消息】\nok')).toBe(true)
    expect(looksLikeDeptGroupTurnUserText('普通')).toBe(false)
  })
})

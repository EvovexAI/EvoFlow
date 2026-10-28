import { describe, expect, it } from 'vitest'
import {
  isComputerUseToolWireName,
  nodeReplArgsTouchComputerUse,
  NODE_REPL_COMPUTER_USE_INTENT_RE,
} from '../src/lib/cua-glow-agui.js'

describe('nodeReplArgsTouchComputerUse', () => {
  it('detects agent.computerUse in code', () => {
    expect(
      nodeReplArgsTouchComputerUse(
        JSON.stringify({
          title: '打开记事本',
          code: 'const app = await agent.computerUse.getApp("Notepad"); await app.focus()',
        }),
      ),
    ).toBe(true)
  })

  it('detects computer-use-bridge symbol', () => {
    expect(
      nodeReplArgsTouchComputerUse(
        'globalThis[Symbol.for("zcode.node-repl.computer-use-bridge")]',
      ),
    ).toBe(true)
  })

  it('ignores browser-only cells', () => {
    expect(
      nodeReplArgsTouchComputerUse(
        JSON.stringify({
          title: '打开网页',
          code: 'const browser = await agent.browsers.getForUrl("https://example.com")',
        }),
      ),
    ).toBe(false)
  })

  it('regex is exported for reuse', () => {
    expect(NODE_REPL_COMPUTER_USE_INTENT_RE.test('computerUse.computer.screenshot()')).toBe(true)
  })
})

describe('isComputerUseToolWireName', () => {
  it('accepts node_repl and computer_use MCP names', () => {
    expect(isComputerUseToolWireName('mcp__node_repl__js')).toBe(true)
    expect(isComputerUseToolWireName('mcp__computer_use__screenshot')).toBe(true)
    expect(isComputerUseToolWireName('browser_click')).toBe(false)
  })
})

/**
 * 用户停对话时必须收回电脑控制 UI（revoke + hide），不能只掐 LangGraph。
 * 否则画完图 / 停对话后蓝光和自定义光标还挂着，像「AI 还在控电脑」。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const STOP_SRC = path.resolve(
  __dirname,
  '../src/react/lib/session-execution/stop-session.ts',
)
const WS_SRC = path.resolve(
  __dirname,
  '../src/react/chat-app/stream/create-chat-ws-on-event.ts',
)

describe('停对话 / 回合结束 → 收回电脑控制', () => {
  it('stopSessionExecution 会 revoke + hide overlay', () => {
    const body = stripComments(fs.readFileSync(STOP_SRC, 'utf8'))
    expect(body).toContain('/cua/control/revoke')
    expect(body).toContain('hideCuaGlowOverlayForced')
    expect(body).toContain('clearCuaGlowStatusRemote')
    expect(body).toContain("reason: 'user_stop'")
  })

  it('只在 RUN_ERROR 清顶栏；RUN_FINISHED 不清（中间会闪灭）', () => {
    const raw = fs.readFileSync(WS_SRC, 'utf8')
    const idx = raw.indexOf("aguiEvent.type === 'RUN_FINISHED' || aguiEvent.type === 'RUN_ERROR'")
    expect(idx, '找不到 RUN_FINISHED/RUN_ERROR 分支').toBeGreaterThan(-1)
    const slice = stripComments(raw.slice(idx, idx + 900))
    // 必须仍是「仅 ERROR 收起」——工具循环中间的 RUN_FINISHED 不能 clear
    expect(slice).toMatch(/if\s*\(\s*aguiEvent\.type\s*===\s*['"]RUN_ERROR['"]\s*\)/)
    const errorOnly = slice.slice(slice.search(/aguiEvent\.type\s*===\s*['"]RUN_ERROR['"]/))
    expect(errorOnly).toContain('hideCuaGlowOverlayForced')
    expect(errorOnly).toContain('clearCuaGlowStatusRemote')
  })
})

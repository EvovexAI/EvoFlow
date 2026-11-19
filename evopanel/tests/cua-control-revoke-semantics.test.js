/**
 * 「解除控制」按钮只收电脑操作权，不许再停 AI 回合。
 *
 * 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
 * 用户原话纠正：「这个停止只是停止电脑控制，并不是停止AI啊。
 *   只是电脑控制这个插件，当前是取消电脑控制了」
 *
 * 上一轮我把这个按钮接到了 `stopSessionExecution` —— 那是掐整个 LangGraph run。
 * 这条测试就是为了让那个错法再也回不来。
 *
 * 为什么必须**先剥注释**再断言（本轮踩过的坑）：
 *   修复后的代码里有一行注释写着「不能调 stopSessionExecution」。
 *   天真写法 `expect(src).not.toContain('stopSessionExecution')` 会因为这句注释
 *   直接失败，而 `expect(src).toContain('control/revoke')` 也会被注释里的字样骗过。
 *   判据只在**可执行代码**上成立，注释既不能算实现，也不能算违规。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC_PATH = path.resolve(
  __dirname,
  '../src/react/chat-app/shell/install-chat-mount-bootstrap.ts',
)

/** 剥掉 // 行注释与 /* *\/ 块注释，只留可执行代码。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 只取 cua-glow-user-stop 监听器那一段，避免被文件其它部分干扰。 */
function cuaStopListenerCode() {
  const code = stripComments(fs.readFileSync(SRC_PATH, 'utf8'))
  const start = code.indexOf("listen('cua-glow-user-stop'")
  expect(start, '找不到 cua-glow-user-stop 监听器 —— 测试前提不成立').toBeGreaterThan(-1)
  // 监听器到 detachCuaStop 赋值结束
  const end = code.indexOf('detachCuaStop = () =>', start)
  return code.slice(start, end > 0 ? end : start + 3000)
}

describe('「解除控制」按钮的语义', () => {
  it('必须调 /cua/control/revoke 收回电脑操作权', () => {
    expect(cuaStopListenerCode()).toContain('/cua/control/revoke')
  })

  it('不许再调 stopSessionExecution（那是掐整个 AI 回合）', () => {
    const body = cuaStopListenerCode()
    expect(body).not.toContain('stopSessionExecution')
    expect(body).not.toContain('chatAbort')
  })

  it('剥注释这一步本身有效（否则下面的断言都是在骗自己）', () => {
    const raw = fs.readFileSync(SRC_PATH, 'utf8')
    const stripped = stripComments(raw)
    // 原文（含注释）里出现 stopSessionExecution —— 那是修复说明文字，
    // 不剥注释的话「不许调」这条断言会因为这句话而假红。
    expect(raw).toContain('stopSessionExecution')
    // 剥完后监听器段里不能再有裸的停止调用 —— 这才是真正要锁的。
    expect(cuaStopListenerCode()).not.toContain('stopSessionExecution')
    // 剥注释确实删掉了东西（不是空跑一趟）
    expect(stripped.length).toBeLessThan(raw.length)
  })
})

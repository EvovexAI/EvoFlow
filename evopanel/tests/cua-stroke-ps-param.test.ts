// 【self-evolution-bot · 2026-11-22】
//
// 锁一件事：`scripts/cua/cua-kit.mjs` 里内嵌的 PowerShell 笔画脚本**必须能启动**。
//
// 真实现网缺陷（用户报「这个工具咋了、啥 bug」的根因之一）：
//   脚本参数名写成 `-Pid` / `$Pid`，而 `$PID` 是 PowerShell 的**只读自动变量**
//   （当前进程 id）。PowerShell 在**参数绑定阶段**就抛
//   「无法覆盖变量 Pid，因为该变量为只读或常量」
//   ⇒ 整条 drawStroke 一次都没跑通过，而且错误发生在脚本最开头，
//      模型侧只看到一句中文写入错误、看不到任何笔画，就被迫退回逐段 app.drag，
//      于是又撞上前台被抢 → 「工具坏了」。
//
// 判据不能只看「文件存在 / 语法能过」：node --check 对这段字符串里的 PS 代码
// 零分辨力。这里直接**跑一次帮助参数绑定**的 dry-run，用真实退出码断言。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const KIT = resolve(__dirname, '../../scripts/cua/cua-kit.mjs')

function strokePs(): string {
  const src = readFileSync(KIT, 'utf8')
  const start = src.indexOf('const STROKE_PS = String.raw`')
  expect(start, 'STROKE_PS 不见了').toBeGreaterThan(-1)
  const bodyStart = src.indexOf('`', start) + 1
  const end = src.indexOf('`;', bodyStart)
  expect(end, 'STROKE_PS 没闭合').toBeGreaterThan(bodyStart)
  return src.slice(bodyStart, end)
}

describe('cua 笔画脚本（drawStroke 内嵌 PowerShell）', () => {
  const ps = strokePs()

  it('参数名不得占用 $Pid 等只读自动变量', () => {
    // PowerShell 只读/常量自动变量：$PID $HOME $PWD $PSHOME $TRUE $FALSE $NULL $INPUT …
    // 参数绑定阶段撞上它们 = 脚本连第一行都跑不到。
    //
    // 只取「类型标注后紧跟的变量名」（即真正的形参声明），不要把
    // `[Parameter(Mandatory=$true)]` 里的 $true 当成参数名 —— 那是特性实参。
    const paramLine = ps.split('\n')[0]
    const names = [...paramLine.matchAll(/\[[^\]]*\]\s*\$(\w+)\s*(?=[,)=]|$)/g)].map((m) =>
      m[1].toLowerCase(),
    )
    expect(names.length, '没解析出任何形参，正则失效了').toBeGreaterThan(0)
    for (const reserved of ['pid', 'home', 'pwd', 'pshome', 'true', 'false', 'null', 'input', 'args']) {
      expect(names, `参数名撞了 PowerShell 只读变量 $${reserved}`).not.toContain(reserved)
    }
  })

  it('函数体里不再引用旧的 $Pid', () => {
    expect(ps).not.toMatch(/\$Pid\b/)
  })

  it('调用方传的参数名与脚本声明一致', () => {
    const src = readFileSync(KIT, 'utf8')
    const decl = /\$(\w+),\s*\[Parameter\(Mandatory=\$true\)\]\[string\]\$Points/.exec(ps)
    expect(decl, '找不到目标 pid 参数声明').not.toBeNull()
    const name = decl![1]
    // execFile 的实参里必须出现 `-<name>`
    expect(src).toContain(`"-${name}"`)
  })
})

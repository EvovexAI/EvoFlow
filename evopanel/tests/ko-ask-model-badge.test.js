import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// vitest 的 root 即 evopanel/，import.meta.url 在转换后不是 file scheme
const ROOT = process.cwd()
const JSX = readFileSync(join(ROOT, 'src/pages/knowledge-owned.jsx'), 'utf8')
const CSS = readFileSync(join(ROOT, 'src/pages/knowledge-owned.css'), 'utf8')

describe('问AI 面板:默认模型徽章不复用装饰圆点样式', () => {
  it('effectiveChatModel 徽章不使用 ko-ask__scope-dot(6×6 圆点装不下文本)', () => {
    // 回归:曾经 <span className="ko-ask__scope-dot">{effectiveChatModel}</span>,
    // 文本被压进 6px 圆点导致样式错乱
    const badge = JSX.match(/<span\s+className="([^"]*)"[^>]*>\s*\{effectiveChatModel\}/)
    expect(badge, '应找到 effectiveChatModel 徽章').toBeTruthy()
    expect(badge[1]).not.toBe('ko-ask__scope-dot')
  })

  it('ko-ask__scope-dot 仍只用于 aria-hidden 装饰圆点', () => {
    const dots = JSX.match(/className="ko-ask__scope-dot"/g) || []
    const decorative = JSX.match(/className="ko-ask__scope-dot"\s+aria-hidden="true"/g) || []
    expect(dots.length).toBe(decorative.length)
  })

  it('徽章有配套文本样式(可容纳模型名,无固定 6px 尺寸)', () => {
    const m = CSS.match(/\.ko-ask__scope-model\s*\{([^}]*)\}/)
    expect(m, 'knowledge-owned.css 应定义 .ko-ask__scope-model').toBeTruthy()
    expect(m[1]).not.toMatch(/width:\s*6px/)
    expect(m[1]).not.toMatch(/height:\s*6px/)
  })

  it('模型下拉在工具栏铺满剩余宽度(flex 填充,不挤压范围簇)', () => {
    // 回归1:field 变体 width:100% 把「整个知识库」挤换行 → 必须用 flex-basis 0
    // 回归2:compact-filter 148px 截断模型名 → 改为铺满
    const m = CSS.match(/\.ko-ask__toolbar > \.ef-dropdown-select\s*\{([^}]*)\}/)
    expect(m, '工具栏应有下拉填充规则').toBeTruthy()
    expect(m[1]).toMatch(/flex:\s*1\s+1\s+0/)
    expect(m[1]).toMatch(/min-width/)
  })
})

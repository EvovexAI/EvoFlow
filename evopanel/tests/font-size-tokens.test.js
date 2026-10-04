import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeFontScale } from '../src/lib/font-size.js'

// vitest 的 root 即 evopanel/，import.meta.url 在转换后不是 file scheme
const ROOT = process.cwd()
const VARS = readFileSync(join(ROOT, 'src/style/variables.css'), 'utf8')
const FONT_JS = readFileSync(join(ROOT, 'src/lib/font-size.js'), 'utf8')

describe('字号刻度：--ef-text-* 挂在用户缩放上', () => {
  it('fontScale 越界被夹紧', () => {
    expect(normalizeFontScale(0.1)).toBe(0.75)
    expect(normalizeFontScale(99)).toBe(1.5)
    expect(normalizeFontScale(NaN)).toBe(0.9)
  })

  it('applyFontSizePreference 同时写入新刻度基座', () => {
    // 新刻度有 1200+ 处引用，若不写 --ef-font-size，用户调滑块对它们无效
    expect(FONT_JS).toMatch(/setProperty\(\s*'--ef-font-size'/)
  })

  it('--ef-font-size 保持字面量，不指向 --ef-text-base', () => {
    // --ef-text-base 本身是 var(--ef-font-size)，回指会形成循环引用
    const decl = VARS.match(/--ef-font-size\s*:\s*([^;]+);/)?.[1]?.trim() ?? ''
    expect(decl).not.toMatch(/var\(/)
    expect(decl).toMatch(/^\d+(\.\d+)?px$/)
  })

  it('--ef-text-* 全部由 --ef-font-size 派生', () => {
    const derived = ['2xs', 'xs', 'sm', 'lg', 'xl']
    for (const step of derived) {
      const decl = VARS.match(new RegExp(`--ef-text-${step}\\s*:\\s*([^;]+);`))?.[1] ?? ''
      expect(decl, `--ef-text-${step} 应派生自 --ef-font-size`).toContain('var(--ef-font-size)')
    }
    // base 是恒等引用，同样由基座决定
    expect(VARS).toMatch(/--ef-text-base\s*:\s*var\(--ef-font-size\)/)
  })
})

describe('字号令牌守卫脚本', () => {
  it('check-font-size-tokens.mjs 存在且不把 variables.css 计入违规', () => {
    const script = readFileSync(join(ROOT, 'scripts/check-font-size-tokens.mjs'), 'utf8')
    expect(script).toContain('variables.css')
  })
})

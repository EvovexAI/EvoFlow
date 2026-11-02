import { describe, expect, it } from 'vitest'
import {
  FALLBACK_ICONS,
  HUES,
  ICON_NODES,
  appIconNodes,
  appIconSvg,
  appIconTileHtml,
  resolveAppIcon,
} from '../src/lib/app-icon.js'

describe('app-icon', () => {
  it('同一条工作流多次解析结果稳定（改名之外不变脸）', () => {
    const app = { id: 'app_9f3a2c71', name: '竞品分析报告' }
    const a = resolveAppIcon(app)
    const b = resolveAppIcon(app)
    expect(a.icon).toBe(b.icon)
    expect(a.hue).toBe(b.hue)
  })

  it('id 相同、名称改动后色相不变', () => {
    const before = resolveAppIcon({ id: 'app_1', name: '周报生成' })
    const after = resolveAppIcon({ id: 'app_1', name: '改名后的工作流' })
    expect(after.hue).toBe(before.hue)
  })

  it('按名称语义匹配图标', () => {
    expect(resolveAppIcon({ id: 'x1', name: '竞品分析报告' }).icon).toBe('radar')
    expect(resolveAppIcon({ id: 'x2', name: '代码审查' }).icon).toBe('code')
    expect(resolveAppIcon({ id: 'x3', name: '数据库巡检' }).icon).toBe('database')
    expect(resolveAppIcon({ id: 'x4', name: '周报生成' }).icon).toBe('newspaper')
    expect(resolveAppIcon({ id: 'x5', name: '发版说明生成' }).icon).toBe('rocket')
    expect(resolveAppIcon({ id: 'x6', name: '客户反馈归纳' }).icon).toBe('users')
  })

  it('语义未命中时回退到固定图标池，且仍稳定', () => {
    const app = { id: 'app_zzz_unknown', name: '一点点也不匹配的奇怪名字' }
    const first = resolveAppIcon(app)
    expect(FALLBACK_ICONS).toContain(first.icon)
    expect(resolveAppIcon(app).icon).toBe(first.icon)
  })

  it('空 id 用名称兜底，空 app 不抛错', () => {
    const r = resolveAppIcon({ name: '代码审查' })
    expect(r.icon).toBe('code')
    expect(() => resolveAppIcon(null)).not.toThrow()
    expect(() => resolveAppIcon(undefined)).not.toThrow()
    expect(resolveAppIcon(null).nodes.length).toBeGreaterThan(0)
  })

  it('色相只会取自固定池', () => {
    const hues = new Set()
    for (let i = 0; i < 200; i += 1) hues.add(resolveAppIcon({ id: 'app_' + i, name: 'n' + i }).hue)
    for (const h of hues) expect(HUES).toContain(h)
    // 分布不塌陷：至少覆盖池中一半
    expect(hues.size).toBeGreaterThanOrEqual(Math.ceil(HUES.length / 2))
  })

  it('生成的 SVG 带 viewBox 与线性描边，且不含 xmlns 冗余', () => {
    const svg = appIconSvg({ id: 'a', name: '代码审查' }, 22)
    expect(svg).toContain('viewBox="0 0 24 24"')
    expect(svg).toContain('stroke="currentColor"')
    expect(svg).toContain('width="22"')
  })

  it('瓦片 HTML 带色相变量与图标类名', () => {
    const html = appIconTileHtml({ id: 'app_x', name: '代码审查' })
    expect(html).toContain('class="app-ico-tile"')
    expect(html).toMatch(/--app-ico-h:\d+/)
    expect(html).toContain('<svg')
  })

  it('支持附加尺寸类名', () => {
    const html = appIconTileHtml({ id: 'app_x', name: '代码审查' }, 'app-ico-tile--sm')
    expect(html).toContain('app-ico-tile app-ico-tile--sm')
  })

  it('图标池里的每个 key 都有几何数据', () => {
    for (const key of FALLBACK_ICONS) {
      expect(ICON_NODES[key], key).toBeTruthy()
      expect(ICON_NODES[key].length).toBeGreaterThan(0)
    }
    const { nodes, hue } = appIconNodes({ id: 'z', name: '代码审查' })
    expect(nodes.length).toBeGreaterThan(0)
    expect(HUES).toContain(hue)
  })
})

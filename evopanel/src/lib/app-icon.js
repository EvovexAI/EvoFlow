/**
 * 工作流图标：几何路径 + 语义/色相解析。
 *
 * 为什么不直接渲染 lucide-react 组件：
 *  1) 工作流列表页（pages/apps.js）与填参运行页是原生 DOM，不在 React 树里；
 *  2) 用 react-dom/server 把组件转字符串，实测会把 62KB(gzip) 打进主包；
 *  3) 这里内置的路径取自 lucide-react@1.18.0 同名图标（ISC），
 *     几何一致，视觉上与侧栏/工具栏是同一套线性语言。
 *
 * 图标优先按工作流名称语义匹配；未命中时用 app id 稳定哈希兜底，
 * 保证同一条工作流永远同一图标、同一色相（改名 / 重装 / 换机器都不变脸）。
 */

/** 图标几何：lucide-react@1.18.0 同名图标的 __iconNode 数据（ISC 许可）。 */
const ICON_NODES = {
  radar: [
    ["path", { d: "M19.07 4.93A10 10 0 0 0 6.99 3.34" }],
    ["path", { d: "M4 6h.01" }],
    ["path", { d: "M2.29 9.62A10 10 0 1 0 21.31 8.35" }],
    ["path", { d: "M16.24 7.76A6 6 0 1 0 8.23 16.67" }],
    ["path", { d: "M12 18h.01" }],
    ["path", { d: "M17.99 11.66A6 6 0 0 1 15.77 16.67" }],
    ["circle", { cx: "12", cy: "12", r: "2" }],
    ["path", { d: "m13.41 10.59 5.66-5.66" }],
  ],
  code: [
    ["path", { d: "m16 18 6-6-6-6" }],
    ["path", { d: "m8 6-6 6 6 6" }],
  ],
  newspaper: [
    ["path", { d: "M15 18h-5" }],
    ["path", { d: "M18 14h-8" }],
    ["path", { d: "M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2" }],
    ["rect", { width: "8", height: "4", x: "10", y: "6", rx: "1" }],
  ],
  database: [
    ["ellipse", { cx: "12", cy: "5", rx: "9", ry: "3" }],
    ["path", { d: "M3 5V19A9 3 0 0 0 21 19V5" }],
    ["path", { d: "M3 12A9 3 0 0 0 21 12" }],
  ],
  users: [
    ["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }],
    ["path", { d: "M16 3.128a4 4 0 0 1 0 7.744" }],
    ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87" }],
    ["circle", { cx: "9", cy: "7", r: "4" }],
  ],
  rocket: [
    ["path", { d: "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" }],
    ["path", { d: "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09" }],
    ["path", { d: "M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z" }],
    ["path", { d: "M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05" }],
  ],
  megaphone: [
    ["path", { d: "M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" }],
    ["path", { d: "M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14" }],
    ["path", { d: "M8 6v8" }],
  ],
  chartColumn: [
    ["path", { d: "M3 3v16a2 2 0 0 0 2 2h16" }],
    ["path", { d: "M18 17V9" }],
    ["path", { d: "M13 17V5" }],
    ["path", { d: "M8 17v-3" }],
  ],
  fileText: [
    ["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
    ["path", { d: "M10 9H8" }],
    ["path", { d: "M16 13H8" }],
    ["path", { d: "M16 17H8" }],
  ],
  flaskConical: [
    ["path", { d: "M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2" }],
    ["path", { d: "M6.453 15h11.094" }],
    ["path", { d: "M8.5 2h7" }],
  ],
  package: [
    ["path", { d: "M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" }],
    ["path", { d: "M12 22V12" }],
    ["polyline", { points: "3.29 7 12 12 20.71 7" }],
    ["path", { d: "m7.5 4.27 9 5.15" }],
  ],
  folderTree: [
    ["path", { d: "M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z" }],
    ["path", { d: "M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z" }],
    ["path", { d: "M3 5a2 2 0 0 0 2 2h3" }],
    ["path", { d: "M3 3v13a2 2 0 0 0 2 2h3" }],
  ],
  workflow: [
    ["rect", { width: "8", height: "8", x: "3", y: "3", rx: "2" }],
    ["path", { d: "M7 11v4a2 2 0 0 0 2 2h4" }],
    ["rect", { width: "8", height: "8", x: "13", y: "13", rx: "2" }],
  ],
  shieldCheck: [
    ["path", { d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" }],
    ["path", { d: "m9 12 2 2 4-4" }],
  ],
  search: [
    ["path", { d: "m21 21-4.34-4.34" }],
    ["circle", { cx: "11", cy: "11", r: "8" }],
  ],
  compass: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" }],
  ],
  settings2: [
    ["path", { d: "M14 17H5" }],
    ["path", { d: "M19 7h-9" }],
    ["circle", { cx: "17", cy: "17", r: "3" }],
    ["circle", { cx: "7", cy: "7", r: "3" }],
  ],
  wrench: [
    ["path", { d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" }],
  ],
  sparkles: [
    ["path", { d: "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" }],
    ["path", { d: "M20 2v4" }],
    ["path", { d: "M22 4h-4" }],
    ["circle", { cx: "4", cy: "20", r: "2" }],
  ],
}

/** 语义规则：命中即用，顺序敏感（更具体的放前面）。 */
const NAME_RULES = [
  [/竞品|调研|分析|research|analy/i, 'radar'],
  [/代码|审查|review|refactor|lint/i, 'code'],
  [/数据库|巡检|迁移|备份|schema|sql/i, 'database'],
  [/客服|客户|用户|反馈|舆情|人群/i, 'users'],
  [/发布|发版|上线|部署|release|deploy/i, 'rocket'],
  [/营销|推广|投放|增长|marketing|ads/i, 'megaphone'],
  [/安全|合规|审计|风控|security|audit/i, 'shieldCheck'],
  [/周报|日报|月报|简报|报告|news|digest/i, 'newspaper'],
  [/报表|指标|看板|图表|chart|metric/i, 'chartColumn'],
  [/文档|写作|文案|doc|write/i, 'fileText'],
  [/实验|测试|验证|experiment|test/i, 'flaskConical'],
  [/整理|归类|归档|清理|organize/i, 'folderTree'],
  [/安装|打包|构建|依赖|package|build/i, 'package'],
  [/检索|搜索|查找|search/i, 'search'],
  [/规划|方案|策略|plan|strategy/i, 'compass'],
  [/配置|设置|参数|config|setting/i, 'settings2'],
  [/修复|维护|排查|fix|maintain/i, 'wrench'],
  [/生成|创作|灵感|generate|create/i, 'sparkles'],
]

/** 兜底图标池：顺序固定，保证同 id 同结果。 */
const FALLBACK_ICONS = [
  'workflow',
  'sparkles',
  'chartColumn',
  'compass',
  'package',
  'folderTree',
  'search',
  'settings2',
]

/** 色相池：品牌紫为主线，其余为低饱和邻近色，不用高饱和彩虹。 */
const HUES = [258, 210, 174, 32, 340, 195]

/** djb2：稳定、无符号、够短。 */
function hashSeed(seed) {
  const s = String(seed ?? '')
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h >>> 0
}

/**
 * 解析工作流图标。
 * @param {{id?: string, name?: string}|null|undefined} app
 * @returns {{icon: string, hue: number, nodes: Array}}
 */
export function resolveAppIcon(app) {
  const name = String(app?.name ?? '')
  const seed = String(app?.id ?? '') || name || 'workflow'
  const h = hashSeed(seed)

  let icon = ''
  for (const [re, key] of NAME_RULES) {
    if (re.test(name)) {
      icon = key
      break
    }
  }
  if (!icon) icon = FALLBACK_ICONS[h % FALLBACK_ICONS.length]

  return {
    icon,
    hue: HUES[h % HUES.length],
    nodes: ICON_NODES[icon] || ICON_NODES.workflow,
  }
}

/** 由图标节点拼 SVG 字符串。 */
function svgFromNodes(nodes, size, strokeWidth = 1.85) {
  const body = nodes
    .map(([tag, attrs]) => {
      const a = Object.keys(attrs)
        .map((k) => k + '="' + attrs[k] + '"')
        .join(' ')
      return '<' + tag + ' ' + a + ' />'
    })
    .join('')
  return (
    '<svg class="app-ico" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="' + strokeWidth + '" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' + body + '</svg>'
  )
}

/** 按图标 key 直接取 SVG（菜单项 / 空态等固定位置用）。 */
export function appGlyphSvg(iconKey, size = 18) {
  const nodes = ICON_NODES[iconKey] || ICON_NODES.workflow
  return svgFromNodes(nodes, size)
}

/** 生成可直接 innerHTML 的 SVG 字符串（原生 DOM 用）。 */
export function appIconSvg(app, size = 22) {
  const { nodes } = resolveAppIcon(app)
  return svgFromNodes(nodes, size)
}

/** 生成 C1 瓦片 HTML（原生 DOM 用）：浅底 + 内描边 + 线性图标。 */
export function appIconTileHtml(app, extraClass = '') {
  const { hue } = resolveAppIcon(app)
  const cls = extraClass ? ' ' + extraClass : ''
  return (
    '<span class="app-ico-tile' + cls + '" style="--app-ico-h:' + hue + '">' +
    appIconSvg(app) + '</span>'
  )
}

/** React 侧取节点与色相。 */
export function appIconNodes(app) {
  const { nodes, hue } = resolveAppIcon(app)
  return { nodes, hue }
}

export { ICON_NODES, HUES, FALLBACK_ICONS }

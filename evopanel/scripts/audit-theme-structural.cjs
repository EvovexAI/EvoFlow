// 过滤：只留「结构性容器」（面板/卡片/弹窗/表格/输入框）写死浅色底且无深色覆盖
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..', 'src')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.css')) out.push(p)
  }
  return out
}
function parseRules(css) {
  const rules = []
  let i = 0, buf = []
  const ctx = []
  while (i < css.length) {
    const c = css[i]
    if (c === '{') {
      const sel = buf.join('').trim(); buf.length = 0
      let depth = 1, j = i + 1
      const bodyStart = j
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++
        else if (css[j] === '}') depth--
        j++
      }
      const body = css.slice(bodyStart, j - 1)
      if (sel.startsWith('@')) { ctx.push(sel); rules.push({ at: true, sel, body, ctx: ctx.slice() }) }
      else rules.push({ at: false, sel, body, ctx: ctx.slice() })
      i = j; continue
    }
    buf.push(c); i++
  }
  return rules
}

// 结构性容器关键词
const STRUCT = /(panel|card|modal|dialog|drawer|sheet|table|tr\b|td\b|th\b|input|textarea|field|body|wrap|container|surface|toolbar|header|sidebar|list|row|grid|box|popover|menu|popover)/i
// 明显是「状态色/装饰」的排除
const STATUS = /(dot|badge|tag|chip|avatar|icon|indicator|ring|line|divider|bullet|bar-fill|status|spinner|logo|swatch)/i
// 明显是独立暗色舞台的文件
const DARK_STAGE = /(ai-roundtable|xiaomi-voice-stage|code-viewer|zcode-ui\/styles)/i

const out = []
for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  if (DARK_STAGE.test(rel)) continue
  const css = fs.readFileSync(f, 'utf8')
  const rules = parseRules(css)
  const darkClasses = new Set()
  for (const r of rules) {
    if (!r.at && /data-theme=['"]dark['"]|html\.dark|\.dark\s/.test(r.sel)) {
      for (const m of r.sel.matchAll(/\.([A-Za-z0-9_-]+)/g)) darkClasses.add(m[1])
    }
  }
  for (const r of rules) {
    if (r.at) continue
    if (/data-theme=['"]dark['"]/.test(r.sel)) continue
    const m = r.body.match(/background:\s*(#[0-9a-fA-F]{3,8})\b/)
    if (!m) continue
    const hex = m[1]
    // 只关心浅色底：亮度 >= 0.75
    let rr = parseInt(hex.slice(1, 3), 16), gg = parseInt(hex.slice(3, 5), 16), bb = parseInt(hex.slice(5, 7), 16)
    const lum = (0.299 * rr + 0.587 * gg + 0.114 * bb) / 255
    if (lum < 0.75) continue
    if (/background:[^;]*var\(--/.test(r.body)) continue
    const classes = [...r.sel.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(x => x[1])
    if (!classes.length) continue
    if (classes.every(c => STATUS.test(c))) continue
    if (!STRUCT.test(r.sel)) continue
    const hasDark = classes.some(c => darkClasses.has(c))
    if (hasDark) continue
    const line = css.slice(0, css.indexOf(r.sel)).split('\n').length
    out.push({ file: rel, line, sel: r.sel.replace(/\s+/g, ' ').slice(0, 100), hex, lum: lum.toFixed(2), body: r.body.replace(/\s+/g, ' ').slice(0, 100) })
  }
}
console.log('=== 结构性容器写死浅色底且无深色覆盖 (' + out.length + ') ===')
for (const x of out) console.log(`${x.file}:${x.line}  ${x.sel}\n    bg=${x.hex} lum=${x.lum}`)

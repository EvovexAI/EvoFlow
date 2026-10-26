// 扫描 CSS：找「写死浅色底」且没有对应深色覆盖的规则
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

// 粗解析：按 "}" 切分顶层块，保留嵌套 @media 上下文
function parseRules(css) {
  const rules = []
  let i = 0
  let ctx = []
  const buf = []
  while (i < css.length) {
    const c = css[i]
    if (c === '{') {
      const sel = buf.join('').trim()
      buf.length = 0
      // 找匹配 }
      let depth = 1
      let j = i + 1
      const bodyStart = j
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++
        else if (css[j] === '}') depth--
        j++
      }
      const body = css.slice(bodyStart, j - 1)
      if (sel.startsWith('@')) {
        ctx = ctx.concat([sel])
        rules.push({ at: true, sel, body, ctx: ctx.slice() })
      } else {
        rules.push({ at: false, sel, body, ctx: ctx.slice() })
      }
      i = j
      continue
    }
    buf.push(c)
    i++
  }
  return rules
}

const LIGHT_BG = [
  /background:\s*#fff\b/i,
  /background:\s*#ffffff\b/i,
  /background:\s*white\b/i,
  /background:\s*#f[0-9a-f]{2,5}\b/i,
  /background:\s*#e[0-9a-f]{2,5}\b/i,
]

const files = walk(ROOT)
const findings = []

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  const css = fs.readFileSync(f, 'utf8')
  const rules = parseRules(css)

  // 收集该文件里所有深色覆盖里出现过的类名
  const darkClasses = new Set()
  for (const r of rules) {
    if (!r.at && /data-theme=['"]dark['"]|\.dark\s|html\.dark/.test(r.sel)) {
      for (const m of r.sel.matchAll(/\.([A-Za-z0-9_-]+)/g)) darkClasses.add(m[1])
    }
  }

  for (const r of rules) {
    if (r.at) continue
    if (!LIGHT_BG.some(re => re.test(r.body))) continue
    if (/data-theme=['"]dark['"]/.test(r.sel)) continue
    // 该规则自身的选择器里的类
    const classes = [...r.sel.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(m => m[1])
    const hasDark = classes.some(c => darkClasses.has(c))
    // 已经用了 var(--token) 的优先（多行 background 声明里可能后面覆盖）
    const usesVar = /background:[^;]*var\(--/.test(r.body)
    if (usesVar) continue
    findings.push({ file: rel, line: css.slice(0, css.indexOf(r.sel)).split('\n').length, sel: r.sel.slice(0, 110), hasDark, body: r.body.replace(/\s+/g, ' ').slice(0, 120) })
  }
}

const unfixed = findings.filter(x => !x.hasDark)
console.log('=== 写死浅色底且无深色覆盖（' + unfixed.length + '） ===')
for (const x of unfixed) {
  console.log(`${x.file}:${x.line}  ${x.sel}\n    ${x.body}`)
}
console.log('\n=== 合计 findings:', findings.length, ' 无深色覆盖:', unfixed.length)

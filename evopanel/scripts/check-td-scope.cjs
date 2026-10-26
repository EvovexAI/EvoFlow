// 校验：所有使用 var(--td-*) 的规则，选择器是否都在 .task-detail-page 作用域内
const fs = require('fs')
const path = require('path')
const FILE = path.join(__dirname, '..', 'src', 'style', 'pages.css')
const css = fs.readFileSync(FILE, 'utf8')

// 找 .task-detail-page 作用域的起止（含嵌套 @media）
const lines = css.split('\n')
let scope = null
const bad = []
let inMedia = 0
lines.forEach((ln, i) => {
  if (/^\.task-detail-page\s*\{/.test(ln)) { scope = { start: i, depth: 0, inScope: true } }
  if (scope) {
    scope.depth += (ln.match(/\{/g) || []).length
    scope.depth -= (ln.match(/\}/g) || []).length
    if (scope.depth <= 0 && i > scope.start) scope = null
  }
  if (/var\(--td-/.test(ln)) {
    const inTd = scope !== null
    if (!inTd) bad.push({ line: i + 1, text: ln.trim().slice(0, 110) })
  }
})
console.log('=== 在 .task-detail-page 作用域外使用 --td-* 的行 (' + bad.length + ') ===')
bad.forEach(b => console.log(`  ${b.line}: ${b.text}`))

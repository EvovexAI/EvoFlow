/**
 * 作用域安全的 CSS 属性替换：只改「选择器命中给定前缀」的规则，
 * 且**逐字节保留原文件格式**（只做精确字符串替换）。
 *
 * 实现：先做一次只读的 brace 扫描，产出每个顶层/嵌套规则块的
 * [selStart, selEnd, bodyStart, bodyEnd]。扫描时维护一个栈，
 * 遇到 '{' 弹入当前选择器片段，遇到 '}' 弹栈。
 */
const fs = require('fs')
const path = require('path')

const [file, scope, mapFile] = process.argv.slice(2)
const MAP = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
const src = fs.readFileSync(file, 'utf8')

// 扫描：产出规则块
const blocks = []
const stack = [] // {selStart, selEnd}
let selStart = 0
let i = 0
while (i < src.length) {
  const ch = src[i]
  if (ch === '{') {
    const sel = src.slice(selStart, i)
    stack.push({ selStart, selEnd: i, sel })
    selStart = i + 1
    i++
    continue
  }
  if (ch === '}') {
    const top = stack.pop()
    if (top) {
      blocks.push({
        sel: top.sel,
        selStart: top.selStart,
        selEnd: top.selEnd,
        bodyStart: top.selEnd + 1,
        bodyEnd: i,
        depth: stack.length,
      })
    }
    // 块结束后，选择器从 '}' 之后重新开始
    selStart = i + 1
    i++
    continue
  }
  if (ch === ';') {
    // 声明结束（无花括号的 at-rule，如 @import）——选择器继续
    i++
    continue
  }
  i++
}

let changed = 0
const hits = []
for (const b of blocks) {
  const sel = b.sel.trim()
  if (!sel || sel.startsWith('@')) continue
  // 完整选择器链：把祖先块的选择器拼上
  const ancestors = blocks
    .filter(x => x.depth < b.depth && x.bodyEnd <= b.selStart && x.bodyEnd >= 0)
  // 用简单方式：判断本规则的选择器本身是否命中 scope
  const parts = sel.split(',').map(s => s.trim())
  const isHit = parts.some(p => p.startsWith(scope))
  if (!isHit) continue
  const body = src.slice(b.bodyStart, b.bodyEnd)
  let nb = body
  for (const [from, to] of Object.entries(MAP)) {
    if (nb.includes(from)) {
      const n = nb.split(from).length - 1
      changed += n
      nb = nb.split(from).join(to)
    }
  }
  if (nb !== body) hits.push({ start: b.bodyStart, end: b.bodyEnd, text: nb })
}
hits.sort((a, b) => b.start - a.start)
let out = src
for (const h of hits) out = out.slice(0, h.start) + h.text + out.slice(h.end)

fs.writeFileSync(file, out, 'utf8')
console.log(`[css-scope-replace] ${path.basename(file)} scope=${scope} blocks=${hits.length} replacements=${changed}`)

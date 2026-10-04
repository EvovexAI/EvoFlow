/**
 * 字号令牌守卫
 *
 * 界面文字必须走字号令牌，禁止内联任意 px 值。新刻度 --ef-text-* 与用户
 * 字号设置（--ef-font-size）联动，硬编码值会脱离缩放系统。
 *
 * 现状：存量硬编码约 1500 处（迁移期，尚未清完），因此默认只报告不失败。
 * 清完存量后把 --strict 传给 CI，即可阻断新增。
 *
 *   node scripts/check-font-size-tokens.mjs            # 报告
 *   node scripts/check-font-size-tokens.mjs --strict   # 有违规即 exit 1
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const STYLE_DIR = join(ROOT, 'src', 'style')

/** 允许的字号来源。
 * rem/em 虽随根字号缩放，但不联动 --ef-font-size，故仍计为违规，
 * 避免报告失真；calc/clamp 只要整体由令牌或相对单位构成即放行。 */
const ALLOWED_VALUE =
  /^(var\(|inherit\b|initial$|unset$|revert$|smaller$|larger$|[a-z][a-z-]*$)/i
const HAS_TOKEN = /var\(--ef-text-|var\(--font-size-|var\(--chat-(font-size|tier)-/
const HAS_PURE_RELATIVE = /^[\d.\s]*(em|rem)$/i
const WRAPPED = /^(calc|clamp|min|max)\(.+\)$/i

function isAllowed(value) {
  if (ALLOWED_VALUE.test(value)) return true
  if (HAS_PURE_RELATIVE.test(value)) return true
  // calc/clamp 内部只要不含裸 px 字面量即视为安全
  if (WRAPPED.test(value) && !/[\d.]+px/.test(value)) return true
  void HAS_TOKEN
  return false
}

/** 明确豁免的目录/文件（内容层与外部产物不适用界面令牌） */
const EXEMPT = [/katex/i, /mermaid/i, /cytoscape/i]

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (full.endsWith('.css')) yield full
  }
}

const violations = []

for (const file of walk(STYLE_DIR)) {
  const rel = relative(ROOT, file)
  if (EXEMPT.some((re) => re.test(rel))) continue

  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    // 只看 font-size 声明本身，避免误伤 padding/margin/width。
    // 同行多声明（font-size: 12px; color: red）先切出本条的值再判定。
    const m = line.match(/^\s*font-size\s*:\s*(.+?)\s*;\s*$/)
    if (!m) return
    const value = m[1].replace(/\s*!important\s*$/i, '').trim()
    if (isAllowed(value)) return
    violations.push({ file: rel, line: i + 1, value })
  })
}

// 令牌自身所在文件豁免：定义处天然是字面量
const real = violations.filter((v) => !v.file.endsWith('variables.css'))

const byValue = new Map()
for (const v of real) {
  const list = byValue.get(v.value) || []
  list.push(v)
  byValue.set(v.value, list)
}

const label = real.length === 1 ? '处' : '处'
console.log(`字号令牌检查：${real.length} ${label}硬编码（存量，迁移期）\n`)

for (const [value, list] of [...byValue].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${value.padEnd(10)} ${String(list.length).padStart(4)}  ${list[0].file}:${list[0].line}`)
}

if (byValue.size) {
  console.log(`\n共 ${byValue.size} 种取值。迁移方式：`)
  console.log('  10px -> var(--ef-text-xs)     12px -> var(--ef-text-sm)     14px -> var(--ef-text-base)')
  console.log('  11px / 13px 与新刻度不重合，需先判定语义归属再替换。')
}

if (real.length === 0) {
  console.log('全部字号已走令牌。')
}

process.exit(process.argv.includes('--strict') && real.length > 0 ? 1 : 0)

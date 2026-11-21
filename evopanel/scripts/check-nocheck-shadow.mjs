#!/usr/bin/env node
/**
 * 【self-evolution-bot · 2026-11-21 · 第111轮 · 模型:deepseek-v4.1-flash-1017】
 *
 * 改了什么：新增护栏，专查 `// @ts-nocheck` 屏蔽文件里**运行时必崩**的类型错误。
 *
 * 为什么：第111轮我改了 render-right-stage-body.tsx，误删 `const data = surface.data || {}`，
 *   第 84 行引用未定义变量。该文件头部有 `// @ts-nocheck`（P83 机械抽取遗留），tsc 对它
 *   完全免疫 —— `tsc --noEmit` 回 exit=0、零输出，我据此上报「门禁全过」，直到用户装包
 *   重启后现场报「工作流加载失败 data is not defined」才发现。
 *   反证：把该行删掉后 tsc 立刻报 `(84,18): error TS2304: Cannot find name 'data'`；
 *   加回去则同一错误消失。所以盲区确实来自 @ts-nocheck，不是 tsc 坏了。
 *
 * 关键实现坑（第111轮自撞，勿重犯）：
 *   不能直接 `tsc -p` 一个只 include 该文件的临时 tsconfig —— tsc 仍会读文件里的
 *   `@ts-nocheck` 从而照旧跳过，于是「删掉 data 也报 OK」，护栏成了摆设。
 *   实测：临时 tsconfig 指向该文件，tsc 只报别的文件的 ImportMeta 错，对被保护文件零诊断。
 *   正确做法：把文件复制到 .nocheck-shadow-<rand>/ 下，**删掉 @ts-nocheck 那一行**（行号
 *   不变，用空行占位），再让 tsc 编副本。副本必须同目录深度，好让相对 import 解析一致。
 *
 * 判据（只拦会造成运行时崩溃的，不拦类型收窄）：
 *   拦  TS2304 Cannot find name        —— 变量/函数根本没定义，运行必崩
 *   拦  TS2552 Cannot find name ... Did you mean
 *   拦  TS2448 / TS2454 used before its declaration / before being assigned —— TDZ 必崩
 *   放  TS2322/TS2740/TS2339/TS2739 等 —— props unknown 收窄，只是类型不精确
 *   放  TYPE_ONLY_NAMES 白名单 —— 只出现在类型注解位置的全局名（如没装 electron 类型）
 *
 * 用法：node scripts/check-nocheck-shadow.mjs [--json]
 * 退出码：0 = 干净；1 = 发现运行时必崩错误；2 = 无法判定（tsc 自身失败）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs'

const FATAL_CODES = new Set([
  'TS2304', // Cannot find name 'x'
  'TS2552', // Cannot find name 'x'. Did you mean 'y'?
  'TS2448', // Block-scoped variable used before its declaration
  'TS2454', // Variable used before being assigned
])

/**
 * 仅用于**类型位置**的全局名字缺失：tsconfig 没引 electron 类型定义，tsc 报 TS2304，
 * 但这些名字只出现在类型注解里（`as ElectronWebviewTag`），运行时不会崩。
 * 【第111轮】首跑实测 8 处全是这一类，属误报，故加白名单。
 * 判据：确认该名字在整个仓里从未作为值被调用/读取，才可加入此表。
 */
const TYPE_ONLY_NAMES = [/^Electron[A-Z]/]

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '')

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) walk(p, acc)
    else if (/\.tsx?$/.test(e.name)) acc.push(p.replace(root + '/', '').replace(/\\/g, '/'))
  }
  return acc
}

function listNocheckFiles() {
  const out = []
  for (const f of walk(`${root}/src`)) {
    let head = ''
    try {
      head = readFileSync(`${root}/${f}`, 'utf8').slice(0, 3000)
    } catch {
      continue
    }
    if (/^\s*\/\/\s*@ts-nocheck/m.test(head)) out.push(f)
  }
  return out
}

const nocheckFiles = listNocheckFiles()
if (nocheckFiles.length === 0) {
  console.log('OK: 无 @ts-nocheck 文件')
  process.exit(0)
}

// 副本放进独立目录：保持 src/ 前缀，相对 import 才解析得到（node_modules 向上查找仍命中）
const shadowDirName = '.nocheck-shadow'
const shadowDir = `${root}/${shadowDirName}`
rmSync(shadowDir, { recursive: true, force: true })

const shadowMap = new Map() // 副本路径 → 原路径
for (const f of nocheckFiles) {
  const src = readFileSync(`${root}/${f}`, 'utf8')
  // 把 @ts-nocheck 那行换成空行，保持后续行号完全一致（报告能直接对回原文）
  const stripped = src.replace(/^(\s*\/\/\s*@ts-nocheck[^\n]*)$/m, '')
  const dest = `${shadowDir}/${f}`
  mkdirSync(dest.slice(0, dest.lastIndexOf('/')), { recursive: true })
  writeFileSync(dest, stripped, 'utf8')
  shadowMap.set(`${shadowDirName}/${f}`, f)
}

const cfgPath = `${root}/tsconfig.nocheck-shadow.json`
writeFileSync(
  cfgPath,
  JSON.stringify(
    {
      extends: './tsconfig.json',
      compilerOptions: { noEmit: true },
      include: [...shadowMap.keys()],
    },
    null,
    2,
  ),
  'utf8',
)

let raw = ''
let undecidable = false
try {
  raw = execFileSync(
    process.execPath,
    [`${root}/node_modules/typescript/bin/tsc`, '--noEmit', '-p', cfgPath, '--pretty', 'false'],
    { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  )
} catch (e) {
  raw = `${e.stdout || ''}${e.stderr || ''}`
  if (!/error TS\d+/.test(raw)) undecidable = true
} finally {
  try {
    rmSync(shadowDir, { recursive: true, force: true })
    rmSync(cfgPath, { force: true })
  } catch {
    /* ignore */
  }
}

if (undecidable) {
  console.error('无法判定：tsc 自身执行失败\n' + raw.slice(0, 2000))
  process.exit(2)
}

const fatal = []
const tolerated = []
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/)
  if (!m) continue
  const [, file, ln, col, code, msg] = m
  const rel = file.replace(root + '/', '').replace(/\\/g, '/')
  if (!shadowMap.has(rel)) continue // 只关心被屏蔽文件自己的诊断
  const rec = { file: shadowMap.get(rel), line: +ln, col: +col, code, msg }
  const missing = msg.match(/Cannot find name '([^']+)'/)
  if (missing && TYPE_ONLY_NAMES.some((re) => re.test(missing[1]))) {
    tolerated.push(rec)
    continue
  }
  if (FATAL_CODES.has(code)) fatal.push(rec)
  else tolerated.push(rec)
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ scanned: nocheckFiles.length, fatal, tolerated: tolerated.length }, null, 2))
}

// 基线比较：存量放过，新增必拦。
// 【第111轮】为什么要基线：撤掉 @ts-nocheck 后现网有 23 处 TS2304 存量（全在
// create-chat-ws-on-event.ts 的机械抽取残留里，现网未崩 = 死分支）。常红等于没护栏。
const BASELINE_PATH = `${root}/scripts/nocheck-shadow-baseline.json`
const fp = (r) => `${r.file}\u0000${r.code}\u0000${r.msg}`
let baseline = []
try {
  baseline = (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).entries || []).map(fp)
} catch {
  /* 基线缺失 = 空基线，全部按新增处理 */
}
const baselineSet = new Set(baseline)

if (process.argv.includes('--update-baseline')) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ entries: fatal.map((r) => ({ file: r.file, code: r.code, msg: r.msg })) }, null, 2) + '\n',
    'utf8',
  )
  console.log(`已更新基线：${fatal.length} 条`)
  process.exit(0)
}

const fresh = fatal.filter((r) => !baselineSet.has(fp(r)))
const fixedCount = baseline.length - (fatal.length - fresh.length)

if (fresh.length > 0) {
  console.error(`FAIL: @ts-nocheck 文件里有 ${fresh.length} 处**新增**运行时必崩错误（tsc 平时看不见）：`)
  for (const f of fresh) console.error(`  ${f.file}(${f.line},${f.col}): ${f.code} ${f.msg}`)
  console.error(
    `\n（扫描 ${nocheckFiles.length} 个被 @ts-nocheck 屏蔽的文件；` +
      `存量放过 ${fatal.length - fresh.length} 条；类型收窄放过 ${tolerated.length} 处）\n` +
      '这些文件被 @ts-nocheck 屏蔽，`tsc --noEmit` 对它们零诊断 —— 上面这些错误能一路过门禁、',
    '\n到运行时才崩（第111轮实证：data is not defined）。修掉它们，或确属存量再跑 --update-baseline。',
  )
  process.exit(1)
}

console.log(
  `OK: 扫描 ${nocheckFiles.length} 个 @ts-nocheck 文件；新增致命错误 0；` +
    `存量${fatal.length}条在基线内；类型收窄放过 ${tolerated.length} 处` +
    (fixedCount > 0 ? `；基线里另有 ${fixedCount} 条已消失（可跑 --update-baseline 收紧）` : ''),
)
process.exit(0)

/**
 * 护栏：`subtask-conversation-history.js` 不得出现裸 `fetch(...)`。
 *
 * 【self-evolution-bot · 2026-11-21 · 第112轮 · 模型:deepseek-v4.1-flash-1017】
 * 为什么要有这条：桌面端 origin 是 `http://tauri.localhost`，裸 fetch 站内相对路径
 *   `/api/...` 打到的是前端静态服务 —— status=200 但 body 是 `<!DOCTYPE html>`，
 *   `.json()` 抛错被 catch 吞掉 → thread_id 永远解不出来 →
 *   右栏「节点进度」面板恒显示「暂无节点会话（未写入 subtask_thread_id）」，
 *   而接口里 thread_id 明明有值。现网实测：相对路径拿到 SPAd 首页，
 *   同一路径打 http://127.0.0.1:8382 拿到真 JSON。
 * 判据（可反证）：把任一 `gatewayFetch(` 改回 `fetch(` 本测试立刻红。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(here, '../src/lib/subtask-conversation-history.js')

/** 剥掉块注释与行注释，避免文档里写的 `fetch('/api/...')` 被当成真调用。
 *  注意：本仓源码是 CRLF，必须先按行切并去掉尾部 \r —— JS 的 `.` 不匹配 \r，
 *  直接对整串跑 `//.*$` 会整条不命中（我第一版就这么假红了一次）。 */
function stripComments(code) {
  const noBlock = code.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlock
    .split('\n')
    .map((raw) => {
      const line = raw.replace(/\r$/, '')
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//')) return ''
      // 行内 // 注释（排除 http:// 这类协议前缀）
      return line.replace(/(^|[^:])\/\/.*$/, '$1')
    })
    .join('\n')
}

/** 裸 fetch = 前面不是 `.` 也不是 `gateway` 这个词尾（gatewayFetch 前驱是字母 y，属 \w）。 */
function findBareFetch(code) {
  const hits = []
  const re = /(^|[^.\w])fetch\s*\(/g
  let m
  while ((m = re.exec(code)) !== null) {
    const line = code.slice(0, m.index).split('\n').length
    hits.push(line)
  }
  return hits
}

describe('subtask-conversation-history 必须走 gatewayFetch', () => {
  it('源码里没有裸 fetch 调用', () => {
    const code = stripComments(readFileSync(SRC, 'utf-8'))
    const bare = findBareFetch(code)
    expect(bare, `发现裸 fetch 在第 ${bare.join(', ')} 行；Tauri 下相对路径会拿到 SPA 首页`).toEqual([])
  })

  it('确实用了 gatewayFetch（防止整段被删成空文件也算通过）', () => {
    const code = stripComments(readFileSync(SRC, 'utf-8'))
    expect(code).toContain('gatewayFetch(')
    expect(code).toContain("from './gateway-json.js'")
  })
})

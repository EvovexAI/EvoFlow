/**
 * 【self-evolution-bot · 2026-11-21 · 第113轮 · 模型:deepseek-v4.1-flash-1017】
 *
 * 回归测试：右栏 codeViewer 分支必须被 RightStageTabErrorBoundary 包住。
 *
 * 现网事故（本轮真机实测）：
 *   `ui.show kind=codeViewer data={source:{type:'code-review'}}`（缺 review 的非法 source）
 *   之后**整块聊天区消失**：
 *     · `#chat-persistent-host` innerHTML 只剩 33 字节（`<div style="height:100%"></div>`）
 *     · `document.body.innerText` 62 字（只剩左侧导航）
 *     · `aside[aria-label="右侧面板"]` 整个不存在
 *     · 预先装的 window error / unhandledrejection 钩子 count=0（React 渲染期抛出，未冒到 window）
 *   对照：terminal / asset / file / 媒体四类分支都有边界，只有 codeViewer 裸挂 V4PreviewPane。
 *   于是一个坏 source 打掉的不是一个签，是**整个应用**。
 *
 * 判据（只认源码结构，不现场渲染）：codeViewer 分支体内必须出现边界组件名，
 * 且 V4PreviewPane 必须落在边界内部 —— 否则这条测试自己就是「注释里提一句就算通过」。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '../src/react/chat-app/right-stage/render-right-stage-body.tsx')

/** 取出 `if (kind === 'codeViewer') { ... }` 这一段（按大括号配平截取）。 */
function codeViewerBranch(source) {
  const marker = "if (kind === 'codeViewer') {"
  const start = source.indexOf(marker)
  expect(start, 'render-right-stage-body.tsx 里找不到 codeViewer 分支').toBeGreaterThan(-1)
  let i = source.indexOf('{', start)
  let depth = 0
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('codeViewer 分支大括号未配平')
}

describe('右栏 codeViewer 分支必须有错误边界', () => {
  const source = readFileSync(SRC, 'utf8')
  const branch = codeViewerBranch(source)

  it('分支体里出现 RightStageTabErrorBoundary', () => {
    expect(branch).toContain('<RightStageTabErrorBoundary')
    expect(branch).toContain('</RightStageTabErrorBoundary>')
  })

  it('V4PreviewPane 落在边界内部（不是只在旁边提一句）', () => {
    const openAt = branch.indexOf('<RightStageTabErrorBoundary')
    const paneAt = branch.indexOf('<V4PreviewPane')
    const closeAt = branch.indexOf('</RightStageTabErrorBoundary>')
    expect(openAt).toBeGreaterThan(-1)
    expect(paneAt).toBeGreaterThan(openAt)
    expect(closeAt).toBeGreaterThan(paneAt)
  })

  it('边界必须带 title（崩溃时用户要看到是哪个签坏了）', () => {
    const openTag = branch.slice(
      branch.indexOf('<RightStageTabErrorBoundary'),
      branch.indexOf('>', branch.indexOf('<RightStageTabErrorBoundary')) + 1,
    )
    expect(openTag).toMatch(/title=/)
  })
})

/**
 * setChatWorkspaceRoot 不得把未展开的 ${ORG_WORKSPACE} 占位符当作工作区根发出去。
 * 【self-evolution-bot · 2026-11-23 · 第130轮 · 模型:qwen3.8-flash】
 * 现网：右栏点文件卡片 → root=${ORG_WORKSPACE} → 网关 400 → read failed: HTTP 400。
 */
import { afterEach, describe, expect, it } from 'vitest'

import { getChatWorkspaceRoot, setChatWorkspaceRoot } from '../src/lib/chat-workspace-context.js'

describe('setChatWorkspaceRoot placeholder healing', () => {
  afterEach(() => setChatWorkspaceRoot(''))

  it('纯占位符视作未绑根（空串）', () => {
    setChatWorkspaceRoot('${ORG_WORKSPACE}')
    expect(getChatWorkspaceRoot()).toBe('')
  })

  it('小写变体同样剥掉', () => {
    setChatWorkspaceRoot('${org_workspace}')
    expect(getChatWorkspaceRoot()).toBe('')
  })

  it('占位符前缀 + 真实子路径 → 保留子路径', () => {
    setChatWorkspaceRoot('${ORG_WORKSPACE}/outputs/x')
    expect(getChatWorkspaceRoot()).toBe('outputs/x')
  })

  it('真实绝对路径原样透传（不许误伤，也不改写分隔符）', () => {
    setChatWorkspaceRoot('D:/dev/github/knowledge-library/workspace')
    expect(getChatWorkspaceRoot()).toBe('D:/dev/github/knowledge-library/workspace')
    // 非占位符分支不动字符串：反斜杠原样保留，交给下游既有归一化逻辑
    setChatWorkspaceRoot('C:\\Users\\admin\\.evoflow\\profiles\\default')
    expect(getChatWorkspaceRoot()).toBe('C:\\Users\\admin\\.evoflow\\profiles\\default')
  })

  it('空/undefined 不报错', () => {
    setChatWorkspaceRoot(undefined)
    expect(getChatWorkspaceRoot()).toBe('')
  })
})

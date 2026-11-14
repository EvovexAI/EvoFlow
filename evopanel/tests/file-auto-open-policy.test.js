import { describe, it, expect, vi, beforeEach } from 'vitest'
import { classifyVoiceFileAutoOpen } from '../src/lib/right-stage/file-auto-open-policy.js'
import { hostFileExists } from '../src/lib/right-stage/heal-workspace-open-path.js'

const resolveTarget = vi.fn()

vi.mock('../src/lib/tauri-api.js', () => ({
  api: {
    resolveWorkspaceTarget: (...args) => resolveTarget(...args),
  },
}))

describe('classifyVoiceFileAutoOpen', () => {
  it('vault 绝对路径（craft 技艺库）→ 不开', () => {
    const d = classifyVoiceFileAutoOpen({
      path: 'C:/Users/admin/.evoflow/profiles/default/scopes/personal/admin/files/craft/银泰画像与直播定位-事实唯一出处.md',
    })
    expect(d.action).toBe('skip')
    expect(d.reason).toBe('vault-internal')
  })

  it('vault 相对路径（memory/craft/profile）→ 不开', () => {
    for (const p of [
      'memory/facts/user-prefs.md',
      'memory/MEMORY.md',
      'craft/直播话术.md',
      'profile/affect.md',
    ]) {
      const d = classifyVoiceFileAutoOpen({ path: p })
      expect(d.action).toBe('skip')
      expect(d.reason).toBe('vault-internal')
    }
  })

  it('用户点名 vault 文件 → 开且走 asset 路由', () => {
    const p =
      'C:/Users/admin/.evoflow/profiles/default/scopes/personal/admin/files/craft/银泰画像与直播定位-事实唯一出处.md'
    const d = classifyVoiceFileAutoOpen({
      path: p,
      userTexts: ['帮我打开 银泰画像与直播定位-事实唯一出处.md 看看'],
    })
    expect(d.action).toBe('open')
    expect(d.reason).toBe('user-mention')
    expect(d.route).toBe('asset')
  })

  it('用户点名工作区文件（文件名子串、大小写不敏感）→ 开', () => {
    const d = classifyVoiceFileAutoOpen({
      path: 'projects/ep1/outputs/report.md',
      userTexts: ['把 Report.MD 里的结论念给我听'],
    })
    expect(d.action).toBe('open')
    expect(d.reason).toBe('user-mention')
    expect(d.route).toBe('file')
  })

  it('点名只认本轮真实用户文本，其他消息不算', () => {
    const d = classifyVoiceFileAutoOpen({
      path: 'notes/a.md',
      userTexts: ['', null, undefined],
    })
    expect(d.action).toBe('skip')
    expect(d.reason).toBe('default-deny')
  })

  it('图片/视频/音频 → 开', () => {
    for (const p of ['outputs/成片.mp4', 'assets/img.PNG', 'tmp/voice.wav']) {
      const d = classifyVoiceFileAutoOpen({ path: p })
      expect(d.action).toBe('open')
      expect(d.reason).toBe('media')
    }
  })

  it('outputs 产物路径 → 开', () => {
    const d = classifyVoiceFileAutoOpen({ path: 'projects/ep1/outputs/report.md' })
    expect(d.action).toBe('open')
    expect(d.reason).toBe('artifact')
  })

  it('内部工作目录（.evoflow/.git/node_modules/skills）→ 不开', () => {
    for (const p of [
      'C:/Users/admin/.evoflow/config.yaml',
      'D:/repo/.git/config',
      'D:/repo/node_modules/vite/index.js',
      'D:/repo/skills/public/x/SKILL.md',
    ]) {
      const d = classifyVoiceFileAutoOpen({ path: p })
      expect(d.action).toBe('skip')
    }
  })

  it('内部说明/配置文件名（AGENTS.md 等）→ 不开', () => {
    for (const p of ['D:/repo/AGENTS.md', 'docs/CLAUDE.md', 'app/package.json', 'pnpm-lock.yaml']) {
      const d = classifyVoiceFileAutoOpen({ path: p })
      expect(d.action).toBe('skip')
    }
  })

  it('源码自读与其他未命中 → 兜底不开', () => {
    for (const p of ['src/app/main.ts', 'scripts/run.py', 'README.md', 'notes/todo.md']) {
      const d = classifyVoiceFileAutoOpen({ path: p })
      expect(d.action).toBe('skip')
      expect(d.reason).toBe('default-deny')
    }
  })

  it('空路径 → 不开', () => {
    expect(classifyVoiceFileAutoOpen({ path: '' }).reason).toBe('no-path')
    expect(classifyVoiceFileAutoOpen({ path: '   ' }).action).toBe('skip')
  })
})

describe('hostFileExists', () => {
  beforeEach(() => {
    resolveTarget.mockReset()
  })

  it('后端明确 exists=false → false（拦死标签）', async () => {
    resolveTarget.mockResolvedValue({ resolved: 'D:/w/x.md', exists: false })
    expect(await hostFileExists('x.md', { workspaceRoot: 'D:/w' })).toBe(false)
    expect(resolveTarget).toHaveBeenCalledWith('D:/w', 'x.md', undefined)
  })

  it('后端 exists=true → true', async () => {
    resolveTarget.mockResolvedValue({ resolved: 'D:/w/x.md', exists: true })
    expect(await hostFileExists('x.md', { workspaceRoot: 'D:/w' })).toBe(true)
  })

  it('查询报错 → 不拦截（true，保持旧行为）', async () => {
    resolveTarget.mockRejectedValue(new Error('api down'))
    expect(await hostFileExists('D:/w/x.md', { workspaceRoot: 'D:/w' })).toBe(true)
  })

  it('无 root 且相对路径，无法校验 → true', async () => {
    expect(await hostFileExists('x.md')).toBe(true)
    expect(resolveTarget).not.toHaveBeenCalled()
  })

  it('空路径 → false', async () => {
    expect(await hostFileExists('')).toBe(false)
  })
})

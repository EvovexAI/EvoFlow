import { describe, expect, it } from 'vitest'
import {
  assetsHrefForPath,
  extractEntityAssetRelPath,
  extractEvoAssetCitations,
  isDisplayableAssetCitationPath,
  normalizeAssetCitationPath,
  stripEvoAssetCitations,
} from '../src/react/lib/evo-asset-citation.ts'

describe('evo-asset-citation', () => {
  it('strips proper XML blocks and keeps markdown body', () => {
    const raw = [
      '结论如下。',
      '',
      '<evo-asset-citation>',
      '<citation_entries>',
      'memory/facts/foo.md:1-3|note=[偏好]',
      '</citation_entries>',
      '</evo-asset-citation>',
    ].join('\n')
    const parsed = extractEvoAssetCitations(raw)
    expect(parsed.text).toBe('结论如下。')
    expect(parsed.entries).toEqual([
      { path: 'memory/facts/foo.md', lineStart: 1, lineEnd: 3, note: '偏好' },
    ])
  })

  it('strips loose citation_entries leak with kb_ id (user-visible bug)', () => {
    const raw =
      '已核对报价。\n\ncitation_entries: kb_ed4de5d2768e4a398753533ea7ed5234 | note=[参考图实物一致性、assetPublicBaseUrl 阻塞、category 跑偏处理、报价 cost 为 null]'
    expect(stripEvoAssetCitations(raw)).toBe('已核对报价。')
    const parsed = extractEvoAssetCitations(raw)
    expect(parsed.entries[0]?.path).toBe('kb_ed4de5d2768e4a398753533ea7ed5234')
    expect(isDisplayableAssetCitationPath(parsed.entries[0].path)).toBe(false)
  })

  it('strips orphan citation_entries without outer wrapper', () => {
    const raw = '正文\n\n<citation_entries>\nmemory/a.md|note=[x]\n</citation_entries>'
    const parsed = extractEvoAssetCitations(raw)
    expect(parsed.text).toBe('正文')
    expect(parsed.entries[0]?.path).toBe('memory/a.md')
  })

  it('tolerates spaces around |note=', () => {
    const parsed = extractEvoAssetCitations(
      '<evo-asset-citation>\n<citation_entries>\ncraft/x.md | note=[简要]\n</citation_entries>\n</evo-asset-citation>',
    )
    expect(parsed.entries[0]).toMatchObject({ path: 'craft/x.md', note: '简要' })
  })

  it('strips markdown list markers glued onto citation paths', () => {
    const parsed = extractEvoAssetCitations(
      [
        '<evo-asset-citation>',
        '<citation_entries>',
        '- memory/_inbox/notes/experience-foo.md | note=[本轮新沉淀]',
        '- craft/continuity-report-chain.md — 场记闭环',
        '* memory/facts/bar.md|note=[要点]',
        '</citation_entries>',
        '</evo-asset-citation>',
      ].join('\n'),
    )
    expect(parsed.entries.map((e) => e.path)).toEqual([
      'memory/_inbox/notes/experience-foo.md',
      'craft/continuity-report-chain.md',
      'memory/facts/bar.md',
    ])
    expect(parsed.entries[0]?.note).toBe('本轮新沉淀')
    expect(parsed.entries[1]?.note).toBe('场记闭环')
    expect(normalizeAssetCitationPath('- craft/continuity-report-chain.md')).toBe(
      'craft/continuity-report-chain.md',
    )
  })

  it('extractEntityAssetRelPath peels vault paths and rejects workspace files', () => {
    expect(extractEntityAssetRelPath('memory/_inbox/notes/foo.md')).toBe(
      'memory/_inbox/notes/foo.md',
    )
    expect(extractEntityAssetRelPath('craft/continuity-report-chain.md')).toBe(
      'craft/continuity-report-chain.md',
    )
    expect(
      extractEntityAssetRelPath(
        'D:\\dev\\github\\knowledge-library\\ai漫剧工具包\\memory\\_inbox\\notes\\experience-foo.md',
      ),
    ).toBe('memory/_inbox/notes/experience-foo.md')
    expect(extractEntityAssetRelPath('projects/outputs/segA.mp4')).toBe(null)
    expect(extractEntityAssetRelPath('src/main.ts')).toBe(null)
  })

  it('assetsHrefForPath maps craft→experience and carries entity', () => {
    const href = assetsHrefForPath('- craft/continuity-report-chain.md', {
      entityType: 'employee',
      entityId: 'ops-bot',
    })
    expect(href.startsWith('#/assets?')).toBe(true)
    expect(href).toContain('tab=experience')
    expect(href).toContain('entityType=employee')
    expect(href).toContain('entityId=ops-bot')
    expect(href).toContain('path=craft%2Fcontinuity-report-chain.md')
    expect(href).not.toContain('-+craft')
    expect(href).not.toContain('tab=craft')

    const inbox = assetsHrefForPath('memory/_inbox/notes/foo.md', {
      entityType: 'employee',
      entityId: 'ops-bot',
    })
    expect(inbox).toContain('tab=memory')
    expect(inbox).not.toContain('memoryKind=')
    expect(inbox).toContain('path=memory%2F_inbox%2Fnotes%2Ffoo.md')
  })
})

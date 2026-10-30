import { describe, expect, it } from 'vitest'
import {
  extractEvoAssetCitations,
  isDisplayableAssetCitationPath,
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
})

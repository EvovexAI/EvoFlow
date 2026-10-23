import { describe, expect, it } from 'vitest'
import {
  clipTable,
  detectCsvDelimiter,
  formatJsonPreview,
  parseCsvRows,
  stripMermaidFence,
  toMermaidMarkdown,
} from '../src/lib/preview-doc-parsers.js'

describe('detectCsvDelimiter', () => {
  it(' honours tsv extension', () => {
    expect(detectCsvDelimiter('a\tb\tc', 'tsv')).toBe('\t')
  })

  it('picks the most frequent separator on the header line', () => {
    expect(detectCsvDelimiter('a,b,c\nd,e,f')).toBe(',')
    expect(detectCsvDelimiter('a;b;c\nd;e;f')).toBe(';')
    expect(detectCsvDelimiter('a|b|c\nd|e|f')).toBe('|')
  })

  it('falls back to comma for single-column content', () => {
    expect(detectCsvDelimiter('onlyhead\nrow')).toBe(',')
  })
})

describe('parseCsvRows', () => {
  it('parses a simple table', () => {
    expect(parseCsvRows('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('keeps quoted delimiters and escaped quotes', () => {
    const rows = parseCsvRows('name,note\n"Li, Wei","say ""hi"""')
    expect(rows[1]).toEqual(['Li, Wei', 'say "hi"'])
  })

  it('supports quoted newlines', () => {
    const rows = parseCsvRows('id,body\n1,"line1\nline2"')
    expect(rows).toHaveLength(2)
    expect(rows[1][1]).toBe('line1\nline2')
  })

  it('handles CRLF and drops trailing blank lines', () => {
    expect(parseCsvRows('a,b\r\n1,2\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('honours a tab delimiter', () => {
    expect(parseCsvRows('a\tb\n1\t2', { delimiter: '\t' })).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('returns empty for blank input', () => {
    expect(parseCsvRows('   ')).toEqual([])
  })
})

describe('clipTable', () => {
  it('pads short rows to the column count', () => {
    const out = clipTable([
      ['a', 'b', 'c'],
      ['1'],
    ])
    expect(out.columns).toBe(3)
    expect(out.rows[1]).toEqual(['1', '', ''])
    expect(out.truncatedRows).toBe(0)
    expect(out.truncatedCols).toBe(0)
  })

  it('reports truncated rows and columns', () => {
    const rows = [
      ['h1', 'h2', 'h3'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]
    const out = clipTable(rows, { maxRows: 2, maxCols: 2 })
    expect(out.rows).toHaveLength(2)
    expect(out.truncatedRows).toBe(1)
    expect(out.truncatedCols).toBe(1)
  })
})

describe('formatJsonPreview', () => {
  it('pretty-prints valid json', () => {
    const out = formatJsonPreview('{"b":1,"a":[1,2]}')
    expect(out.ok).toBe(true)
    expect(out.text).toBe('{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}')
  })

  it('flags invalid json and keeps raw text', () => {
    const out = formatJsonPreview('{oops}')
    expect(out.ok).toBe(false)
    expect(out.text).toBe('{oops}')
    expect(out.error).toBeTruthy()
  })

  it('flags empty input', () => {
    expect(formatJsonPreview('   ').ok).toBe(false)
  })
})

describe('mermaid helpers', () => {
  it('strips an existing fenced block', () => {
    expect(stripMermaidFence('```mermaid\nflowchart TD\n A-->B\n```')).toBe('flowchart TD\n A-->B')
  })

  it('keeps raw diagram source untouched', () => {
    expect(stripMermaidFence('flowchart TD\n A-->B')).toBe('flowchart TD\n A-->B')
  })

  it('wraps source in a mermaid fence for the markdown renderer', () => {
    expect(toMermaidMarkdown('flowchart TD\n A-->B')).toBe('```mermaid\nflowchart TD\n A-->B\n```')
  })

  it('does not double-wrap an already fenced diagram', () => {
    expect(toMermaidMarkdown('```mermaid\nflowchart TD\n A-->B\n```')).toBe(
      '```mermaid\nflowchart TD\n A-->B\n```',
    )
  })

  it('returns empty for blank input', () => {
    expect(toMermaidMarkdown('   ')).toBe('')
  })
})

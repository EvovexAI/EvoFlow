/**
 * Knowledge Vault UI — router + nav + DOM integration (jsdom/happy-dom).
 * Not a substitute for Playwright GUI smoke; covers wiring that was previously missing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SHOW_KNOWLEDGE_NAV, SHOW_KNOWLEDGE_VAULT_NAV, knowledgeVaultWriteEnabled } from '../src/lib/nav-visibility.js'

describe('nav visibility flags', () => {
  it('exposes Obsidian Vault nav by default', () => {
    expect(SHOW_KNOWLEDGE_VAULT_NAV).toBe(true)
  })

  it('hides document upload nav by default (Vault is the primary entry)', () => {
    expect(SHOW_KNOWLEDGE_NAV).toBe(false)
  })

  it('keeps write UI behind opt-in flag', () => {
    localStorage.removeItem('evopanel.knowledgeVaultWriteEnabled')
    expect(knowledgeVaultWriteEnabled()).toBe(false)
    localStorage.setItem('evopanel.knowledgeVaultWriteEnabled', '1')
    expect(knowledgeVaultWriteEnabled()).toBe(true)
    localStorage.removeItem('evopanel.knowledgeVaultWriteEnabled')
  })
})

describe('route matching for vaults', () => {
  it('distinguishes /knowledge/vaults from /knowledge/:id', () => {
    const vaults = '/knowledge/vaults'
    const detail = '/knowledge/ds_abc'
    expect(/^\/knowledge\/vaults$/.test(vaults)).toBe(true)
    expect(/^\/knowledge\/vaults$/.test(detail)).toBe(false)
    const isVaults = /^\/knowledge\/vaults$/.test(vaults)
    const isDetail = !isVaults && /^\/knowledge\/[^/]+$/.test(vaults)
    expect(isVaults).toBe(true)
    expect(isDetail).toBe(false)
  })
})

describe('knowledge-vaults page empty state', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.resetModules()
  })

  it('renders title, empty state, and add button when API returns no vaults', async () => {
    vi.doMock('../src/lib/tauri-api.js', () => ({
      api: {
        listKnowledgeVaults: vi.fn(async () => ({ items: [] })),
        getKnowledgeVaultStatus: vi.fn(),
        createKnowledgeVault: vi.fn(),
        testKnowledgeVault: vi.fn(),
        deleteKnowledgeVault: vi.fn(),
        updateKnowledgeVault: vi.fn(),
        searchKnowledgeVault: vi.fn(),
        readKnowledgeVault: vi.fn(),
        graphKnowledgeVault: vi.fn(),
        reindexKnowledgeVault: vi.fn(),
        installKnowledgeVault: vi.fn(),
      },
    }))

    const { render, cleanup } = await import('../src/pages/knowledge-vaults.js')
    const page = await render()
    document.body.appendChild(page)

    expect(page.getAttribute('data-testid')).toBe('knowledge-vaults-page')
    await vi.waitFor(() => {
      expect(page.querySelector('[data-testid="kv-page-title"]')?.textContent).toContain(
        '知识库',
      )
      expect(page.querySelector('[data-testid="kv-empty"]')?.textContent).toContain('尚未连接知识库')
      expect(page.querySelector('[data-testid="kv-empty-add"]')?.textContent).toContain('连接第一个知识库')
    })

    page.querySelector('[data-testid="kv-empty-add"]').click()
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="kv-wizard"]')).toBeTruthy()
      expect(document.querySelector('[data-testid="kv-wizard"]')?.textContent).toContain('选择文件夹')
    })

    cleanup()
  })

  it('renders vault cards with actions when API returns items', async () => {
    vi.doMock('../src/lib/tauri-api.js', () => ({
      api: {
        listKnowledgeVaults: vi.fn(async () => ({
          items: [
            {
              id: 'v1',
              name: 'Demo Vault',
              vaultPath: 'D:/notes',
              accessMode: 'read_only',
              enabled: true,
            },
          ],
        })),
        getKnowledgeVaultStatus: vi.fn(async () => ({
          searchReady: true,
          noteCount: 3,
          lastIndexedAt: '2026-07-21T00:00:00Z',
        })),
        createKnowledgeVault: vi.fn(),
        testKnowledgeVault: vi.fn(),
        deleteKnowledgeVault: vi.fn(),
        updateKnowledgeVault: vi.fn(),
        searchKnowledgeVault: vi.fn(),
        readKnowledgeVault: vi.fn(),
        graphKnowledgeVault: vi.fn(),
        reindexKnowledgeVault: vi.fn(),
        installKnowledgeVault: vi.fn(),
      },
    }))

    const { render, cleanup } = await import('../src/pages/knowledge-vaults.js')
    const page = await render()
    document.body.appendChild(page)

    await vi.waitFor(() => {
      const card = page.querySelector('[data-testid="kv-card-v1"]')
      expect(card).toBeTruthy()
      expect(card.textContent).toContain('Demo Vault')
      expect(card.textContent).toContain('3 篇文档')
      expect(card.textContent).toContain('索引就绪')
      expect(card.querySelector('button[title="更多操作"]')).toBeTruthy()
    })

    cleanup()
  })

  it('shows API error instead of swallowing', async () => {
    vi.doMock('../src/lib/tauri-api.js', () => ({
      api: {
        listKnowledgeVaults: vi.fn(async () => {
          throw new Error('Gateway unreachable on 8070')
        }),
      },
    }))

    const { render, cleanup } = await import('../src/pages/knowledge-vaults.js')
    const page = await render()
    document.body.appendChild(page)
    await vi.waitFor(() => {
      const err = page.querySelector('[data-testid="kv-error"]')
      expect(err?.textContent).toContain('Gateway unreachable')
      expect(err?.textContent).toContain('Gateway')
    })
    cleanup()
  })
})

describe('shell-aside nav markup includes vault entry', () => {
  it('renders Obsidian Vault button when flag is true', async () => {
    expect(SHOW_KNOWLEDGE_VAULT_NAV).toBe(true)
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(process.cwd(), 'src/components/shell-aside.js'), 'utf8')
    expect(src).toContain('data-testid="nav-knowledge-vaults"')
    expect(src).toContain('data-shell-nav="/knowledge/vaults"')
    expect(src).toContain('知识库')
  })
})

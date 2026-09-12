import { describe, expect, it } from 'vitest'
import {
  buildRemoteUiExtensionManifest,
  manifestHasSensitivePermissions,
  parseUiExtensionManifest,
  resolveEntryUrl,
} from '../src/lib/ui-extension-manifest.js'

describe('parseUiExtensionManifest', () => {
  it('accepts minimal remote manifest', () => {
    const r = parseUiExtensionManifest({
      schema: 1,
      id: 'hello-ops',
      name: 'Hello',
      version: '1.0.0',
      ui: { kind: 'webview', entry: 'https://example.com/x' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.service.mode).toBe('none')
      expect(r.manifest.permissions).toContain('embed')
      expect(r.manifest.nav.group).toBe('extensions')
    }
  })

  it('rejects bad id', () => {
    const r = parseUiExtensionManifest({
      schema: 1,
      id: 'Bad_ID',
      name: 'x',
      version: '1',
      ui: { kind: 'webview', entry: 'https://a.com' },
    })
    expect(r.ok).toBe(false)
  })

  it('requires start for managed', () => {
    const r = parseUiExtensionManifest({
      schema: 1,
      id: 'svc',
      name: 'S',
      version: '1',
      ui: { kind: 'webview', entry: 'http://127.0.0.1:3001' },
      service: { mode: 'managed' },
    })
    expect(r.ok).toBe(false)
  })

  it('parses contentos-like managed', () => {
    const r = parseUiExtensionManifest({
      schema: 1,
      id: 'contentos',
      name: '智能运营中台',
      version: '1.0.0',
      ui: { kind: 'webview', entry: 'http://127.0.0.1:3001' },
      permissions: ['embed', 'tasks.dispatch'],
      service: {
        mode: 'managed',
        start: { default: ['pnpm', 'dev'] },
        healthcheck: { url: 'http://127.0.0.1:3001' },
        ports: [3001],
      },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(manifestHasSensitivePermissions(r.manifest)).toBe(true)
      expect(resolveEntryUrl(r.manifest)).toBe('http://127.0.0.1:3001')
    }
  })

  it('keeps service.link, sharedKey, suite and runtime', () => {
    const r = parseUiExtensionManifest({
      schema: 1,
      id: 'contentos-materials',
      name: '素材中心',
      version: '1.0.0',
      ui: { kind: 'webview', entry: 'http://127.0.0.1:3001/materials?acs_focus=materials' },
      service: {
        mode: 'managed',
        link: true,
        cwd: '../..',
        sharedKey: 'contentos',
        start: { default: ['pnpm', '--filter', '@acs/web', 'dev'] },
        healthcheck: { url: 'http://127.0.0.1:3001' },
        ports: [3001],
      },
      suite: 'content-creator',
      runtime: {
        id: 'contentos-runtime',
        sharedKey: 'contentos',
        mcpServer: 'contentos',
      },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.service.link).toBe(true)
      expect(r.manifest.service.cwd).toBe('../..')
      expect(r.manifest.service.sharedKey).toBe('contentos')
      expect(r.manifest.suite).toBe('content-creator')
      expect(r.manifest.runtime).toEqual({
        id: 'contentos-runtime',
        sharedKey: 'contentos',
        mcpServer: 'contentos',
      })
    }
  })
})

describe('buildRemoteUiExtensionManifest', () => {
  it('fills allowlist from entry origin', () => {
    const r = buildRemoteUiExtensionManifest({
      id: 'remote-a',
      name: 'R',
      entry: 'https://ops.example.com/app',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.bridge.origin_allowlist).toContain('https://ops.example.com')
    }
  })
})

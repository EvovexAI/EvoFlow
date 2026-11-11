/**
 * Right-pane media open: only Tauri asset URLs should short-circuit without serve-file probe.
 * (Mirrors helpers in V4ZCodeTimeline — keep in sync if URL shapes change.)
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

function isTauriAssetMediaUrl(url) {
  const u = String(url || '').trim()
  if (!u) return false
  if (/^asset:/i.test(u)) return true
  if (/^https?:\/\/asset\.localhost\b/i.test(u)) return true
  if (/^https?:\/\/[^/]*\.asset\.localhost\b/i.test(u)) return true
  return false
}

function hostPathHasNonAscii(path) {
  return /[^\x00-\x7F]/.test(String(path || ''))
}

function hostPathIsUnderRoot(absPath, root) {
  const a = String(absPath || '')
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase()
  const r = String(root || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
  if (!a || !r) return false
  return a === r || a.startsWith(`${r}/`)
}

describe('isTauriAssetMediaUrl', () => {
  it('accepts Tauri 2 asset.localhost URLs', () => {
    assert.equal(isTauriAssetMediaUrl('https://asset.localhost/D%3A%2Fout%2Fmv.mp4'), true)
    assert.equal(isTauriAssetMediaUrl('http://asset.localhost/foo.png'), true)
    assert.equal(isTauriAssetMediaUrl('asset://localhost/C:/a.mp4'), true)
  })

  it('rejects Gateway serve-file and SPA-relative API URLs', () => {
    assert.equal(
      isTauriAssetMediaUrl('/api/workspaces/serve-file?path=mv.mp4'),
      false,
    )
    assert.equal(
      isTauriAssetMediaUrl('http://127.0.0.1:8382/api/workspaces/serve-file?path=mv.mp4'),
      false,
    )
    assert.equal(isTauriAssetMediaUrl('https://tauri.localhost/index.html'), false)
  })
})

describe('hostPathHasNonAscii (skip convertFileSrc)', () => {
  it('flags Chinese deliverable paths', () => {
    assert.equal(
      hostPathHasNonAscii(
        'D:/dev/github/knowledge-library/ai-showcase/aigc/ai-creative-ad-video/projects/皇帝第一视角-30秒-20261110/11-deliver/皇帝第一视角_30s_完成版.mp4',
      ),
      true,
    )
    assert.equal(hostPathHasNonAscii('D:/out/mv.mp4'), false)
  })
})

describe('hostPathIsUnderRoot (serve-file root pick)', () => {
  it('treats outside-workspace abs paths as not under bound root', () => {
    assert.equal(
      hostPathIsUnderRoot(
        'D:/dev/github/knowledge-library/foo/bar.mp4',
        'C:/Users/admin/.evoflow/workspaces/role',
      ),
      false,
    )
    assert.equal(
      hostPathIsUnderRoot('C:/Users/admin/.evoflow/workspaces/role/out/a.mp4', 'C:/Users/admin/.evoflow/workspaces/role'),
      true,
    )
  })
})

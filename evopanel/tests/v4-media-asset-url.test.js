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

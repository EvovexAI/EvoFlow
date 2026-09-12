/**
 * 资产中心 — React 科技感 UI（画像 / 记忆 / 经验 / 反思 / 专长 / 导出）
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import AssetCenterContent from './AssetCenterContent.tsx'
import '../style/asset-center.css'

let root = null

export async function render() {
  document.getElementById('app')?.classList.add('evopanel-assets-mode')

  const wrap = document.createElement('div')
  wrap.className = 'page assets-center-outlet'
  wrap.setAttribute('data-testid', 'assets-center-page')

  const mount = document.createElement('div')
  mount.id = 'assets-center-root'
  wrap.appendChild(mount)

  root = createRoot(mount)
  root.render(createElement(AssetCenterContent))
  return wrap
}

export function cleanup() {
  document.getElementById('app')?.classList.remove('evopanel-assets-mode')
  if (root) {
    root.unmount()
    root = null
  }
}

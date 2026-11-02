/**
 * 工作流图标瓦片（React 侧）。
 *
 * 与原生 DOM 侧的 lib/app-icon.js 共用同一份图标几何与色相解析，
 * 保证列表卡片 / 画布工具栏 / 填参页三处对同一条工作流给出同样的脸。
 */
import { createElement, memo } from 'react'

import { appIconNodes } from '../../lib/app-icon.js'

type Props = {
  /** 图标种子：优先用 id（改名不变脸），无 id 时回退 name。 */
  app?: { id?: string; name?: string } | null
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZE_CLASS: Record<string, string> = {
  sm: ' app-ico-tile--sm',
  md: ' app-ico-tile--md',
  lg: '',
}

function AppIconTileBase({ app, size = 'lg', className = '' }: Props) {
  const { nodes, hue } = appIconNodes(app)
  const cls = 'app-ico-tile' + (SIZE_CLASS[size] ?? '') + (className ? ' ' + className : '')

  return createElement(
    'span',
    { className: cls, style: { '--app-ico-h': String(hue) } as Record<string, string>, 'aria-hidden': true },
    createElement(
      'svg',
      {
        className: 'app-ico',
        width: size === 'sm' ? 18 : 22,
        height: size === 'sm' ? 18 : 22,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.85,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      nodes.map(([tag, attrs], i) => createElement(tag, { ...attrs, key: i })),
    ),
  )
}

const AppIconTile = memo(AppIconTileBase)
export default AppIconTile

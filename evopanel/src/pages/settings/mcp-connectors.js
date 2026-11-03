/**
 * 设置中心 — 连接器 / MCP（原智能体中心「连接器」Tab）
 */

import { mountExpertModuleInto } from './expert-module-embed.js'

let _cleanup = null

export async function mountMcpConnectorsInto(container) {
  cleanup()
  _cleanup = await mountExpertModuleInto(container, {
    moduleLoader: () => import('../tools.js'),
    primaryLabel: '添加连接器',
    primaryTitle: '添加 MCP 连接器',
  })
}

export function cleanup() {
  if (_cleanup) {
    try {
      _cleanup()
    } catch (_) {}
    _cleanup = null
  }
}

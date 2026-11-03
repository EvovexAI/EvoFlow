/**
 * 设置中心 — 技能管理（原智能体中心「技能」Tab）
 */

import { mountExpertModuleInto } from './expert-module-embed.js'

let _cleanup = null

export async function mountSkillManagementInto(container) {
  cleanup()
  _cleanup = await mountExpertModuleInto(container, {
    moduleLoader: () => import('../skills.js'),
    primaryLabel: '导入本地技能',
    primaryTitle: '选择含 SKILL.md 的文件夹（原地登记）或导入 zip',
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

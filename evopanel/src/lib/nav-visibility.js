/** 侧栏导航可见性（高级功能入口始终展示；未激活时路由进入激活页）。 */

import { LICENSE_GATE_ENABLED } from './license.js'

/** @deprecated 旧「上传文档 RAG」入口；知识主入口为自有知识库（/knowledge/owned）。 */
export const SHOW_KNOWLEDGE_NAV = false

/** 运维「激活码」台账入口；与 LICENSE_GATE_ENABLED 同步，默认隐藏。 */
export function showLicenseKeysNav() {
  return LICENSE_GATE_ENABLED
}

/** Obsidian vault navigation: always hidden (feature removed). */
export const SHOW_KNOWLEDGE_VAULT_NAV = false

/** 自研知识库导航入口：始终可见。 */
export const SHOW_KNOWLEDGE_OWNED_NAV = true

/** @deprecated 使用 showTaskCenterNav() */
export const SHOW_TASK_CENTER_NAV = true

/** @deprecated 使用 showAppsNav() */
export const SHOW_APPS_NAV = true

/** 任务中心入口始终可见 */
export function showTaskCenterNav() {
  return true
}

/** 应用中心入口始终可见 */
export function showAppsNav() {
  return true
}

/** 智能体员工入口始终可见 */
export function showProactiveNav() {
  return true
}

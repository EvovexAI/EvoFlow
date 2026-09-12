/** 侧栏导航可见性（高级功能入口始终展示；未激活时路由进入激活页）。 */

import { LICENSE_GATE_ENABLED } from './license.js'

/**
 * @deprecated 旧「上传文档 RAG」入口；知识主入口为自有知识库（/knowledge/owned）。
 * 保留常量以免外部脚本引用报错，始终为 false。
 */
export const SHOW_KNOWLEDGE_NAV = false

/** 运维「激活码」台账入口；与 LICENSE_GATE_ENABLED 同步，默认隐藏。 */
export function showLicenseKeysNav() {
  return LICENSE_GATE_ENABLED
}

/** 知识库侧栏入口（默认进自有知识库；Obsidian Vault 仅遗留页）。 */
export const SHOW_KNOWLEDGE_VAULT_NAV = true

/**
 * 写入相关 UI（ingest / write 表单）。默认关闭；只读搜索/预览/Graph 不受影响。
 * 可通过 localStorage `evopanel.knowledgeVaultWriteEnabled=1` 打开。
 */
export function knowledgeVaultWriteEnabled() {
  try {
    return localStorage.getItem('evopanel.knowledgeVaultWriteEnabled') === '1'
  } catch {
    return false
  }
}

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

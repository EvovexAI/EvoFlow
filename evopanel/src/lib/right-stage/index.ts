export * from './right-stage-types.js'
export * from './right-stage-layout.js'
export * from './right-stage-store.js'
export * from './right-stage-layout-priority.js'
export * from './right-stage-registry.js'
export * from './use-right-stage.js'
export { applyRightStageAgUiCustom } from './right-stage-agui.js'
export * from './write-stream-mode.js'
export * from './decide-right-stage.js'
export * from './apply-decide-right-stage.js'
export * from './right-stage-extensions.js'
export * from './right-panel-contract.js'

// 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
// 改了什么：删掉这里的 `void import('./right-panel-contract.js').then(load...)` 预取。
// 为什么：本 barrel 全仓没有任何生产代码 import（grep 为空），这段预取永不执行，
// 却让人误以为契约已经预取过。预取已搬进 right-panel-contract.ts 模块末尾，
// 那里被 open-progress-from-panel-set / platform-feedback 静态引用，必定加载。

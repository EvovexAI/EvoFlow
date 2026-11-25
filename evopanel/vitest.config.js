import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const zcodeUiDir = path.resolve(__dirname, 'src/zcode-ui')
const zcodeSharedDir = path.resolve(__dirname, 'src/zcode-shared')
const zcodeRpcDir = path.resolve(__dirname, 'src/zcode-rpc')
const zcodeProviderDir = path.resolve(__dirname, 'src/zcode-provider')
const zcodeProviderNodeDir = path.resolve(__dirname, 'src/zcode-provider-node')
const zcodeServicesDir = path.resolve(__dirname, 'src/zcode-services')
const zcodeModelOptionMapDir = path.resolve(__dirname, 'src/zcode-model-option-map')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // 与 vite.config.js / tsconfig.json 保持一致（vendored ZCode 树，见 scripts/vendor-zcode.cjs）。
      { find: '@', replacement: zcodeUiDir },
      { find: /^@zcode\/ui$/, replacement: path.join(zcodeUiDir, 'index.ts') },
      { find: /^@zcode\/ui\/(.*)$/, replacement: path.join(zcodeUiDir, '$1') },
      { find: /^@zcode\/shared$/, replacement: path.join(zcodeSharedDir, 'index.ts') },
      { find: /^@zcode\/shared\/(.*)$/, replacement: path.join(zcodeSharedDir, '$1') },
      { find: /^@zcode\/rpc$/, replacement: path.join(zcodeRpcDir, 'index.ts') },
      { find: /^@zcode\/rpc\/(.*)$/, replacement: path.join(zcodeRpcDir, '$1') },
      { find: /^@zcode\/provider$/, replacement: path.join(zcodeProviderDir, 'index.ts') },
      { find: /^@zcode\/provider\/(.*)$/, replacement: path.join(zcodeProviderDir, '$1') },
      { find: /^@zcode\/provider-node$/, replacement: path.join(zcodeProviderNodeDir, 'index.ts') },
      { find: /^@zcode\/provider-node\/(.*)$/, replacement: path.join(zcodeProviderNodeDir, '$1') },
      { find: /^@zcode\/services$/, replacement: path.join(zcodeServicesDir, 'index.ts') },
      { find: /^@zcode\/services\/(.*)$/, replacement: path.join(zcodeServicesDir, '$1') },
      { find: /^@zcode\/model-option-map$/, replacement: path.join(zcodeModelOptionMapDir, 'index.ts') },
      { find: /^@zcode\/model-option-map\/(.*)$/, replacement: path.join(zcodeModelOptionMapDir, '$1') },
      { find: /^#src\/(.*)$/, replacement: path.join(zcodeServicesDir, '$1') },
    ],
  },
  test: {
    environment: 'happy-dom',
    // 其余 tests/*.test.js 使用 node:test，由 `node --test` 单独运行
    include: [
      'tests/shell-session-list-menu.test.tsx',
      // 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
      // 右栏面板契约：前端校验与后端 right_panel_kinds.py 同口径
      'tests/right-panel-contract.test.js',
      'tests/platform-scope-ui.test.js',
      'tests/codex-auth-panel.test.js',
      'tests/v4-wire-conformance.test.ts',
      'tests/conversation-row-sharing.test.ts',
      'tests/control-busy.test.ts',
      'tests/v4-running-text-interleave.test.ts',
      'tests/v4-reasoning-visibility.test.ts',
      'tests/v4-timeline-scroll-anchor.test.ts',
      'tests/zcode-flat-reasoning.test.js',
      'tests/turn-history-fold.test.tsx',
      'tests/font-size-tokens.test.js',
      'tests/aside-title-shimmer.test.js',
      'tests/chat-summary-panel.test.js',
      'tests/chat-summary-process-agent-detail.test.tsx',
      'tests/compose-attach.test.js',
      'tests/tts-speaker-custom-toggle.test.js',
      'tests/web-embed-url.test.js',
      'tests/global-assistant.test.js',
      'tests/proactive-approval-notify.test.js',
      'tests/assistant-display-noise.test.js',
      'tests/chat-normalize.test.js',
      'tests/evo-asset-citation.test.js',
      'tests/chat-cua-display.test.js',
      'tests/node-repl-cua-display.test.js',
      'tests/clarify-preview-resolve.test.js',
      'tests/tool-display.test.js',
      'tests/read-tool-multi-path.test.ts',
      'tests/subagent-stream-merge.test.js',
      'tests/terminal-stream-merge.test.js',
      'tests/subagent-type-policy.test.js',
      'tests/subtask-result-display.test.js',
      'tests/subtask-modal-rows.test.js',
      'tests/subtask-modal-message-row.test.js',
      'tests/subagent-tool-display.test.js',
      'tests/transcript-persist.test.js',
      'tests/transcript-resume-anchor.test.js',
      'tests/workspace-api-scope.test.js',
      'tests/chat-workspace-root-placeholder.test.js',
      'tests/artifact-absolute-path.test.js',
      'tests/workspace-stream-preview.test.js',
      'tests/workspace-html-preview.test.js',
      'tests/preview-view-mode.test.js',
      'tests/preview-doc-parsers.test.js',
      'tests/preview-pane-text-wrap-default.test.ts',
      'tests/preview-pane-code-review.test.ts',
      'tests/preview-pane-breadcrumb-path.test.ts',
      'tests/workspace-recent-sections.test.js',
      'tests/zcode-theme-host-scope.test.ts',
      'tests/workspace-file-preview-view-toggle.test.tsx',
      'tests/tool-approval.test.js',
      'tests/tool-approval-panel.test.tsx',
      'tests/tool-call-list-live-approval.test.tsx',
      'tests/plan-exec-ui.test.js',
      'tests/collab-sidebar-tools.test.js',
      'tests/plan-pipeline.test.js',
      'tests/plan-task-status.test.js',
      'tests/plan-from-api.test.js',
      'tests/collab-subtasks-from-api.test.js',
      'tests/child-work-workflow-bridge.test.js',
      'tests/use-collab-subtasks-error-resilience.test.tsx',
      'tests/collab-thread-ids.test.js',
      'tests/subtask-live-preview.test.js',
      'tests/workflow-node-activity.test.ts',
      'tests/soft-progress-display.test.ts',
      'tests/workflow-node-log.test.tsx',
      'tests/collab-exec-panel-running.test.tsx',
      'tests/proactive-work-process-live.test.js',
      'tests/proactive-session-messages.test.js',
      'tests/employee-current-task.test.js',
      'tests/employee-process-running-status.test.ts',
      'tests/plan-flowchart.test.js',
      'tests/plan-flowchart-render.test.js',
      'tests/app-workflow-canvas-json.test.js',
      'tests/app-run-form.test.js',
      'tests/app-run-controls.test.js',
      'tests/app-workflow-step-bridge.test.js',
      'tests/app-publish-check.test.js',
      'tests/app-api-call-example.test.js',
      'tests/agent-caps-display.test.js',
      'tests/evoflow-intro-prompt.test.js',
      'tests/exploring-activity-group.test.js',
      'tests/window-live-exploring-pieces.test.js',
      'tests/live-stream-path.test.js',
      'tests/live-stream-tail.test.js',
      'tests/client-perf.test.js',
      'tests/client-perf-scenarios.test.js',
      'tests/verify-perf-report.test.js',
      'tests/verify-perf-stress.test.js',
      'tests/post-search-read-tools.test.js',
      'tests/stream-turn-engine.test.js',
      'tests/openai-stream-turn.test.js',
      'tests/agui-turn-reducer.test.js',
      'tests/agui-display-segments-snapshot.test.js',
      'tests/content-blocks.test.js',
      'tests/use-thread-history-live.test.js',
      'tests/resolve-live-stream-activity.test.js',
      'tests/session-runtime-store.test.js',
      'tests/session-rows-cap.test.js',
      'tests/user-timing-guard.test.js',
      'tests/bounded-buffer.test.js',
      'tests/session-execution.test.js',
      'tests/session-list-pin.test.js',
      'tests/session-list-dept-reselect.test.js',
      'tests/session-list-proactive-group.test.js',
      'tests/employee-dept-sections.test.js',
      'tests/employee-group-order-storage.test.ts',
      'tests/session-list-employee-orphan-prune.test.js',
      'tests/shell-running-preview.test.js',
      'tests/turn-text-isolation.test.js',
      'tests/ws-turn-slice.test.js',
      'tests/run-turn-gate.test.js',
      'tests/turn-strip-runtime.test.js',
      'tests/display-run-id.test.js',
      'tests/file-diff-util.test.js',
      'tests/file-edit-tool-fetch.test.js',
      'tests/stream-bump-scheduler.test.js',
      'tests/stream-bump-interval.test.js',
      'tests/stream-perf-verdict.test.ts',
      'tests/markdown-stream-paint.test.js',
      'tests/sse-frame-batch.test.js',
      'tests/stream-display-tick.test.js',
      'tests/markdown-render-client.test.js',
      'tests/stream-resume-gate.test.js',
      'tests/stream-reattach-cooldown.test.js',
      'tests/session-reattach.test.js',
      // 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
      // 死会话 404 风暴的失败退避；白名单不加进来等于没写测试（第33轮同坑）。
      'tests/session-reattach-failure-backoff.test.js',
      'tests/context-usage.test.js',
      'tests/conversation-compact-tip.test.ts',
      'tests/agent-trace-compaction.test.js',
      'tests/agent-avatar.test.js',
      'tests/app-icon.test.js',
      'tests/agent-tags.test.js',
      'tests/agent-source-options.test.js',
      'tests/ko-ask-model-badge.test.js',
      'tests/message-row-stream-display.test.js',
      'tests/message-row-stream-layout.test.js',
      'tests/message-row-display-plan-path.test.js',
      'tests/message-row-streaming.test.js',
      'tests/message-row-timeline.test.js',
      'tests/turn-display-phase.test.js',
      'tests/turn-timing.test.js',
      // 【self-evolution-bot · 2026-11-20 · 第91轮 · 模型:deepseek-v4.1-flash-1017】
      // 工具卡运行中耗时不动（结束才出现）的回归锚点。
      'tests/tool-card-live-elapsed.test.tsx',
      'tests/message-row-reasoning-display.test.js',
      'tests/reasoning-display-text.test.js',
      'tests/activity-fold-visible-content.test.js',
      'tests/fold-induced-scroll-away.test.js',
      'tests/gateway-warm-latch.test.js',
      'tests/app-server-client.test.js',
      'tests/merge-assistant-stream-row.test.js',
      'tests/collapse-same-turn-assistants.test.js',
      'tests/session-debug-turn-groups.test.js',
      'tests/pick-session-row-title.test.js',
      'tests/chat-layout-bottom-dock.test.js',
      // 【self-evolution-bot · 2026-11-21 · 第114轮 · 模型:deepseek-v4.1-flash-1017】
      // 右栏宽度随窗口重算：缩窗溢出实测 vw=960 被裁 216px（现网数字，见测试文件头）。
      'tests/chat-layout-right-panel-reflow.test.js',
      'tests/chat-pane-mode.test.ts',
      'tests/chat-ws-foreground.test.js',
      'tests/conversation-turn-session-busy.test.ts',
      'tests/v4-render-units-selector.test.ts',
      'tests/platform-media-turn-end.test.ts',
      'tests/home-live-activity.test.ts',
      'tests/task-runtime-health.test.js',
      'tests/system-prompt-sections.test.js',
      'tests/reconcile-last-assistant-from-history.test.js',
      'tests/operations-render.test.js',
      'tests/obs-dashboard.test.tsx',
      'tests/obs-payload-parse.test.js',
      'tests/knowledge-map-tree.test.js',
      'tests/knowledge-map-diagram.test.js',
      'tests/knowledge-map-node-status.test.js',
      'tests/knowledge-map-xmind-layout.test.js',
      // 【self-evolution-bot · 2026-11-18 · 第46轮 · 模型:deepseek-v4.1-flash-1017】
      // 删除悬空登记 'tests/knowledge-vault.test.js'：该文件在 2fb5298f（release 1.0.7）被删除，
      // 登记未同步。实测 `vitest run tests/knowledge-vault.test.js` 报
      // "No test files found, exiting with code 1" —— 白名单条目在、文件不在，
      // 任何按名过滤的调用都会被这条假账打成失败。判据同第35轮那条。
      'tests/knowledge-graph-layout.test.js',
      'tests/knowledge-graph-explore.test.js',
      'tests/background-voice.test.js',
      'tests/voice-listen-control.test.js',
      'tests/voice-reply-speech.test.js',
      'tests/xiaomi-voice-provider.test.js',
      'tests/speech-client-queue.test.js',
      'tests/goal-closure-local.test.js',
      'tests/license-nav.test.js',
      'tests/task-summary-outputs.test.js',
      // 【self-evolution-bot · 2026-11-22 · 第125轮 · 模型:deepseek-v4.1-flash】
      // 任务详情「对话」面板选源：不许把别处对话挂在任务名下，也不许把真执行记录漏掉。
      'tests/task-conversation-source.test.js',
      'tests/employee-pane-send-target.test.js',
      // 【self-evolution-bot · 2026-11-22 · 第127轮 · 模型:deepseek-v4.1-flash】
      // 平台排队的首条消息：面板忙时必须 hold（不许 return 丢消息），且只有发送成功才清签。
      'tests/pending-send-gate.test.js',
      'tests/pending-send-queue-session.test.ts',
      'tests/assets-file-prefetch.test.js',
      'tests/task-tree.test.js',
      'tests/ui-extension-manifest.test.js',
      'tests/markdown-document-view.test.js',
      'tests/decide-right-stage.test.js',
      'tests/publish-platform-entries.test.js',
      'tests/open-progress-from-panel-set.test.js',
      'tests/employee-process-round-switch.test.js',
      'tests/employee-process-dispatch-cta-e2e.test.js',
      'tests/shell-page-mount-table.test.js',
      // 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
      // 右栏「任务」签恒空：asList 只认顶层信封，错过 {success,data:{tasks}}。不登记 include 等于没写。
      'tests/tasks-center-compact-envelope.test.js',
      // 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
      // 工作流签绑错任务：显式 mainTaskId 被当前会话 thread 覆盖 → 标题串、节点 0。
      'tests/collab-workflow-stage-binding.test.ts',
      // 【self-evolution-bot · 2026-11-21 · 第111轮 · 模型:deepseek-v4.1-flash-1017】
      // 员工面板发送落到 task 会话 → 消息进任务时间线，对话面板永远看不到（现网 19:40 实证）。
      'tests/employee-pane-send-session-kind.test.js',
      // 【self-evolution-bot · 2026-11-21 · 第112轮 · 模型:deepseek-v4.1-flash-1017】
      // 护栏：子任务会话历史不得用裸 fetch（Tauri 下相对路径拿到 SPA 首页）。
      'tests/subtask-fetch-must-use-gateway.test.js',
      'tests/subtask-conversation-history.test.js',
      // 【self-evolution-bot · 2026-11-21 · 第113轮 · 模型:deepseek-v4.1-flash-1017】
      // codeViewer 是唯一没有错误边界的大面板：一个坏 source 打掉整个聊天区（本轮实测）。
      'tests/right-stage-codeviewer-error-boundary.test.js',
      'tests/right-stage-tab-layout.test.ts',
      'tests/right-stage-store-tabs.test.ts',
      // 【self-evolution-bot · 2026-11-23 · 第128轮 · 模型:deepseek-v4.1-flash】
      // 右栏「谁打开的」溯源：三态取值域 + 创建时定死 + 缺省兜底会话而非 user。
      // 用户原话「我在 A 打开了一个截图，但在别处看到却不知道是谁打开的，就容易错乱」。
      'tests/right-stage-opened-by.test.ts',
      'tests/right-stage-force-expand.test.js',
      'tests/right-stage-scope.test.ts',
      'tests/right-stage-artifacts-session-stamp.test.ts',
      // 【self-evolution-bot · 2026-11-21 · 第106轮 · 模型:deepseek-v4.1-flash-1017】
      // 为什么：expand=true 的 show 跨会话时必须写进用户眼前，此前被隔离分支吃掉了。
      'tests/right-stage-expand-cross-session.test.ts',
      'tests/bridge-theme-dark.test.ts',
      'tests/right-stage-force-mount.test.ts',
      'tests/right-stage-no-permanent-loading.test.ts',
      // 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
      // chat_send 单 owner：服务端已受理时前端不许再 pendingSend，否则同一句话两遍。
      'tests/employee-chat-send-single-owner.test.js',
      // 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】面板发送桥判据
      'tests/employee-pane-send-bridge.test.js',
      // 右栏「当前在看哪一页」上报 + 切到已有标签：用户明确要求可查、可切。
      'tests/right-stage-state-report.test.ts',
      'tests/right-stage-activate.test.ts',
      // 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
      // 新增：ui.close / ui.move 的前端分发（关单签、调顺序）。
      'tests/right-stage-close-move.test.ts',
      // 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
      // 接线层测试：custom 流 → applyRightStageAgUiCustom 的 key/target 透传。
      // 不登记进 include 等于没写（本仓 vitest 只跑 include 里的白名单）。
      'tests/right-stage-custom-stream-key-wiring.test.ts',
      // 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
      // 标题被兜底名覆盖 + 收起锁语义两处回归。
      'tests/right-stage-title-collapse-semantics.test.ts',
      // 【self-evolution-bot · 2026-11-20 · 第89轮 · 模型:deepseek-v4.1-flash-1017】
      // 不可用终态提示的 DOM 渲染用例：断言实际渲染文本里没有「加载中」。
      'tests/right-stage-unavailable-shell.test.tsx',
      'tests/right-stage-overlay-commit.test.ts',
      'tests/right-stage-session-persistence.test.ts',
      // 【self-evolution-bot · 2026-11-21 · 第104轮 · 模型:deepseek-v4.1-flash-1017】
      // 串台回归：CUA 截图自动开右栏的判据（尾轮 + 正在跑），
      // 以及截图标签必须只在自己会话可见。不登记进 include 等于没写。
      'tests/cua-screenshot-auto-open-gate.test.ts',
      'tests/browser-panel-node-repl-intent.test.js',
      // 主窗口 __evoflowPanel snapshot/click/fill（platform ui.panel /main-cdp）
      'tests/panel-api-snapshot.test.js',
      'tests/cua-glow-agui.test.js',
      'tests/cua-glow-ring-wiring.test.js',
      'tests/cua-glow-elapsed-page.test.js',
      // 【self-evolution-bot · 2026-11-22】drawStroke 内嵌 PowerShell 的参数名回归
      // （`$Pid` 是只读自动变量，撞上就整条笔画路径跑不通）。
      'tests/cua-stroke-ps-param.test.ts',
      'tests/cua-control-revoke-semantics.test.js',
      'tests/cua-release-on-chat-stop.test.js',
      'tests/platform-feedback.test.js',
      'tests/platform-workflow-progress.test.ts',
      'tests/platform-tool-title.test.ts',
      'tests/dept-group-handoff.test.js',
      'tests/dept-group-steward.test.js',
      'tests/dept-group-wake-queue.test.js',
      'tests/dept-group-nest-policy.test.js',
      'tests/dept-group-dispatch-status.test.js',
      'tests/dept-group-mentions.test.js',
      'tests/dept-group-transcript.test.js',
      // 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
      // 群近期上下文按 token 预算裁剪（用户拍板「不按天翻篇」）。不登记 = 这测试不存在。
      'tests/dept-group-context.test.js',
      // 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
      'tests/dept-group-wake-persist.test.js',
      // 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
      // 渲染期冒烟：tsc 抓不到渲染异常，必须真挂载组件看 DOM
      'tests/dept-group-chat-render.test.tsx',
      'tests/dept-group-format-body.test.js',
      'tests/dept-chat-list-cache.test.ts',
      'tests/dept-member-work-session.test.js',
      'tests/close-removed-entity-stage.test.js',
      'tests/builtin-action-labels.test.js',
      'tests/permission-tier.test.js',
      'tests/chat-host-route-toggle.test.js',
      'tests/idle-nav-warm.test.js',
      'tests/router-module-cache-key.test.js',
      'tests/shell-session-select-defer.test.js',
      'tests/stream-snapshot-store.test.js',
      'tests/repro-later-round-tools-vanish.test.js',
      'tests/replay-real-session-tools.test.js',
      'tests/merge-assistant-round3-vanish.test.ts',
      'tests/stream-compare-two-logs.test.ts',
      // 注：turn-start-ms-lock.test.ts / right-stage-hide-all.test.ts 曾被列入但
      // 未提交即被并行会话的 git clean 清掉，内容未恢复，暂移出 include。
      'tests/proactive-nav-chrome-macos.test.js',
      'tests/proactive-role-card-meta.test.js',
      'tests/mcp-binding-chip.test.js',
      'tests/mcp-connector-headers.test.js',
      'tests/user-facing-error.test.js',
      // 连发无回复：send_click 顶掉 sendTrace 后仍能识别上一轮无首帧
      'tests/chat-turn-timing-stalled.test.js',
      // 首帧响应按回合幂等：后台回合无 sendTrace 时每 delta 双 IPC 落盘的洪水（1.2 万条/日）
      'tests/chat-turn-timing-first-response-latch.test.js',
      // 发送水位线：正常收紧 / 异常留证 + 前后接口
      'tests/chat-turn-waterline.test.js',
      'tests/live-execution-busy.test.js',
      // 多会话钉住 V4 投影：peekStore + pin 租约，切回不冷开空白
      'tests/v4-pin-sessions.test.js',
      'tests/v4-session-keepwarm-cancel.test.ts',
      // 渲染内存水位 → pinMax / 投影软顶（normal=8 / high=4）
      'tests/renderer-memory-pressure.test.ts',
      // 从未打开：磁盘投影缓存 → sticky 先画
      'tests/v4-snapshot-disk-cache.test.ts',
      // stream-404 remint：旧投影改挂新 thread，避免冷开清空时间线
      'tests/v4-remint-rebind.test.ts',
      'tests/langgraph-thread-stale-epoch.test.ts',
      // 超大会话渲染层尾窗软顶（防 loadAllOlder / 长流式撑爆 window）
      'tests/projection-window-cap.test.ts',
      'tests/tip-soft-cap-latch.test.ts',
      // overflow/recovery 尾窗快照不得冲掉已 loadOlder 的更早行
      'tests/v4-preserve-older-on-tail-snapshot.test.ts',
      'tests/v4-userinput-visible-in-tail.test.ts',
      // 同 turn 工具 rowId 落在用户气泡前 → 不得先画「已工作」造成上下割裂
      'tests/v4-turn-user-first-order.test.ts',
      // user 行「先落库再发流」是 seq 不倒挂的唯一保证（第118轮现网 13 对倒挂）
      'tests/chat-send-user-row-order.test.js',
      'tests/v4-fold-health.test.ts',
      'tests/v4-display-order-health.test.ts',
      'tests/v4-running-text-interleave.test.ts',
      // 点停 → API → UI idle 的 sinceStopMs 闭环
      'tests/stream-stop-log.test.ts',
      'tests/run-page-load-resume.test.ts',
      'tests/settings-modal-tauri-drag.test.js',
      // 设置→已装资源：「已装产物」分组（BOT 合并 employees+agents 去重、extensions 叫「Agent应用」）
      'tests/installed-packs-artifact-labels.test.js',
      'tests/task-duration.test.js',
      'tests/replay-real-run-133609527d1f.test.js',
      'tests/replay-real-run-81320d61e8cc-diag.test.js',
      // 点开会话 → 上屏 全链路分段耗时诊断（openTrace）
      'tests/open-trace-stages.test.ts',
      // 右栏「Agent 应用」启动器（选已安装 UI 扩展 → 右侧开签）
      'tests/right-stage-agent-app-launcher.test.tsx',
      // 右栏 Agent 应用：先开签再起服务（冷启动不能卡住 UI）
      'tests/open-ui-extension-in-stage.test.ts',
      // chat-app-view 的 ctx 解构完整性（漏解构 → 运行时 ReferenceError）
      'tests/chat-app-view-ctx-destructure.test.ts',
      // 输入框 `/` 面板：命令清单（只留 /goal）+ 技能/插件两行布局
      'tests/composer-slash-menu.test.tsx',
      // 主窗口弹窗拦截（Agent 应用 iframe 的 window.open 不得弹到系统浏览器）
      'tests/main-popup-guard.test.ts',
      // 小V语音隐式开文件策略闸门（点名/产物/媒体开，内部资料兜底不开）
      'tests/file-auto-open-policy.test.js',
      // 工作流节点实时正文：LangGraph custom 通道必须转发 subagent_token_delta
      'tests/ws-subagent-token-delta.test.js',
      // 目标徽标 bridge：class store 的 subscribe 传参必须保持 this 绑定
      'tests/goal-status-badge-bridge.test.tsx',
      // V4 轮尾 token 用量串格式化（复刻旧版 ↑in ↓out · ⚡cacheRead）
      'tests/v4-assistant-usage-label.test.ts',
      // 渲染进程内存瞭望：投影行字节估算（2026-11-15 renderer 1.7GB 悬案的下次定罪探针）
      'tests/v4-projection-memory-probe.test.ts',
      // 视口调试「接口」页：只收录对话页相关 HTTP，并落盘入参/出参
      'tests/v4-viewport-api-tap.test.ts',
      'tests/v4-viewport-stream-tap.test.ts',
      // 滚轮页：已显示/全量条数文案 + hasOlder=0 时不得写「可自动拉更早」
      'tests/v4-viewport-scroll-tap.test.ts',
      // 视口异常表：流式落后窗 / loadOlder 不前进 / 用户气泡错位 / 绘画埋没
      'tests/v4-viewport-anomaly.test.ts',
      // V4 投递路径根因对账（HUB_AHEAD_NOTIFIED0 / NO_STORE_SUB…）——面板能定位才算修好。
      'tests/v4-path-probe.test.ts',
      'tests/v4-viewport-virtualization-probe.test.ts',
      // search_code_index 卡片：不得被 family=search 抢去渲染成不可展开的一行式块
      // 【self-evolution-bot · 2026-11-17 · 第33轮】新增用例必须登记，否则 vitest 根本不会跑它
      'tests/search-code-index-card.test.ts',
      // 【self-evolution-bot · 2026-11-17 · 第35轮】原登记 tests/plugin-settings-not-blank.test.ts，
      // 但该文件在磁盘上从未存在（上一轮上下文回写的假账）——登记物在、文件不在，
      // 会让任何按名过滤的 vitest 调用报 No test files found。此处删除悬空登记，
      // 由下面 5 个真实存在的用例覆盖同一意图。
      // 【self-evolution-bot · 2026-11-17 · 第35轮】插件市场 Tab 真实渲染（网关真实快照回放），
      // 断言插件名进入可视文本；不登记 = CI 里不存在。
      'tests/plugin-settings-render.test.tsx',
      // 【self-evolution-bot · 2026-11-17 · 第35轮】插件 Tab 初始化不得因渲染自激（按网关请求次数判）。
      'tests/plugin-settings-init-count.test.tsx',
      // 【self-evolution-bot · 2026-11-17 · 第35轮】接口失败时必须给可见文案（复刻真实 404 报案现场）。
      'tests/plugin-settings-failure.test.tsx',
      // 【self-evolution-bot · 2026-11-17 · 第35轮】加载中必须有可见文字（接口挂住时不得纯空白）。
      'tests/plugin-settings-loading-blank.test.tsx',
      // 【self-evolution-bot · 2026-11-17 · 第35轮】子树渲染抛错时不得静默空白（React 渲染期异常绕过 hub.js catch）。
      'tests/plugin-settings-render-crash.test.tsx',
    ],
  },
})

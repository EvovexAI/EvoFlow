/**
 * EvoFlow 桌面端 CSS 入口。
 *
 * v3.5 阶段 F1 commit 1：把全部 33 个 style/*.css + 1 个 global-assistant css
 * 从 main.js 移到本文件,main.js 仅留 `import './boot/0-styles.js'`。
 *
 * 顺序保持原样(全局 reset → variables → layout → components → pages →
 * 主题/外观/液体玻璃),改了顺序可能影响 z-index / 优先级。
 */

// 基础变量 / 重置 / 布局
import '../style/variables.css'
import '../style/reset.css'
import '../style/layout.css'
import '../style/components.css'
import '../style/pages.css'
// 功能模块样式
import '../style/ef-side-drawer.css'
import '../style/app-workflow-canvas.css'
import '../style/app-workflow-studio-v2.css'
import '../style/apps.css'
import '../style/kb-wiki.css'
import '../style/list-pager.css'
import '../style/webui-login.css'
import '../style/chat.css'
import '../style/react-chat.css'
import '../style/platform-feedback.css'
import '../style/chat-redesign.css'
import '../style/enterprise-workspace.css'
import '../style/hover-bubble.css'
import '../style/agents.css'
import '../style/agent-avatar.css'
import '../style/debug.css'
import '../style/agent-trace.css'
import '../style/obs-dashboard.css'
import '../style/ai-drawer.css'
import '../style/cron.css'
import '../style/license-keys.css'
import '../style/tauri-titlebar.css'
import '../style/proactive.css'
import '../style/license.css'
import '../components/global-assistant/global-assistant.css'
// 主题 / 外观 / 特殊效果
import '../style/ai-roundtable.css'
import '../style/liquid-glass.css'
import '../style/sci-fi-theme.css'
import '../style/theme-surfaces.css'
import '../style/assets-page.css'
import '../style/theme-readability.css'
import '../style/ef-module-head.css'
import '../style/ef-panel-head.css'
import '../style/chat-summary-panel.css'

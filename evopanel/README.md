<p align="center">
  <img src="docs/assets/logo-brand.png" width="360" alt="EvoPanel">
</p>

<p align="center">
  EvoFlow AI Agent 框架的可视化管理面板<br>
  内置 AI 助手 · 模型配置 · 实时聊天 · 任务编排 · 多智能体协作
</p>

<p align="center">
  <strong>🇨🇳 中文</strong> | <a href="README.en.md">🇺🇸 English</a>
</p>

<p align="center">
  <a href="https://github.com/EvovexAI/EvoFlow/releases/latest">
    <img src="https://img.shields.io/github/v/release/EvovexAI/EvoFlow?style=flat-square&color=6366f1" alt="Release">
  </a>
  <a href="https://github.com/EvovexAI/EvoFlow/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-Non--Commercial-orange.svg?style=flat-square" alt="License">
  </a>
</p>

---

## ✨ 功能特性

### 🤖 AI 助手
- 内置独立 AI 助手,支持 4 种操作模式 (聊天/规划/执行/无限)
- 8 大工具:系统信息、命令执行、文件读写、进程查看、端口检测
- 交互式问答 (单选/多选/文本输入)
- 自动诊断配置、排查问题、修复错误

### 💬 实时聊天
- 流式响应,Markdown 渲染
- 多模态图片识别 (粘贴截图/拖拽图片)
- 会话管理,支持 /think /verbose /reasoning 命令
- React 组件实现,流畅的用户体验

### 🧠 模型配置
- 多服务商管理 (OpenAI/DeepSeek/阿里通义/Ollama 等)
- 模型增删改查
- 批量连通性测试
- 延迟检测
- 拖拽排序,自动保存,撤销

### 📋 任务中心
- 创建复杂任务,AI 自动拆解并协调多 Agent 执行
- 任务列表管理 (搜索/筛选/批量操作)
- 任务详情与子任务监控
- 实时进度追踪与状态查看
- 批量启动/暂停/删除

### 🤝 多智能体协作 (项目)
- 项目管理:创建/编辑/删除协作项目
- Supervisor 启动与控制
- 任务规划与编排 (Plan)
- 多 Agent 协同执行
- 项目详情与任务监控

### 🤖 Agent 管理
- Agent 增删改查
- 身份编辑 (SOUL/IDENTITY/USER/AGENTS)
- 独立模型配置
- 工作区管理
- Agent Trace 调试视图

### 🛠️ 工具与技能
- 工具管理:启用/禁用/配置
- 技能系统:SKILL.md 格式
- 技能市场/远程安装 (规划中)

### 🌐 消息渠道
- 统一管理多种消息接入:
  - 飞书/Lark (企业自建应用)
  - 钉钉 (Stream 模式)
  - Telegram Bot
  - Discord Bot
- 支持同平台多 Agent 绑定
- 配对审批流程

### 🖥️ 目标（Goal）
- 在**实时聊天**输入栏打开 **[目标](https://www.evovexai.com/docs/chat/goal)** 面板，配置并启动/停止后台目标运行（与「记忆」等不同：目标跑在独立线程与策略下）。
- **模型可发起目标提议**（通过 `propose_goal` 工具返回方案），界面出现**确认条**：可一键填入并开始、仅填入面板、或关闭；确认后再真正执行。
- 与 **飞书** 等 IM 配合时：目标**结束**可向对应会话推送 **Markdown 结果小结**（依赖服务端网关与渠道配置）；飞书里发 **「开始」「确认」** 等短词可通知**在线** EvoPanel 应用方案并启动（多路订阅与切会话等行为以当前版本为准）。
- 完整说明与进阶参数见官网文档：[目标](https://www.evovexai.com/docs/chat/goal)。

### ⏰ 自动化
- Cron 定时执行
- 可视化时间选择器
- 支持多渠道推送
- 任务执行历史查看
- 快捷预设 (每小时/每天/每周)

### 📝 记忆管理
- 记忆文件查看/编辑
- 分类管理 (工作记忆/记忆归档/核心文件)
- ZIP 导出
- Agent 记忆隔离

### 🎨 用户体验
- 明暗主题自动切换
- 响应式设计 (桌面/移动端)
- 访问密码保护
- 自动更新检测
- 多语言支持 (25+ 语言)

---

## 🚀 快速开始

### 下载安装

前往 [Releases](https://github.com/EvovexAI/EvoFlow/releases/latest) 下载最新版本:

| 平台 | 安装包 |
|------|--------|
| macOS (Apple Silicon) | `EvoFlow_x.x.x_aarch64.dmg` |
| macOS (Intel) | `EvoFlow_x.x.x_x64.dmg` |
| Windows | `EvoFlow_x.x.x_x64-setup.exe` |
| Linux (AppImage) | `EvoPanel_x.x.x_amd64.AppImage` |
| Linux (DEB) | `EvoPanel_x.x.x_amd64.deb` |

### 首次使用

1. **配置 AI 模型**: 首次启动会自动引导你添加 AI 服务商 (API Key)
2. **开始聊天**: 配置完成后,前往聊天页面,选择模型即可开始对话

### Linux 服务器部署 (Web 版)

```bash
curl -fsSL https://raw.githubusercontent.com/EvovexAI/EvoFlow/main/scripts/deploy.sh | bash -s -- up

```

部署完成后访问 `http://服务器IP:1420`

### Docker 部署

```bash
docker run -d --name evopanel --restart unless-stopped \
  -p 1420:1420 -v evopanel-data:/root/.evopanel \
  node:22-slim \
  sh -c "npm install -g @EvovexAI/EvoFlow-zh && \
    git clone https://github.com/EvovexAI/EvoFlow.git /app && \
    cd /app && npm install && npm run build && npm run serve"
```

---

## 🛠️ 开发指南

### 环境要求

- **Node.js** >= 18
- **Rust** (stable) - 仅桌面开发需要
- Tauri v2 系统依赖 - 仅桌面开发需要

### 桌面开发 (完整功能)

```bash
git clone https://github.com/EvovexAI/EvoFlow.git
cd evopanel
npm install

# 启动开发环境
npm run dev:tauri
```

### Web 开发 (无需 Rust)

```bash
# 仅开发前端
npm run dev

# 启动完整 Web 服务
npm run serve:win
```

### 构建

```bash
# 构建 Release 安装包 (包含后端)
npm run build:tauri

# Debug 构建 (快速测试)
npm run build:debug

# 打包
npm run package

# 与 install.bat 相同入口（CI 亦用此命令打 Windows 一体包）
npm run build:desktop:win
```

若 EvoPanel 位于 **EvoFlow 主仓库** 的 `evopanel/` 目录：Windows 本地打包可用根目录 **`install.bat`**；对外安装包见 [EvovexAI/EvoFlow Releases](https://github.com/EvovexAI/EvoFlow/releases)。

详细脚本说明见 [scripts/README.md](scripts/README.md)

---

会话调试入口未启用。请在配置文件中添加：

"developer": {
  "showSessionDebug": true,
  "enableDevtools": true
}
路径：~/.evoflow/evopanel.json（Windows 为用户目录下 .evoflow\evopanel.json），保存后重启 EvoPanel。

正式安装包默认关闭；本地开发构建默认开启。


## 📖 文档

- [安装指南](docs/install.md)
- [Docker 部署指南](docs/docker-deploy.md)
- [Linux 部署指南](docs/armbian-deploy.md)
- [消息渠道配置](docs/channels.md)
- [常见问题](docs/faq.md)

---

## 🏗️ 技术架构

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端 | Vanilla JS + React + Vite | 零框架依赖,轻量快速 |
| 后端 | Rust + Tauri v2 | 原生性能,跨平台打包 |
| 通信 | Tauri IPC + WebSocket | 前后端桥接,实时通信 |
| 样式 | 纯 CSS (CSS Variables) | 暗色/亮色主题,玻璃拟态风格 |

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。贡献流程详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 📄 许可证

版权所有 © 2026 景银泰（EvovexAI）。[PolyForm Noncommercial License 1.0.0](../LICENSE)（源码可见、非商业使用；商用联系 [cloud@evovexai.com](mailto:cloud@evovexai.com)；上游组件见 [NOTICE](../NOTICE)）

---

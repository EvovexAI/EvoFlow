**EvoFlow v1.1.2 — 官方插件 bundle 打包与 CI / 主动引擎与飞书通知 / 会话执行状态与忙因日志 / prompt 动态分层与 turn timing / 经验工具移除与 admin 路由整合 / lean gateway 打包硬化**

本版覆盖自 **1.1.1** 以来合并进主线的全部用户可感知变更。

### 新增

- **官方插件 bundle 打包**：macOS + Windows 双平台 bundle + CI workflows；无插件源时自动 stub 使构建继续；marketplace seed 硬化 + builtin 插件注册
- **插件服务**：plugin service + builtin registration + catalog cache 细化
- **主动引擎**：proactive engine + 飞书通知投递可交付物卡片 + supervisor 工具 + 任务重试叶子 + 资产记忆门控
- **会话执行状态**：execution state + busy reason log + context compaction + workspace info rail + 续流门控 + 阶段工具
- **prompt 动态分层 + turn timing**：prompt blocks + turn timing + message row 渲染更新
- **内存与可观测**：memory live footer + session repos + eval_metrics + 图片内联预览
- **其他**：code comment cards + trae tool + deliverable cards + stream perf + 平台注册文档同步测试

### 变更

- **经验工具移除**：旧经验库已迁移至资产中心，下线 `experience` admin / cli / middleware
- **admin 路由整合**：agents / approvals / apps / automation / employees / knowledge / skills / tasks / platform_* 整合
- **collab/app 生成器**：extractor / generator / runner / schema 更新
- **lean gateway 打包**：assert 脚本 + pyarmor / gateway spec 硬化
- **knowledge / assets**：owned retrieve / service + craft / migrate / user_profile_dims 更新
- **前端**：agui-turn-reducer 更新；新增 logo.ico
- **文档**：admin-external（README / cli-cheatsheet / http-platform / playbooks）+ system-verification 刷新

### 修复

- CI：PS1 脚本非 ASCII 字符（em-dash / 箭道箭头 / 省略号）在非 UTF-8 环境乱码破坏语法
- CI：无官方插件源时 fetch bundle 不再 throw，改生成 stub

### 覆盖安装即可

无数据迁移。从 **1.1.1** 覆盖安装至 **1.1.2**。
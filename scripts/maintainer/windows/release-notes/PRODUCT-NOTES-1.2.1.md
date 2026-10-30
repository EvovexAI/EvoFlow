**EvoFlow v1.2.1 — 修复打开知识库后其它页面「访问不上」**

本版是相对 **1.2.0** 的稳定性补丁（覆盖安装即可）。

### 修复

- **Gateway 假死**：右侧/知识库文件树触发的 `git status` / `check-ignore` 在 Windows 上可能卡住线程池，健康检查超时，其它页面看起来像后端挂了；现改为独立 git 线程池、到期强杀子进程，过载时直接跳过探测
- **内置知识库**：打开随包 user-guide 等 `builtin_knowledge_vaults` 目录时不再调用 git
- **诊断噪声**：长连接 SSE（panel-stream / V4 frames）不再被当成「卡住的 REST」刷 hang 日志
- **黑窗**：Windows 下 git 探测不再弹出控制台黑窗口

### 覆盖安装即可

无数据迁移。从 **1.2.0** 覆盖安装至 **1.2.1**。

# 记忆管理

> **首选入口已改为「资产中心」**（侧栏 → 资产中心，`#/assets`）。  
> 概念与日常用法见：[资产中心](../../explanation/asset-center.md) · [操作指南](asset-center.md)。
>
> **比如你告诉 AI「我叫小明，喜欢用 Python」**：AI 会写成资产文件里的事实。下次聊天它仍知道你的偏好。你只需偶尔打开资产中心翻看或改错字。

## 前置条件

- EvoFlow 已运行
- 记忆 / 资产整理默认开启（见仓库根目录 `.env.example` 中 `EVOFLOW_ASSET_*`；一般无需改）

## 记忆是什么

简单说，就是 AI 记住的「关于你的事实」——名字、工作背景、偏好等。用户、Agent、员工各自有一份资产目录，互不污染。

> 记忆存的是「偏好和事实」，跟[上传文档（RAG）](document-knowledge-base.md)（存文档内容）和[知识库（Vault）](knowledge-vault.md)（存笔记）不同。

工作原理：对话结束后，系统会异步整理有用信息写入资产文件；你也可以在对话里明确说「记住……」。

## 在面板中管理

- **侧栏 → 资产中心**：浏览画像 / 记忆 / 经验 / 反思 / 专长；统计用量与冷资产
- **对话侧栏快捷**：记录 / 沉淀经验 / 反思
- 旧「记忆」导航会转到资产中心记忆 Tab

### 通过 API 查询（进阶）

```bash
# 资产实体与树
curl "http://localhost:8001/api/assets/entities"
curl "http://localhost:8001/api/assets/tree?entityType=user&entityId=user&path=memory"
```

## 常见问题

**Q: 记忆没有更新？**  
多聊几轮后稍等防抖时间；确认对话里有真实用户消息与最终回复。可到资产中心「统计」看待整合数量，必要时点「整合 inbox」。

**Q: 记错了怎么办？**  
在资产中心打开对应 Markdown 改正并保存，或删除过时文件。

**Q: 记忆和知识库有啥区别？**  
记忆/资产 = 个人与岗位沉淀；知识库 = 你整理的文档与笔记。详见[资产中心](../../explanation/asset-center.md)。

## 相关阅读

- [资产中心概念](../../explanation/asset-center.md)
- [资产中心操作](asset-center.md)
- [知识库](knowledge-vault.md)

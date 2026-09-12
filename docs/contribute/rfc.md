# RFC：较大改动怎么提案

对 **Runtime / Gateway / 协议 / 破坏性配置** 等会影响很多人的改动，先写短 RFC，再写代码。文档错别字、小 bug、单个 Skill **不需要** RFC。

## 何时开 RFC

| 需要 | 不需要 |
|------|--------|
| 新一等工具原语、规划语义变更 | 文档 / FAQ / 截图 |
| 新 IM 渠道协议或鉴权模型 | 单个 `skills/public/` Skill |
| 破坏性配置 / 迁移 | 局部 UI 文案或样式 |
| 跨 `app` 与 `evoflow` 的边界调整 | 明确复现的小 bugfix |

不确定时：先开 [Discussion](https://github.com/EvovexAI/EvoFlow/discussions)，维护者会告诉你要不要升格为 RFC Issue。

## 流程

1. **Discussion 或 Issue（标签建议 `rfc`）**  
   标题：`[RFC] 简短主题`  
2. **正文用下面模板**（可直接粘贴）  
3. **至少等待一轮维护者反馈**（目标：约一周内有人回复；无 SLA 保证）  
4. **达成方向后再开实现 PR**，PR 描述里链接 RFC  
5. 实现 PR 仍走 [分支与检查](branching-and-checks.md)；RFC **不等于**已批准合入

## 模板

```markdown
## 摘要
用三句话说明要解决什么、打算怎么做。

## 动机
今天的痛点是什么？谁会受益？

## 方案概要
- 改哪些子系统（见 [仓库地图](repo-map.md)）
- 用户 / 配置可见变化
- 是否破坏兼容；如何迁移

## 备选方案
列 1～2 个不做或另做的选项，以及为何不选。

## 风险与测试
安全、性能、跨平台；计划怎么测。

## 开放问题
还没想清楚的点，方便 Review 聚焦。
```

## 相关

- [Discussions 与 Good First Issue](discussions-and-good-first-issues.md)
- [SUPPORT.md](../../SUPPORT.md)
- [MAINTAINERS.md](../../MAINTAINERS.md)

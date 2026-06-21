# 技能系统设计原理

## 背景

Agent 的能力由工具组成，但工具是通用的。要让 Agent 擅长做特定类型的工作（如数据分析、PDF 处理、视频生成），需要给它提供领域特定的指令和指导。技能（Skills）系统就是为此设计的——每个技能是一个 `SKILL.md` 文件，包含该领域的专业知识和操作指南。

## 设计理念

技能系统的核心设计原则是**声明式、按需加载、可组合**：

1. **声明式**：技能通过 YAML frontmatter 声明元数据，无需代码
2. **按需加载**：只有启用的技能才会被加载到系统提示中
3. **可组合**：多个技能可以同时启用，Agent 自行判断何时使用哪个

## 技能格式

每个技能是一个目录，包含一个 `SKILL.md` 文件：

```markdown
---
name: skill-name
description: 技能描述
license: MIT
allowed-tools: ["bash", "read_file", "write_file"]

# Skill Name

技能的详细指令和操作指南...
```

### Frontmatter 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 技能标识符（hyphen-case） |
| `description` | string | 是 | 技能描述，用于 UI 展示 |
| `license` | string | 否 | 许可证（如 MIT） |
| `allowed-tools` | list | 否 | 技能允许使用的工具白名单 |

## 技能发现与加载

```
技能发现流程：
1. 扫描 skills/public/ 目录 → 所有公开技能
2. 扫描 skills/custom/ 目录 → 所有自定义技能
3. 读取 extensions_config.json → 确定启用/禁用状态
4. 加载已启用技能的 SKILL.md 内容
5. 通过 apply_prompt_template() 注入系统提示
```

### 缓存机制

技能列表通过 mtime 检测配置文件变更：

- 首次扫描后缓存技能列表
- `extensions_config.json` 修改后自动失效
- 无需重启进程即可启用/禁用技能

## 技能启用/禁用

技能的启用状态由 `extensions_config.json` 中的 `skills` 字段控制：

```json
{
  "skills": {
    "data-analysis": { "enabled": true },
    "pdf": { "enabled": true },
    "byted-ark-seedream-skill": { "enabled": true },
    "media-production": { "enabled": false }
  }
}
```

通过 API 动态修改：

```bash
curl -X PUT http://localhost:8001/api/skills/{name} \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

## 技能安装

`.skill` 压缩包可以通过 API 安装：

```bash
curl -X POST http://localhost:8001/api/skills/install \
  -F "file=@my-skill.skill"
```

安装后解压到 `skills/custom/` 目录并自动注册。

## 技能在系统提示中的注入

启用技能的 `SKILL.md` 内容会被注入到系统提示中：

```
## 可用技能

以下是你可以使用的技能：

### data-analysis
（SKILL.md 的完整内容...）

### pdf
（SKILL.md 的完整内容...）
```

这使得 Agent 了解每个技能的能力和使用方法，在适当的场景下自主选择。

## 技能规模

EvoFlow 内置 50+ 个公开技能，覆盖以下领域：

| 领域 | 技能数量 | 示例 |
|------|----------|------|
| 数据与分析 | 5+ | data-analysis, chart-visualization, deep-research |
| 文档处理 | 4+ | pdf, docx, pptx, xlsx |
| 开发与编码 | 4+ | coding-agent, frontend-design, browser, playwright |
| 媒体生成 | 6+ | byted-ark-seedream-skill, media-production, agnes-media-generation, wan-media-generation, kling-media-generation, ppt-generation |
| 自定义 | 可扩展 | 用户自行添加 |

## 与其他方案的比较

| 方案 | 格式 | 加载方式 | 启用控制 |
|------|------|----------|----------|
| 硬编码指令 | 代码中 | 始终加载 | 无 |
| 工具定义 | JSON Schema | 动态 | 工具级别 |
| EvoFlow 技能 | SKILL.md (Markdown) | 按需 | 技能级别 |

SKILL.md 格式的优势是：
- 人类可读可编辑，不需要编程
- 可以包含丰富的领域知识（不仅是工具调用规则）
- 支持许可证声明（适合开源社区分享）

## 延伸阅读

- [skills-reference.md](../reference/skills-reference.md) - 技能列表
- [add-skill.md](../tutorials/add-skill.md) - 添加自定义技能教程
- [skills-reference.md](../reference/skills-reference.md) — 技能参考；实操见 [add-skill.md](../tutorials/add-skill.md)

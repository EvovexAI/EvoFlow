---
name: plan-video-production
description: 在 Plan 协作（任务协作模式）中按结构化流程完成短片视频制作：先询问用户需求，确认后直接用 plan 工具将全部工种（编剧、视觉策划、美术、导演、后期）纳入步骤规划，串行执行。
---

# Plan 视频制作技能

## 适用范围

**前提**：当前已开启 Plan 协作（`scenario(activate, plan)` 已激活），需要进行包含视觉/视频产出（生图、短片、配音、字幕）的任务。

**厂商选择**：生图读 **byted-ark-seedream-skill**；生视频读 **media-production** 脚本（火山 Seedance）。其它厂商见 **agnes-media-generation** / **wan-media-generation** / **kling-media-generation**。

## 凭据（环境变量）

在 **设置 → 环境变量** 添加技能要求的 KEY=VALUE（如 `VOLCENGINE_API_KEY` / `ARK_API_KEY`）。也可在 **设置 → 模型 → 创意媒体** 填其它厂商 Key。

| 能力 | 常用 KEY | 技能 |
|------|----------|------|
| 生图 | `VOLCENGINE_API_KEY` / `ARK_API_KEY` | `byted-ark-seedream-skill` |
| 生视频 | 同上 | `media-production` |
| Agnes | `AGNES_API_KEY` | `agnes-media-generation` |

**核心变更**：所有媒体工种（编剧、视觉策划、美术、导演、后期）**全部在 `plan(goal, steps[])` 的 steps 中通过 `assigned_agent` 指定**，plan 落库后用户确认即进入 executing 串行执行，不再在 plan 之外单独委派 subagent。

## 工作流

```
用户表达需求
     ↓
询问并确认用户需求（主题、时长、风格、画幅等）
     ↓
直接用 plan(goal, steps[]) 规划
  step 1: media-screenwriter  — 剧本/分镜/口播
  step 2: media-visual-planner — 生图 prompt
  step 3: media-artist        — 生成关键帧
  step 4: media-video-director — 出片 + 原生配音
  step 5: media-post          — 硬字幕
     ↓
用户确认 → 执行（串行，每步验收）
```

## 操作步骤

### 第一步：询问用户需求

主动向用户收集以下信息：

| 问题 | 示例 |
|------|------|
| 视频主题/产品/内容是什么？ | 新款智能手表宣传 |
| 目标时长？ | 15 秒 / 30 秒 |
| 视觉风格？ | 科技感 / 温暖 / 国风 |
| 画幅比例？ | 16:9 / 9:16 竖屏 |
| 口播文案方向？ | 功能亮点 + 品牌 slogan |
| 是否有参考素材？ | 参考图 / 竞品视频 |

### 第二步：确认后直接 plan

用户确认需求后，直接用 `plan` 工具将全部步骤写入结构化计划：

```
plan(
  goal="制作一支 15 秒产品宣传短片，主题：xxx，风格：xxx",
  steps=[
    {
      "step_id": 1,
      "description": "编剧撰写 production brief，包含 logline、分镜、口播稿",
      "assigned_agent": "media-screenwriter",
      "expected_output": "outputs/production-brief.md",
      "acceptance_criteria": "包含 User intent、logline、visual style、shot list、narration script"
    },
    {
      "step_id": 2,
      "description": "视觉策划将分镜转为生图 prompt",
      "assigned_agent": "media-visual-planner",
      "expected_output": "outputs/shot-prompts.json",
      "depends_on": [1]
    },
    {
      "step_id": 3,
      "description": "美术生成首帧关键帧图片",
      "assigned_agent": "media-artist",
      "expected_output": "outputs 内 PNG 关键帧",
      "depends_on": [2]
    },
    {
      "step_id": 4,
      "description": "视频导演生成带原生配音的 MP4",
      "assigned_agent": "media-video-director",
      "expected_output": "outputs/*.mp4",
      "depends_on": [3]
    },
    {
      "step_id": 5,
      "description": "后期加硬字幕，交付最终 MP4",
      "assigned_agent": "media-post",
      "expected_output": "outputs/*-subtitled.mp4",
      "depends_on": [4]
    }
  ],
  flowchart_mermaid="..."
)
```

### 第三步：用户确认执行

plan 落库后用户确认"开始执行"，进入 executing 阶段，各步骤按依赖顺序串行执行，每步完成后主 Agent 验收产物再进入下一步。

## 媒体子智能体清单

| assigned_agent | 职责 | 核心工具 |
|------|------|---------|
| `media-screenwriter` | 写剧本、分镜、口播稿 | read_file, write_to_file |
| `media-visual-planner` | 写生图 prompt | read_file, write_to_file |
| `media-artist` | Seedream 生图（jimeng） | read_file, terminal → `scripts/image_generate.py` |
| `media-video-director` | Seedance 图生视频 + 原生配音 | read_file, terminal → `scripts/video_generate.py`, `task_wait.py` |
| `media-post` | SRT 字幕 + ffmpeg 硬字幕 | read_file, terminal → `scripts/subtitle_build.py`, `subtitle_burn.py` |

**注意**：不要把 `media-voice-director` 放进步骤——Seedance 已原生带声（`generate_audio=true` 默认开）。

## 技术栈

脚本目录：`skills/public/media-production/scripts/`（须先读 **media-production** skill）

| 能力 | 脚本 | provider |
|------|------|----------|
| 生图 | `image_generate.py` | `jimeng`（火山方舟 Seedream） |
| 生视频 | `video_generate.py` + `task_wait.py` | `jimeng`（火山方舟 Seedance, 默认带声） |
| 字幕 | `subtitle_build.py` + `subtitle_burn.py` | 本地 ffmpeg |

**失败处理**：jimeng 失败后**禁止**自动换 `wan`/`kling`，提示用户开通 Ark 模型接入点。同参数失败最多重试 1 次。

## 常见错误

- 在 plan 模式下主会话直接跑 `image_generate.py` → 应由 plan 步骤里的 `media-artist` 等工种执行
- 在 plan 步骤外单独委派 subagent → 所有工种应写在 plan steps 的 `assigned_agent` 中
- 跳过 `task_wait.py` → 视频生成未完成就交付
- 默认流水线仍委派 `media-voice-director` → Seedance 已原生带声，多余
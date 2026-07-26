# 短剧工作台：开源对照仓

> 只读对照，**不整仓 fork / 不合并进产品仓**。产品落点：Infinite-Canvas 分镜工坊（Step5 出片 + Step1 生剧本）。

## 本机路径

`D:\dev\github\_refs\short-drama\`

| 目录 | 上游 | License | 用途 |
|------|------|---------|------|
| `LocalMiniDrama` | [xuanyustudio/LocalMiniDrama](https://github.com/xuanyustudio/LocalMiniDrama) | MIT | **主对照**：八步流程、镜级字段、Seedance `@图片N`、尾帧衔接、列表+画布 |
| `Toonflow-app` | [HBAI-Ltd/Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app) | Apache-2.0 | ScriptAgent / ProductionAgent 拆步 |
| `ArcReel` | [arcreel/arcreel](https://github.com/arcreel/arcreel) | **AGPL-3.0** | 已浅克隆；只看架构；**禁止抄代码进主仓** |
| `Seedance2.0-Storyboard-Planner` | [HenryZ838978/…](https://github.com/HenryZ838978/Seedance2.0-Storyboard-Planner) | 见 LICENSE | 镜卡片：景别/运镜/首尾帧/转场 |
| `xiakeman-ai-short-drama` | [XiakeMan777/…](https://github.com/XiakeMan777/xiakeman-ai-short-drama) | Other | Shot Sheet / 配音合成（后置） |

产品基线：`D:\dev\github\_refs\ai-canvas\Infinite-Canvas`（amiibot 导演工坊）。

## 字段对照（最小集 → 我们的 `frames[]`）

| LocalMiniDrama / Planner 概念 | 我们字段 | Step5 MVP |
|------------------------------|----------|-----------|
| 动作 / 画面描述 | `action_description` | 已有 |
| 台词 | `dialogue` | 已有 |
| 运镜 | `camera_movement` | 已有 |
| 分镜静帧 | `image_url` / `image_prompt` | 已有 |
| 视频片段 | `video_url` | **新增** |
| 视频提示词 | `video_prompt` | **新增** |
| 时长 4–15s | `duration_sec` | **新增** |
| Seedance 模式 | `seedance_mode` (`single_image` / `first_last_frame`) | **新增** |
| 尾帧接力 / 接着拍 | `continuity_from_frame_id` | **新增** |
| 景别（可选） | `shot_size` | **新增（可选）** |
| 生成任务状态 | `video_task_status` / `video_error` | **新增** |
| 场景时空变体 | scene.`variants[].time_label` + frame.`scene_variant_id` | Phase C |

## 可借鉴 / 禁止

| 可借鉴 | 禁止 |
|--------|------|
| 镜级字段、续镜交互、批量重试 | 整仓替换 Vue/Electron UI |
| Seedance 多图参考语义（落到 Agent Plan content[]） | ArcReel 源码进产品（AGPL） |
| 故事生成多步 prompt（角色→大纲→剧本） | 对方供应商通道 / API Key 适配层 |

## Step5 最小字段集（已裁剪）

MVP 只强制：`video_url`、`video_prompt`、`duration_sec`、`seedance_mode`、`continuity_from_frame_id`。  
景别 `shot_size` 可选；720° / 剪映 / 擦字幕不做。

---
name: media-production
description: Multi-agent short-video production (producer delegates to media crew subagents) or solo fast path. Default Volcengine Ark scripts via media-production; image via byted-ark-seedream-skill. Read fully before creative work.
---

# Media Production Skill

> **厂商与 API**：生图读 **byted-ark-seedream-skill**；生视频读本技能 `scripts/`（火山 Seedance）。其它厂商：Agnes → **agnes-media-generation**；万相 → **wan-media-generation**；可灵 → **kling-media-generation**。

## 凭据（环境变量）

**设置 → 环境变量** 添加 `VOLCENGINE_API_KEY` 或 `ARK_API_KEY`。

## Default mode: multi-agent crew (recommended)

Activate scenario **`plan`** when using plan-video-production. For media execution, run provider scripts via **`terminal`**.

**You must NOT run media scripts on the main thread** for full narrated videos (except when user explicitly asks for a **quick solo** poster or one-shot clip). Media execution uses **`terminal`** + scripts under this skill (see below).

Delegate in order via **`subagent`**. Wait for each step to finish; **`read_file`** / **`list_dir`** to verify `outputs/` before the next delegation.

| Step | subagent_type | Delivers |
|------|---------------|----------|
| 1 | `media-screenwriter` | `outputs/production-brief.md` |
| 2 | `media-visual-planner` | `outputs/shot-prompts.json` |
| 3 | `media-artist` | keyframe in `outputs/` (`scripts/image_generate.py`, jimeng) |
| 4 | `media-video-director` | `outputs/*.mp4`（`scripts/video_generate.py` + `task_wait.py`，Seedance 原生配音） |
| 5 | `media-post` | `*-subtitled.mp4` + present |

**不要**默认委派 `media-voice-director` — Seedance 在视频 prompt 里写口播/对白即可，无需单独 TTS。

### Producer checklist

1. Confirm session workspace (artifacts → `outputs/`); read **byted-ark-seedream-skill** (生图) and this skill (生视频脚本).
2. Summarize user goal in one message, then start **step 1** (do not skip writer for full narrated videos).
3. Each `subagent` prompt must include: **用户意图（原文摘要）**、paths from prior steps、aspect ratio、provider **`jimeng`**；并强调 **贴题、克制、镜头与口播前后衔接**（见下节）。
4. After each subagent: verify expected files exist; if missing, retry **same** subagent once with clearer prompt.
5. Final delivery: cite `@@outputs/…@@` in reply from **media-post** or producer after reading final path.

### 创意质量标准（委派时务必写入 prompt）

| 维度 | 要求 |
|------|------|
| **贴题** | 一切内容服务用户主题/产品/情绪；不擅自改题、不加无关戏 |
| **想象力** | 细节与氛围可丰富，但每一镜、每一句都能回扣用户意图 |
| **克制** | 避免浮夸特效、无关元素、空洞「史诗/大片」堆砌（除非用户要） |
| **画面衔接** | 同一人物/场景/色调贯穿；分镜是递进关系，不是无关素材拼贴 |
| **口播衔接** | 声画同步；口播段与段自然连贯，像讲同一件事，不说与画面无关的话 |

### subagent prompt template（copy pattern）

```
用户意图：<用户原话或制片归纳，必填>
主题：<…>
画幅：16:9 或 9:16
上游文件：outputs/production-brief.md（若适用）
任务：<本工种具体交付>
质量要求：贴题、克制不浮夸、画面与口播前后衔接、声画一致
约束：provider=jimeng；产物必须落在 outputs/
```

---

## Solo fast path (exception only)

Use when user says **快速** / **一张图** / **不要分工** / **simple poster**.

Single thread may run scripts via **`terminal`**:

1. `scripts/image_generate.py` (`jimeng`) — polls and saves in one call
2. Or full chain in one agent without subagents

---

## Tech stack (all modes)

**火山方舟 Agent Plan 同款链路**（[实践指南：短视频网站](https://www.volcengine.com/docs/82379/2391246?lang=zh)）— read this skill, then call scripts via **`terminal`** (stdout = JSON):

Script dir: `skills/public/media-production/scripts/` (from workspace root)

| Capability | Script | Provider | 模型 |
|------------|--------|----------|------|
| Image | `image_generate.py` | `jimeng` | Seedream |
| Video submit | `video_generate.py` | `jimeng` | Seedance |
| Video poll + download | `task_wait.py` | `jimeng` | Seedance |
| Subtitles | `subtitle_build.py` + `subtitle_burn.py` | local ffmpeg | — |

**Example (media-artist)**:

```bash
python skills/public/media-production/scripts/image_generate.py \
  --prompt "暗色房间，人物背影对发光显示器；16:9 中景；克制科技风" \
  --aspect-ratio 16:9 \
  --output-dir outputs
```

**Example (media-video-director)** — parse `task_id` from video_generate JSON, then:

```bash
python skills/public/media-production/scripts/video_generate.py \
  --prompt "镜头缓慢推近屏幕。口播：「智能，如流而动。」" \
  --first-frame-url "<url from image_generate JSON>" \
  --duration 5 --output-dir outputs

python skills/public/media-production/scripts/task_wait.py \
  --task-id "<task_id>" --provider jimeng --media-kind video \
  --max-wait-seconds 600 --output-dir outputs
```

**凭据**：**Ark API Key** 在 **设置 → 环境变量** 配置 `VOLCENGINE_API_KEY` / `ARK_API_KEY`。**`provider=jimeng` = 火山方舟**（Seedream/Seedance），不是 wan/kling。

**失败时勿自动换厂商**：jimeng 失败（如 Seedream 未在 Ark 控制台开通）→ 提示用户在火山方舟控制台开通对应模型或调整接入点 `ep-...`。**只有用户明确要求**时才用 `wan`/`kling`。

Optional（用户点名才用）: `wan`/`dashscope`、`kling`、独立 TTS。

---

## Artifact contract (do not rename casually)

| File | Owner step |
|------|------------|
| `outputs/production-brief.md` | screenwriter |
| `outputs/shot-prompts.json` | visual-planner |
| `outputs/*.mp4` | video-director（含 Seedance 原生音轨） |
| `outputs/subtitles.srt` | post |
| `outputs/*-subtitled.mp4` | post (final) |

---

## Solo pipeline reference (subagents use these internally)

### Brief content (screenwriter)

- **User intent**（锚点）、logline、visual style（含 continuity 要素）、aspect ratio、shot list（含镜间衔接）、narration script（按镜分段、声画一致）

### Visual / video quality

- Image prompt: **120–200 字 / 单静帧** — 主体+环境+光线+构图；仅 brief 内元素；**禁止**一图写完推镜/粒子/Logo 动画
- Video prompt: **1–2 句动势** + **本镜口播全文**；与首帧、User intent 一致；运镜克制；**禁止** 10s 内多场景/Logo 揭示/4K 堆砌
- 多镜时 continuity_note 必填；**每镜** 各 1 次 `image_generate.py` + `video_generate.py` + `task_wait.py`

- **Always** **image2video** with `--first-frame-url` from prior `image_generate.py` JSON (`url` field preferred)
- **Default duration=5**；`text2video` 仅无首帧空镜时使用
- Always **`task_wait.py`** after video submit (`--max-wait-seconds 600`)
- **禁止** ffmpeg/terminal/TTS 绕开 Seedance（除非用户明确要求独立配音）
- 同参工具失败 **最多重试 1 次**

### Subs (post)

```bash
python skills/public/media-production/scripts/subtitle_build.py \
  --text "<narration from brief>" --audio-path outputs/<video>.mp4 --output-dir outputs

python skills/public/media-production/scripts/subtitle_burn.py \
  --video-path outputs/<video>.mp4 --subtitle-path outputs/subtitles.srt --output-dir outputs
```

---

## Script reference

| Script | Who runs it (via terminal) |
|--------|----------------------------|
| `image_generate.py` | media-artist |
| `video_generate.py` + `task_wait.py` | media-video-director |
| `subtitle_build.py` / `subtitle_burn.py` | media-post |
| `subagent` | **Producer only** |

---

## Prompt templates (copy to shot-prompts / tool calls)

**Image (one still, zh or en)**:

```
【主体】暗色房间，人物背影对发光显示器
【环境/光线】仅屏幕蓝紫光照亮轮廓
【构图】16:9 中景
【风格】克制科技商业片
```

**Video (image2video, 5s, jimeng)**:

```
镜头缓慢推近屏幕；输入框发出蓝紫粒子向外扩散。
口播：「智能，如流而动。EvoFlow，一句话唤醒你的 AI 创作团队。」
```

---

## Common mistakes

- 画面/口播与用户主题无关，或镜与镜、段与段毫无衔接
- **jimeng（火山）失败后自动去试 wan/kling** — 应提示开通 Ark 模型，勿擅自换厂商
- 主会话**连打多张相似生图**或 **text2video 整条广告** — 应走 brief → 单镜 image2video
- **ffmpeg / bat / media_voiceover_synthesize** 代替 Seedance 原生配音
- 为炫技加夸张特效、乱入元素，偏离 User intent
- 视频 prompt 只写画面、不写口播 → 成片无对白
- 口播改写跑题，与 production-brief 不一致
- 默认流水线仍委派 `media-voice-director`（Seedance 已带声，不必 TTS）
- Producer running media scripts on main thread for full narrated videos
- Skipping `task_wait.py` after video submit

---

## API keys

**用户**：**设置 → 环境变量** 配置 `VOLCENGINE_API_KEY` / `ARK_API_KEY`。关闭原生配音：`SEEDANCE_GENERATE_AUDIO=0` 或工具参数 `generate_audio=false`。

---

## Storage (files + SQLite index)

| What | Where |
|------|--------|
| MP4 / PNG / SRT | Session **`outputs/`** |
| task_id, remote URL, local path | SQLite **`evoflow_media_assets`** |
| API keys | SQLite **`evoflow_app_settings`** |

Query: `GET /api/media/assets?thread_id=<id>&limit=50`.

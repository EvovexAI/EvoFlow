---
name: wan-media-generation
description: |
  通义万相 / DashScope（wan）生图/改图/生视频。用户指定万相、wan、DashScope、通义，或已配 DASHSCOPE_API_KEY 时使用。
  ⏰ 触发：「用万相生图/生视频」「DashScope wan 画图」等。
  对话内快速单张/单段优先 platform → media.*（model=wan2.7-*）；多步流水线再用本技能 scripts。
  火山生图请用 byted-ark-seedream-skill；火山短片请用 media-production。
---

# 通义万相 / DashScope（wan）媒体生成

Harness provider 名 **`wan`**。运行时与平台 `media.*` **共用** `providers/factory` + `dashscope_wan`（按模型号选协议）。

## 优先路径（对话内）

单张图 / 单段视频 → **`platform`**：

1. `media.catalog`（看模型与凭据）
2. `media.generate_image` / `media.generate_video`（`confirm=true`，`model=wan2.7-image` 或 `wan2.7-i2v`）
3. 视频再 `media.task_wait`

本技能 `wan_api.py`：用户明确要求终端脚本、批量、或要 `--last-frame-url` / `--audio-url` 等细参时再用。

## 模型与协议（默认 2.7）

| 模型 | 能力 | 协议 |
|------|------|------|
| `wan2.7-image` / `wan2.7-image-pro` | 文生图 / 图生图 | multimodal-generation **同步** |
| `wan2.7-i2v` | 图生视频（首帧/首尾帧 + 可选 driving_audio） | video-synthesis **异步** `input.media[]` |
| `wan2.7-t2v` | 文生视频 | 同上异步 |
| `wan2.6-t2i` / `wan2.6-i2v` / `wan2.6-t2v` | 兼容旧配额 | legacy text2image / `img_url` |

未传 `--model` 时脚本与平台一致：图默认 `wan2.7-image`，视频默认 `wan2.7-i2v` / `wan2.7-t2v`。

## 官方文档

| 能力 | 文档 |
|------|------|
| 万相 2.7 图像 | [图像生成与编辑](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference) |
| 万相 2.7 图生视频 | [图生视频 API](https://help.aliyun.com/zh/model-studio/wan-i2v-api-reference) |
| 万相视频总览 | [视频生成 API](https://help.aliyun.com/zh/model-studio/wan-video-generation-api-reference) |
| 万相 2.1/2.6 文生图（legacy） | [文生图 V2](https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference) |

API 基址默认：`https://dashscope.aliyuncs.com/api/v1`  
认证：`Authorization: Bearer <DASHSCOPE_API_KEY>`

## 凭据

**设置 → 模型 → 生图生视频 → 通义万相**，或环境变量 `DASHSCOPE_API_KEY`。

申请：[阿里云百炼 / Model Studio](https://bailian.console.aliyun.com/)

## 脚本

`skills/public/wan-media-generation/scripts/wan_api.py`（stdout = JSON）

### 文生图（默认 2.7）

```bash
python skills/public/wan-media-generation/scripts/wan_api.py image \
  --prompt "一间有着精致窗户的花店，漂亮的木质门，摆放着花朵，电影级光照" \
  --aspect-ratio 16:9 \
  --model wan2.7-image \
  --output-dir outputs
```

### 图生图

```bash
python skills/public/wan-media-generation/scripts/wan_api.py image \
  --mode image2image \
  --prompt "保持构图，改为雨夜赛博朋克风格" \
  --reference-image-urls "https://example.com/ref.png" \
  --model wan2.7-image \
  --output-dir outputs
```

### 图生视频（首帧；可加尾帧 / 驱动音频）

```bash
python skills/public/wan-media-generation/scripts/wan_api.py image \
  --prompt "…" --aspect-ratio 16:9 --output-dir outputs

python skills/public/wan-media-generation/scripts/wan_api.py video \
  --prompt "微推镜头，自然光影" \
  --first-frame-url "<上一步 url>" \
  --last-frame-url "<可选尾帧>" \
  --audio-url "<可选 mp3>" \
  --model wan2.7-i2v \
  --duration 5 --resolution 720p --output-dir outputs

python skills/public/wan-media-generation/scripts/wan_api.py task-get \
  --task-id "<task_id>" --media-kind video \
  --max-wait-seconds 600 --output-dir outputs
```

### 文生视频

```bash
python skills/public/wan-media-generation/scripts/wan_api.py video \
  --mode text2video \
  --prompt "一只猫在海滩上看日落，电影感" \
  --model wan2.7-t2v \
  --poll --output-dir outputs
```

### 兼容旧协议

```bash
python skills/public/wan-media-generation/scripts/wan_api.py image \
  --prompt "…" --model wan2.6-t2i --output-dir outputs
```

## 交付

解析 stdout 的 `absolute_path` / `local_path`；回复用 Markdown：`[文件名](相对工作目录的路径)` 或短路径反引号（png/mp4）。平台工具结果卡已有预览时勿再贴 `![]()`。

## 常见错误

- 图生图未传 `--reference-image-urls`
- 视频未 `task-get` / `--poll` 就当作失败
- Key 未在 EvoFlow **启用**
- 失败 **勿自动换** 其它厂商（须用户同意）

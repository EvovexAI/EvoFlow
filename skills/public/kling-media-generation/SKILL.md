---
name: kling-media-generation
description: |
  可灵 / Kling 生图/改图/生视频。用户指定可灵、Kling、klingai.com，或已配 KLING_ACCESS_KEY_ID + Secret 时使用。
  ⏰ 触发：「用可灵生图/生视频」「Kling 画图」等。
  火山生图请用 byted-ark-seedream-skill；火山短片请用 media-production。
---

# 可灵 / Kling 媒体生成

API 基址（默认）：`https://api.klingai.com`  
认证：`Authorization: Bearer <JWT>`（由 Access Key ID + Secret 签发；或直接 Bearer 单 Key）

## 官方文档

| 能力 | 文档 |
|------|------|
| 图像生成 | [Kling 开放平台](https://app.klingai.com/cn/dev/document-api/apiReference/model/imageGeneration) |
| 视频生成 | [Kling 视频 API](https://app.klingai.com/cn/dev/document-api/apiReference/model/videoGeneration) |

默认模型：生图 `kling-v2-1`；生视频 `kling-v2-6`

## 凭据

**设置 → 环境变量**：`KLING_ACCESS_KEY_ID` + `KLING_ACCESS_KEY_SECRET`，或 `KLING_API_KEY`。或在 **创意媒体 → 可灵** 填写。

申请：[可灵 AI 开放平台](https://app.klingai.com/cn/dev)

## 脚本

`skills/public/kling-media-generation/scripts/kling_api.py`（stdout = JSON）

### 文生图

```bash
python skills/public/kling-media-generation/scripts/kling_api.py image \
  --prompt "A luminous floating city above misty canyon at sunrise, cinematic" \
  --aspect-ratio 16:9 \
  --output-dir outputs
```

### 图生图 / 改图（须参考图 URL）

```bash
python skills/public/kling-media-generation/scripts/kling_api.py image \
  --mode image2image \
  --prompt "Turn into rainy cyberpunk night, preserve composition" \
  --reference-image-urls "https://example.com/input.png" \
  --output-dir outputs
```

### 图生视频（推荐流程）

```bash
python skills/public/kling-media-generation/scripts/kling_api.py image \
  --prompt "…" --aspect-ratio 16:9 --output-dir outputs

python skills/public/kling-media-generation/scripts/kling_api.py video \
  --prompt "Subtle camera push-in, natural lighting" \
  --first-frame-url "<上一步 url>" \
  --duration 5 --output-dir outputs

python skills/public/kling-media-generation/scripts/kling_api.py task-get \
  --task-id "<task_id>" --media-kind video \
  --max-wait-seconds 600 --output-dir outputs
```

### 文生视频（一步轮询）

```bash
python skills/public/kling-media-generation/scripts/kling_api.py video \
  --mode text2video \
  --prompt "A cinematic shot of a cat on the beach at sunset" \
  --poll --output-dir outputs
```

## 交付

解析 stdout 的 `absolute_path` / `local_path`；回复用户：`@@outputs/文件名@@`（png/mp4）。

## 常见错误

- 只填了 Key ID 未填 Secret（且未用 `KLING_API_KEY`）
- 图生图未传 `--reference-image-urls`
- 视频未 `task-get` / `--poll` 就报失败
- 失败 **勿自动换** 其它厂商（须用户同意）

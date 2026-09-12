---
name: agnes-media-generation
description: |
  Agnes AI 生图/改图/生视频。用户指定 Agnes、agnes-ai.com 时使用。
  ⏰ 触发：「用 Agnes 生图/生视频」「agnes-ai 画图」等。
  凭据 vendor id：`agnes`（EvoFlow 设置 → 创意媒体）。
---

# Agnes AI 媒体生成

用户指定 **Agnes / agnes-ai.com** 时使用。凭据 vendor id：**`agnes`**。

## 官方文档

| 能力 | 文档 |
|------|------|
| 总览 | [Agnes AI API Overview](https://agnes-ai.com/doc/overview) |
| 生图 / 图生图 | [Agnes Image 2.1 Flash](https://agnes-ai.com/doc/agnes-image-21-flash) — **图生图必须传 `image`** |
| 生视频 | [Agnes Video v2.0](https://agnes-ai.com/doc/agnes-video-v20) |

API 基址：`https://apihub.agnes-ai.com`  
认证：`Authorization: Bearer <key>`

## 凭据

**设置 → 环境变量**：添加 `AGNES_API_KEY=…`（保存后立即注入 terminal/脚本）。也可在 **设置 → 模型 → 创意媒体 → Agnes** 填写（会自动写入该环境变量）。

申请：[Agnes 平台](https://platform.agnes-ai.com)

## 脚本

`skills/public/agnes-media-generation/scripts/agnes_api.py`（stdout = JSON）

### 文生图

```bash
python skills/public/agnes-media-generation/scripts/agnes_api.py image \
  --prompt "A luminous floating city above misty canyon at sunrise, cinematic" \
  --size 1024x768 \
  --output-dir outputs
```

### 图生图 / 改图（须参考图 URL）

```bash
python skills/public/agnes-media-generation/scripts/agnes_api.py image \
  --prompt "Turn into rainy cyberpunk night, preserve composition" \
  --image "https://example.com/input.png" \
  --size 1024x768 \
  --output-dir outputs
```

### 文生视频（异步 + 轮询）

```bash
python skills/public/agnes-media-generation/scripts/agnes_api.py video \
  --prompt "A cinematic shot of a cat on the beach at sunset, soft waves" \
  --poll --output-dir outputs
```

### 图生视频

```bash
python skills/public/agnes-media-generation/scripts/agnes_api.py video \
  --prompt "Subtle camera push-in, natural lighting" \
  --image "https://example.com/frame.png" \
  --poll --output-dir outputs
```

### 查询任务

```bash
python skills/public/agnes-media-generation/scripts/agnes_api.py video-get TASK_ID
```

## 交付

解析 stdout 的 `absolute_path` / `local_paths`；回复用户：`@@outputs/文件名@@`（png/mp4）。

## 常见错误

- 图生图未传 `--image`
- 未 `--poll` 就当作失败
- 与火山 **混用**凭据或模型名
- 失败 **勿自动换** 其它厂商（须用户同意）

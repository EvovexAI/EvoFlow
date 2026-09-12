---
name: wan-media-generation
description: |
  通义万相 / DashScope（wan）生图/改图/生视频。用户指定万相、wan、DashScope、通义，或已配 DASHSCOPE_API_KEY 时使用。
  ⏰ 触发：「用万相生图/生视频」「DashScope wan 画图」等。
  火山生图请用 byted-ark-seedream-skill；火山短片请用 media-production。
---

# 通义万相 / DashScope（wan）媒体生成

Harness 内部 provider 名为 **`wan`**；脚本为 `wan_api.py`。

## 官方文档

| 能力 | 文档 |
|------|------|
| 万相 2.1 文生图 | [文生图 V2 API](https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference) |
| 万相 2.7 图像编辑 | [图像生成与编辑 2.7](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference) |
| 万相视频 | [视频生成 API](https://help.aliyun.com/zh/model-studio/wan-video-generation-api-reference) |

API 基址（默认）：`https://dashscope.aliyuncs.com/api/v1`  
认证：`Authorization: Bearer <DASHSCOPE_API_KEY>`

## 凭据

**设置 → 环境变量**：`DASHSCOPE_API_KEY=…`。或在 **创意媒体 → 通义万相** 填写。

申请：[阿里云百炼 / Model Studio](https://bailian.console.aliyun.com/)

## 脚本

`skills/public/wan-media-generation/scripts/wan_api.py`（stdout = JSON）

### 文生图

```bash
python skills/public/wan-media-generation/scripts/wan_api.py image \
  --prompt "一间有着精致窗户的花店，漂亮的木质门，摆放着花朵，电影级光照" \
  --aspect-ratio 16:9 \
  --output-dir outputs
```

### 图生图 / 改图（须参考图 URL）

```bash
python skills/public/wan-media-generation/scripts/wan_api.py image \
  --mode image2image \
  --prompt "保持构图，改为雨夜赛博朋克风格" \
  --reference-image-urls "https://example.com/ref.png" \
  --output-dir outputs
```

### 图生视频（推荐流程）

```bash
python skills/public/wan-media-generation/scripts/wan_api.py image \
  --prompt "…" --aspect-ratio 16:9 --output-dir outputs

python skills/public/wan-media-generation/scripts/wan_api.py video \
  --prompt "微推镜头，自然光影" \
  --first-frame-url "<上一步 url>" \
  --duration 5 --output-dir outputs

python skills/public/wan-media-generation/scripts/wan_api.py task-get \
  --task-id "<task_id>" --media-kind video \
  --max-wait-seconds 600 --output-dir outputs
```

### 文生视频（一步轮询）

```bash
python skills/public/wan-media-generation/scripts/wan_api.py video \
  --mode text2video \
  --prompt "一只猫在海滩上看日落，电影感" \
  --poll --output-dir outputs
```

## 交付

解析 stdout 的 `absolute_path` / `local_path`；回复用户：`@@outputs/文件名@@`（png/mp4）。

## 常见错误

- 图生图未传 `--reference-image-urls`
- 视频未 `task-get` / `--poll` 就当作失败
- Key 未在 EvoFlow **启用**
- 失败 **勿自动换** 其它厂商（须用户同意）

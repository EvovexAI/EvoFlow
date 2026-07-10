# Guide tutorial screenshots

Hands-on guide images sync to `website/apps/web/public/assets/guides/` via `pnpm sync:media`.

## 快速开始 · 模型配置

目录：`getting-started/`

| 文件 | 教程 |
|------|------|
| `01-models-nav.png` … `06-first-chat.png` | [models-and-chat](../../presentations/guides/getting-started/models-and-chat/index.html) |

## 创作实操 · 短视频

目录：`creation/short-video/`

| 文件 | 教程 |
|------|------|
| `01-prereq-env.png` … `07-deliverable.png` | [short-video](../../presentations/guides/creation/short-video/index.html) |

网页引用：`/assets/guides/<subdir>/<filename>.png`

放入 PNG 后执行：

```bash
cd website && pnpm sync:media
```

页面会在图片存在时自动显示；缺失时显示虚线占位与文件名提示。

# 液态玻璃背景素材来源

本地演示用壁纸与视频，优先使用**国内可快速访问**的官方/公开 CDN。

## 壁纸（必应中国每日壁纸）

来源：[必应中国](https://cn.bing.com/) `HPImageArchive` API（微软官方，仅供个人/非商用壁纸用途）。

| 文件 | 内容 |
|------|------|
| `bg-aurora.jpg` | 中国古村田野 |
| `bg-tahoe-light.jpg` | 阿尔卑斯山路 |
| `bg-tahoe-dark.jpg` | 古堡废墟 |
| `bg-buildings.jpg` | 星形要塞 |
| `bg-text.jpg` | 海岸悬崖 |
| `bg-ocean.jpg` | orca 海洋 |
| `bg-aquarium.jpg` | 小丑鱼水下 |
| `bg-pet-butterfly.jpg` | 蝴蝶（宠物/自然） |

## 视频（国内 CDN 公开测试/新闻片）

| 文件 | 来源 | 说明 |
|------|------|------|
| `bg-video-scenery.mp4` | 齐鲁网 `stream7.iqilu.com` | 风景新闻片，~7 MB |
| `bg-video-demo.mp4` | 火山引擎 `huoshanstatic.com` | 西瓜播放器官方 demo，360p |
| `bg-video-fish.mp4` | 火山引擎 `huoshanstatic.com` | 西瓜播放器官方 demo，720p |
| `bg-video-city.mp4` | 百度智能云 `cyberplayer.bcelive.com` | 播放器官方 demo，~15 MB |

> `*.mp4` 已在 `.gitignore` 中排除，仅保留在本地做演示；换机器需重新下载或自行放置同目录。

## 重新下载

在项目根目录执行（需 PowerShell + curl）：

```powershell
$dir = "evopanel/public/assets/liquid-glass"
# 必应壁纸 API + 国内 CDN 视频，参见仓库内下载脚本或联系维护者。
```

## 自定义

在设置页或 Agent `appearance.patch` 中指定 `backgroundImage` 为本地绝对路径或 `http(s)` URL 即可覆盖预设壁纸。

# 创作画布选型：采用 Infinite-Canvas

## 决策

**采用** [amiibot/Infinite-Canvas](https://github.com/amiibot/Infinite-Canvas) 作为无线创作画布的产品与实现参考（本机参考仓：`D:\dev\github\_refs\ai-canvas\Infinite-Canvas`）。

火宝 / open-ai-canvas 仅作对照，不再作为主线。短剧工作流对照仓见 [`short-drama-oss-refs.md`](./short-drama-oss-refs.md)（**不整仓 fork**）。

## 为什么选它

- 有完整「导演工坊」：脚本 → 风格 → 资产 → 分镜 → **出片（Step5）**
- 无限画布内建 **Seedance 2.0** 卡片（单图 / 首尾帧 / 多图参考）
- 与我们目标一致：拆解/复刻 → 分镜 → 图生有声视频；原创短剧走分镜工坊

## 接入原则（勿整仓吞并）

| 层 | 做法 |
|----|------|
| UI / 交互 | 参考或 fork 其 `static/canvas.html`、导演工坊页 |
| 生成后端 | **不**直连其第三方通道；统一走 EvoFlow **Agent Plan**（`/api/plan/v3` Seedream/Seedance） |
| 产品入口 | EvoFlow UI 扩展或独立套件「创作画布」；可与爆款洞察联动导入关键帧/口播 |
| 素材 | 成片回写 ContentOS **素材中心** |
| 短剧 OSS | LocalMiniDrama / Toonflow 等只作字段与 UX 对照，见 `short-drama-oss-refs.md` |

## 短剧导演台（分镜工坊）

| 步骤 | 能力 |
|------|------|
| 1.脚本 | 粘贴解析；**从创意生成剧本**（角色→大纲→分场）`POST .../generate_script` |
| 2–4 | 风格 / 资产（含三视图、音色）/ 静态分镜 |
| 5.出片 | 三栏时间线：资产 / 镜列表 / 预览；单镜·批量·续上一镜 Seedance；场景时空标签；**下载本镜 / 成片 ZIP** |
| 导出 | `POST .../export_canvas` → 无限画布；`GET .../export_clips_zip` → 本地成片包 |

实现文件：`static/project.html`、`main.py`（`/api/comic/projects/{pid}/frames/{fid}/render_video` 等）。  
Agent 调用：本机 `D:\dev\github\_refs\ai-canvas\Infinite-Canvas\mcp\director_mcp.py`（stdio MCP，见同目录 README）。

## 后续开发清单（相对 Infinite-Canvas）

1. ~~明确外部扩展接入~~（`ai-canvas`，侧栏「创作画布」）
2. ~~替换视频/图片 API → Agent Plan `/api/plan/v3`~~（协议 `agent_plan`，默认平台「豆包 Agent Plan」）
3. ~~从 ContentOS 拆解结果「一键铺画布」~~
4. ~~分镜工坊 Step5 出片 + Step1 生剧本~~（对标小云雀导演台）
5. 多镜拼接 + 字幕烧录（接 media-post）
6. 成片回写素材中心

## 本地体验 / 扩展

产品派生仓：https://github.com/evolvear/CanvasOS（无上游 Git 历史）  
本机路径：`D:\dev\github\_refs\ai-canvas\Infinite-Canvas`  

EvoFlow 扩展包：[`extensions/ai-canvas`](../../../extensions/ai-canvas/)（id=`ai-canvas`，侧栏「创作画布」，端口 **3000**）。

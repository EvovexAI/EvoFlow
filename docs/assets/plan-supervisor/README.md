# Plan 模式 · Supervisor / Agent Teams 演示素材

供根目录 [README.md](https://github.com/EvovexAI/EvoFlow/blob/main/README.md) **「Plan 模式 · Agent Teams 从 0 到 1」** 章节引用。

## 视频（2 条）

| 文件名 | 用途 | 建议 |
|--------|------|------|
| `video-01-plan-clarify-to-ready.mp4` | **视频一**：Plan 协作过程（澄清 → 规划 → Agent Teams 执行） | 3–6 分钟；1920×1080 或 1600×900；MP4（H.264）；&lt; 40MB |
| `video-01-plan-clarify-to-ready-poster.png` | 视频一封面（README 内展示） | 与视频同比例；可带「▶」示意 |
| `video-02-plan-project-running-result.mp4` | **视频二**：项目运行结果展示 | 1–3 分钟；同上；聚焦可运行产物演示 |
| `video-02-plan-project-running-result-poster.png` | 视频二封面 | 建议用运行界面关键帧（浏览器 / 终端 / 客户端） |

### 视频一建议录制内容

1. 用户用自然语言描述一个 **从 0 到 1 的小项目**（如「做一个带 API 的待办 Web 应用」）
2. Supervisor 触发 **意图澄清**（侧栏问卷 / `ask_clarification`）
3. 用户提交选项后，**Plan 工具** 产出结构化计划：`Goal`、带依赖的 `Steps`、**Mermaid 任务分析图**
4. 用户 **开始执行** 后，**Supervisor** 调度 **Agent Teams** 分工完成各 Step（可穿插子任务工作流面板）
5. 主会话汇总执行进度，各子任务完成并产出代码 / 配置 / 文档等交付物

### 视频二建议录制内容（运行结果展示）

> 视频二 **不重复** 录 Agent 协作过程，专门展示视频一中项目的 **跑通结果**。

1. 启动项目（如 `npm run dev`、打开 Docker、运行脚本等，按实际技术栈）
2. **浏览器 / 客户端** 演示核心用户路径（创建、查询、提交、页面跳转等）
3. 如有 API，可简短展示 **接口请求与响应**（Postman、curl 或内置调试页均可）
4. 对照 Plan 中的 **验收标准** 点 1–2 项，说明「计划项已落地」
5. 可选：快速扫一眼 `outputs/` 或仓库目录中的关键交付文件

## 截图（5 张）

| 文件名 | 用途 | 建议 |
|--------|------|------|
| `plan-02-structured-plan-modal.png` | 计划 · **任务分析图** | 「任务计划」弹层中的 **Mermaid 任务分析图**（项目结构、模块依赖、接口/数据流等） |
| `plan-02-structured-plan-modal-2.png` | 计划 · **执行步骤与智能体任务** | 同弹层 **执行步骤** 列表 + 选中步骤详情：执行人、目标、输入物、输出物、验收标准、工具 |
| `plan-04-exec-confirm-dock.png` | 执行确认 · Plan 定稿闸口 | 「开始执行」确认条 + 计划摘要 |
| `plan-05-supervisor-workflow-panel.png` | Supervisor · 子任务工作流侧栏 | 子任务列表、依赖、状态标签 |
| `video-02-plan-project-running-result-poster.png` | ⑥ 多 Agent 协作（README / 官网展示用） | 复用视频二封面；展示子任务执行中或项目跑通界面 |

## 注意事项

- 格式：截图 PNG 或 WebP；视频 MP4。单张截图尽量 &lt; 500KB。
- 内容：**脱敏** 路径、密钥、私人聊天与真实客户信息。
- 主题：与 [screenshots/](../screenshots/) 其它 GUI 图保持一致（明/暗其一即可）。
- 素材未就绪时 README 会显示裂链；按上表文件名放入本目录后提交即可生效。
- 官网展示：在 `website/` 执行 `pnpm sync:media` 后访问 **/showcase/**（构建时会自动同步到 `website/apps/web/public/media/`）。

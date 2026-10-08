# H3-C 进展 — ZCode v4 shell 整体 vendor 落地（2026-10-08）

> 承接 `protocol-evolution-spec.md` 的 H1/H2/H3-A/B 之后，本阶段把 **ZCode 前端整体
> vendor 进 EvoFlow**，主对话界面（`/#/chat`）已可切换到 ZCode v4 shell（SessionPane
> 全链路）并跑通端到端对话。

## 状态：端到端已打通 ✅

`localStorage.evoflowV4Shell === "1"` 时，ChatApp 主聊天列渲染 vendored ZCode
`V4ChatPane`（= V4ConversationProvider → SessionPane → ConversationTimeline +
ConversationComposer）。发送消息 → 后端 createSession/sendText → echo（或
`EVOFLOW_V4_LLM=1` 时 OpenAI 兼容流）→ wire v3 SSE → 客户端 assembler →
projection store → 时间线渲染。已验证：会话创建、快照、流式 delta、rowsRange
分页、resync 恢复、发送按钮门禁全链路。

## 本次落地内容

### 1. 整体 vendor（`scripts/vendor-zcode.cjs`）

| ZCode 包 | 落位 | 规模 |
|---|---|---|
| `packages/ui/src` | `evopanel/src/zcode-ui/` | 1550 文件 |
| `packages/shared/src` | `evopanel/src/zcode-shared/` | 226 文件 |
| `packages/rpc/src` | `evopanel/src/zcode-rpc/` | 16 文件 |
| `packages/provider/src` | `evopanel/src/zcode-provider/` | 23 文件 |
| `packages/provider-node/src` | `evopanel/src/zcode-provider-node/` | 17 文件 |
| `packages/services/src` | `evopanel/src/zcode-services/` | 326 文件 |
| `packages/model-option-map/src` | `evopanel/src/zcode-model-option-map/` | 8 文件 |
| `packages/zcode-cua`（预编译占位包） | `vendor/zcode-cua`（pnpm `file:` 依赖） | 26 文件 |

- 来源 revision 记录在 `scripts/zcode-vendor-manifest.json`（ZCode `29628c9a`）。
- 重跑 `node scripts/vendor-zcode.cjs` 会**整树刷新**——对 vendored 文件的手工修补
  （目前 5 处，均带 `[evoflow-vendor]` 注释）会被覆盖，需重放。
- 别名：`@/*` → `src/zcode-ui/*`（EvoFlow 自有代码不使用 `@/`，无冲突）；
  `@zcode/{shared,rpc,provider,provider-node,services,model-option-map}` → 各 vendored
  树；`#src/*`（services 包内 subpath imports）→ `src/zcode-services/*`。三处保持
  一致：`tsconfig.json` paths、`vite.config.js` alias、`vitest.config.js` alias。

### 2. 依赖

- zod 升级 **4.6.5**（EvoFlow 自有代码零 zod 用量，无破坏）。
- 其余 47 个包按 **ZCode lockfile 精确版本** pin（streamdown/shiki/ai/react-pdf/
  zustand@4/nanoid@3/…）；`mermaid` 经 `pnpm-workspace.yaml` override 统一 11.15.0
  （11.17 引入的 fastdom UMD 在 vite dev ESM 互操作下崩溃）。
- 新增：`shadcn`（radix-mira tailwind 变体）、`@tailwindcss/typography`、`border-beam`、
  `@types/qrcode`、services 运行依赖（yaml/croner/smol-toml/node-pty/undici/yazl/…）。

### 3. 后端 v4 conversation（`backend/app/gateway/v4/conversation.py` + `routes.py`）

ZCode v4 wire 协议的服务端实现（进程内内存态）：

- `POST /api/v4/conversation/{hello,initialize,subscribe,unsubscribe,resync,command,rows_range}` +
  `GET /api/v4/conversation/frames`（SSE，`event: v4.wire`）。
- wire 帧按 vendored zod schema 构造：`deliveryKind` 必须 `initial`/`online`/`recovery`
  （assembler 缺失即 `proto.frameAssemblyMetadataMismatch` fault）；快照/行模板由
  `tests/v4-wire-conformance.test.ts`（zod 报错驱动生成）守护。
- 重订阅替换按 `(connectionId, topic)` 判定——草稿预热 → pane 接管的二次订阅会替换
  旧订阅，否则旧帧流触发客户端 fail-close 重连横幅。
- 命令面：`createSession` / `sendText`（echo 或 OpenAI 兼容 LLM 流，env
  `EVOFLOW_V4_LLM` / `EVOFLOW_LLM_BASE_URL` / `EVOFLOW_LLM_API_KEY` / `EVOFLOW_LLM_MODEL`）；
  其余命令显式 `rejected/unsupportedCommand`。

### 4. 前端服务壳（`evopanel/src/react/v4shell/`）

- `evoflowV4Connection.ts` — 页面级 connectionId + 单条 frames SSE（EventSource）。
- `evoflowAgentService.ts` — `IZCodeAgentService` 会话面（subscribe/resync/rowsRange/
  command/hello/帧流）；未接入方法走 Proxy：`on*` 事件面返回空订阅、命令类 rejected。
  ⚠ 所有桩**必须按名缓存稳定实例**——ZCode hook 把 service 引用放进 effect 依赖，
  身份漂移会造成「effect 重跑 → 拒绝 → setState → 死循环」（bring-up 实测踩过）。
- `evoflowServices.ts` — `IServiceAccessor` 组装 + 最小 `modelSelectionService`
  （composer 发送门禁需要 `effectiveSelection`/`preferredSelection`/provider
  `api.type`/model `optionSpecs.reasoningLevel.values`）。
- `evoflowPlatform.ts` — `IPlatformService` 最小实现。
- `V4ShellRoot.tsx` — Provider 栈镜像 ZCode `Root.tsx`：LucideProvider →
  TooltipProvider → ServiceProvider → PlatformProvider → StoreProvider →
  TabStoreProvider → DiffsWorkerPoolProvider → CodingPlanUpgradeDialogProvider →
  ZCodeIntlProvider → V4ChatPane。缺一层都会在渲染期抛错（逐个实测过）。
- `ChatApp.tsx` — `v4ShellEnabled`（localStorage `evoflowV4Shell`）时 messages-body
  渲染 `V4ShellRoot`、旧 ChatComposer 隐藏；旧渲染路径完整保留可回切。

### 5. 样式

- `V4ShellRoot` import `@zcode/ui/styles.css`（tailwind v4 `source(".")` 扫描
  zcode-ui 树 + shadcn/tw-animate 变体 + xterm/katex css）。
- 主题：useTheme 自包含（localStorage + matchMedia），dark class 未初始化时为浅色。

## 已知边界（H3-C+ 待办）

1. **主对话流未接**：v4 会话目前跑在 conversation hub 的 echo/LLM 回合上；
   LangGraph 主业务流 → v4 投影（spec 的 H3-B-3 双 emit）未实施。
2. 会话列表 / 历史会话恢复：v4 pane 目前固定 draft 起步（ChatApp 未把选中会话映射为
   v4 sessionId）；sessions-index 通道未接。
3. 服务面缺口：附件、plans、workflow runs、slash 命令、CUA、设置同步等仍为
   rejected 桩；UI 触碰时 console 有可诊断的 `[v4shell] ... 尚未接入` 错误。
4. 深色主题、多 pane 分屏、上传/粘贴附件未验证。
5. 旧层已删：`src/react/v4{,_demo,_verbatim}/`、`src/react/protocol/`（git 历史可查）。

## 验证命令

```bash
# 后端（另一个终端）
cd backend && .venv/Scripts/python -m uvicorn app.gateway.app:app --port 8791
# 前端
cd evopanel && EVOFLOW_GATEWAY_URL=http://127.0.0.1:8791 npx vite --port 1422
# 浏览器：登录 → 地址栏 #/chat → DevTools: localStorage.setItem('evoflowV4Shell','1') → 刷新
# 契约测试
cd evopanel && npx vitest run tests/v4-wire-conformance.test.ts
```

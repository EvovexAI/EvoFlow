# H3-A: v4 demo 接真实 LLM（OpenAI 兼容）

## 现状（2026-10-08）

`backend/app/gateway/v4_demo/orchestrator.py` 的 `_stream_assistant` 现在有两条路径：

```
EVOFLOW_V4_LLM=0 (默认)   → 硬编码 echo（验证协议 wire）
EVOFLOW_V4_LLM=1          → 调真实 LLM（OpenAI 兼容 SSE 流）
```

## 启用真实 LLM

```bash
export EVOFLOW_V4_DEMO=1            # 启用 v4 demo router
export EVOFLOW_V4_LLM=1             # 启用真实 LLM 路径
export EVOFLOW_LLM_BASE_URL='http://127.0.0.1:11434/v1'  # Ollama 等 OpenAI 兼容
export EVOFLOW_LLM_MODEL='qwen2.5:7b'
# export EVOFLOW_LLM_API_KEY='...'  # 本地 server 通常不需要
```

环境变量解释：

| 变量 | 含义 | 默认 |
|------|------|------|
| `EVOFLOW_V4_DEMO` | 启用 v4 demo router (FastAPI) | off |
| `EVOFLOW_V4_LLM` | 用真实 LLM 替 echo | off |
| `EVOFLOW_LLM_BASE_URL` | OpenAI 兼容 base URL | （必填，否则回 echo） |
| `EVOFLOW_LLM_MODEL` | 模型名 | `echo-model` |
| `EVOFLOW_LLM_API_KEY` | Bearer token | 空 |

## 流式协议

- 真实 LLM 走 OpenAI 兼容 SSE (`data: {json}\n\n`)，逐 chunk 拼接到 `buf`
- 每 chunk 触发一次 `emit_row_upserted` (`state=streaming`)
- 收 `[DONE]` 或 异常后写终态 `state=complete`
- 与 echo 路径同样在 v4 frame envelope 里 emit，前端 MiniSessionPane 看到 `userInput` → `reasoning` → `assistantText` 的相同 row 流

## H3-A 范围 vs 整体 H3

| H3 编号 | 内容 | 状态 |
|---------|------|------|
| **H3-A** | v4 demo 接真实 OpenAI 兼容 LLM（局部化到 v4_demo） | ✅ 本 commit |
| H3-B | 后端 SSE 路由整体迁移到 v4 projection writer（替代 agui_stream_normalizer） | ❌ 推迟 |
| H3-C | DB schema v4 row storage + 历史 thread 迁移工具 | ❌ 推迟 |
| H3-D | 业务面板（10 个）按 v4 shell 适配（BrowserPanel / MeetingView / ...） | ❌ 推迟 |
| H3-E | ChatComposer 接 v4 `EvoFlowV4Transport.sendCommand` 替代 dispatchCommand path | ❌ 推迟 |

## 不做 H3-B/C/D/E 的原因

1. **范围爆炸**：现有 LangGraph 真实流是 `event: messages/values/updates/metadata` 的多 channel，转 v4 row 涉及齐全的 tool_call / interrupt 映射
2. **DB 改动风险**：v4 row schema 不同于现有 thread_runs 表，迁移需要双写期
3. **业务面板**：每个面板差异巨大，强改将带入 5–15k 行 churn
4. **chat composer**：ChatApp.tsx 16000 行，命令派发路径牵涉 websocket / HTTP / SSE 三种 channel

## 下一步推荐

- 用 H3-A 跑真实 LLM，验证 v4 wire 承载真实 OpenAI compat 流式
- 在 H4 把 H3-B 的 SSE 路由改写单独成 sprint（明确定义：`runs/stream` → v4 projection writer 的 adapter）
- DB schema 与面板的 v4 化待 H3-B 完成后再启动（避免双写）

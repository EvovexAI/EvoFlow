# 本地唤醒词（KWS）打包说明

桌面端「小V小V」唤醒优先：WebView 采麦 → Tauri → Node `kws-sidecar`（sherpa-onnx）→ 命中后拉起手屏（`openXiaomiRightStage({ voiceMode:true })`）。

| 优先级 | 后端 | 说明 |
|--------|------|------|
| 1 | `kws-sidecar` + `wake-word-native.js` | 系统 Node + `sherpa-onnx`，score=3.0 |
| 2 | `public/kws` 浏览器 WASM | 仅当 glue 为 **web** 构建时可用（npm 的 nodejs WASM 会被探针拒绝） |
| 3 | Web Speech | 兜底 |

模型与 sidecar 资源：

| 资源 | 说明 |
|------|------|
| `public/kws/encoder/decoder/joiner-…onnx` | 模型权重 |
| `public/kws/tokens.txt` / `keywords.txt` | token 与唤醒词音素 |
| `kws-sidecar/` | Node 子进程（打包进 Tauri resources） |

```bash
cd evopanel
npm run kws:sidecar   # sherpa-onnx 依赖
npm run kws:node      # 便携 Node → kws-sidecar/runtime/（安装包不依赖系统 Node）
npm run kws:download
npm run kws:ensure
# 强制打包必须带浏览器 WASM（可选）:
# EVOFLOW_REQUIRE_KWS_WASM=1 npm run kws:ensure
```

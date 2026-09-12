# 本地唤醒词（KWS）打包说明

桌面端「小V小V」本地关键词唤醒资源位于 `public/kws/`，会随 Vite → Tauri 安装包分发。

只保留运行时文件（`scripts/download-kws-model.js` 会自动 prune）：

| 资源 | 说明 |
|------|------|
| `encoder/decoder/joiner-epoch-12-…-64.onnx` | 模型权重（非 int8） |
| `tokens.txt` / `keywords.txt` | token 与唤醒词音素 |
| `sherpa-onnx-kws.js` | JS 胶水 |
| `sherpa-onnx-wasm-kws-main.js` + `.wasm` | WASM 运行时 |

```bash
cd evopanel
npm run kws:download
npm run kws:ensure
# 强制打包必须带 WASM:
# EVOFLOW_REQUIRE_KWS_WASM=1 npm run kws:ensure
```
